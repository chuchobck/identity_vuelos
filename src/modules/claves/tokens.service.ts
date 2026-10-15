import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errors, JWTHeaderParameters, jwtVerify, SignJWT } from 'jose';
import { KeyObject, randomUUID } from 'node:crypto';
import { Reloj } from '../../common/reloj';
import { ClavesService } from './claves.service';
import { ALGORITMO_FIRMA } from './material-claves';

/** Vigencia del token de acceso. Corta a propósito: no se puede revocar antes de que venza. */
export const VIGENCIA_ACCESO_SEGUNDOS = 15 * 60;

/** `aud` cuando JWT_AUDIENCE no está definida: el valor que el core ya acepta hoy. */
export const AUDIENCIA_POR_DEFECTO = 'quinde-vuelos-api';

/** `typ` de la cabecera de un token de acceso JWT (RFC 9068, sección 2.1). */
export const TIPO_TOKEN_ACCESO = 'at+jwt';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TokenAccesoEmitido {
  token: string;
  expiraEnSegundos: number;
}

/** A quién se le emite el token. */
export interface SujetoToken {
  /** usuario.id o cliente_oauth.id. Es el `sub` y el `id_propietario` en el core. */
  sub: string;
  scopes: readonly string[];
  /** Solo en un token de cliente (client_credentials): cliente_oauth.codigo. */
  clientId?: string;
}

/** Lo que se saca de un token válido. */
export interface IdentidadToken {
  sub: string;
  scopes: string[];
  jti: string;
  /** Presente solo si el token es de un cliente OAuth. */
  clientId?: string;
}

export type MotivoTokenInvalido = 'expirado' | 'invalido';

/** El token no sirve. El guard lo convierte en 401; el motivo no lleva el token. */
export class TokenInvalidoError extends Error {
  constructor(readonly motivo: MotivoTokenInvalido) {
    super(motivo === 'expirado' ? 'The access token expired' : 'The access token is invalid');
    this.name = 'TokenInvalidoError';
  }
}

/**
 * Tokens de acceso JWT (RFC 9068) firmados con RS256 y la clave actual:
 *
 *   cabecera  { alg: RS256, typ: at+jwt, kid }
 *   claims    iss, sub, aud, exp, iat, jti, scope (separados por espacio) y, si es un
 *             cliente OAuth, client_id
 *
 * Las horas salen del Reloj: las pruebas lo mueven para probar el vencimiento.
 */
@Injectable()
export class TokensService {
  readonly emisor: string;
  readonly audiencia: string;

  constructor(
    private readonly claves: ClavesService,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.emisor = config.getOrThrow<string>('JWT_ISSUER');
    this.audiencia = config.get<string>('JWT_AUDIENCE') || AUDIENCIA_POR_DEFECTO;
  }

  async emitir(sujeto: SujetoToken): Promise<TokenAccesoEmitido> {
    const { kid, privada } = this.claves.claveDeFirma();
    const ahora = Math.floor(this.reloj.ahora().getTime() / 1000);
    const claims: Record<string, string> = { scope: sujeto.scopes.join(' ') };
    if (sujeto.clientId !== undefined) claims.client_id = sujeto.clientId;

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITMO_FIRMA, typ: TIPO_TOKEN_ACCESO, kid })
      .setIssuer(this.emisor)
      .setSubject(sujeto.sub)
      .setAudience(this.audiencia)
      .setIssuedAt(ahora)
      .setExpirationTime(ahora + VIGENCIA_ACCESO_SEGUNDOS)
      .setJti(randomUUID())
      .sign(privada);
    return { token, expiraEnSegundos: VIGENCIA_ACCESO_SEGUNDOS };
  }

  /**
   * Comprueba lo mismo que comprobará el core con el JWKS: algoritmo RS256 (ni `none` ni HS256
   * con la pública como secreto), `kid` de este servicio, firma, `typ` at+jwt, `iss`, `aud`,
   * que existan `exp`, `iat`, `jti` y `sub`, y que no haya vencido.
   */
  async verificar(token: string): Promise<IdentidadToken> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, (cabecera) => this.claveDe(cabecera), {
        algorithms: [ALGORITMO_FIRMA],
        typ: TIPO_TOKEN_ACCESO,
        issuer: this.emisor,
        audience: this.audiencia,
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
        currentDate: this.reloj.ahora(),
      }));
    } catch (error) {
      throw new TokenInvalidoError(error instanceof errors.JWTExpired ? 'expirado' : 'invalido');
    }

    const { sub, scope, jti, client_id: clientId } = payload;
    if (
      typeof sub !== 'string' ||
      !UUID.test(sub) ||
      typeof scope !== 'string' ||
      typeof jti !== 'string' ||
      (clientId !== undefined && typeof clientId !== 'string')
    ) {
      throw new TokenInvalidoError('invalido');
    }
    return {
      sub,
      scopes: scope.split(' ').filter((s) => s !== ''),
      jti,
      ...(clientId === undefined ? {} : { clientId }),
    };
  }

  /** Un token sin `kid`, o con uno que no es de este servicio, no se verifica con nada. */
  private claveDe(cabecera: JWTHeaderParameters): KeyObject {
    const clave = cabecera.kid ? this.claves.claveDeVerificacion(cabecera.kid) : undefined;
    if (!clave) throw new errors.JWKSNoMatchingKey();
    return clave;
  }
}
