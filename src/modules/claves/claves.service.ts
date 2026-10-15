import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyObject } from 'node:crypto';
import { JwkPublica, jwkPublica, leerClavePrivada, leerClavePublica } from './material-claves';

/** La clave que firma: la privada nunca sale de este objeto (ni al log ni a una respuesta). */
interface ClaveDeFirma {
  kid: string;
  privada: KeyObject;
  jwk: JwkPublica;
}

interface ClaveDeVerificacion {
  kid: string;
  publica: KeyObject;
  jwk: JwkPublica;
}

/**
 * Las claves del servicio, en dos ranuras para poder rotar sin cortar sesiones:
 *
 * - JWT_SIGNING_KEY (obligatoria): la privada actual. Firma todo token nuevo.
 * - JWT_PREVIOUS_PUBLIC_KEY (opcional): la pública del par anterior. Solo verifica: un token
 *   firmado antes de rotar sigue valiendo hasta que vence (15 minutos).
 *
 * Las dos se publican en /.well-known/jwks.json. Se cargan una vez, al arrancar; el entorno
 * ya las validó (src/config/entorno.ts), así que aquí no deberían fallar.
 */
export class ClavesService {
  private readonly logger = new Logger(ClavesService.name);
  private readonly porKid: ReadonlyMap<string, ClaveDeVerificacion>;

  private constructor(
    private readonly firma: ClaveDeFirma,
    private readonly anterior: ClaveDeVerificacion | undefined,
  ) {
    const vigentes: ClaveDeVerificacion[] = [
      { kid: firma.kid, publica: firma.privada, jwk: firma.jwk },
    ];
    if (anterior && anterior.kid !== firma.kid) vigentes.push(anterior);
    this.porKid = new Map(vigentes.map((clave) => [clave.kid, clave]));
    // Solo los kid: son huellas públicas. Nunca la clave.
    this.logger.log(
      `Clave de firma ${firma.kid}; clave anterior ${anterior ? anterior.kid : 'ninguna'}`,
    );
  }

  static async desdeEntorno(config: ConfigService): Promise<ClavesService> {
    const privada = leerClavePrivada(
      'JWT_SIGNING_KEY',
      config.getOrThrow<string>('JWT_SIGNING_KEY'),
    );
    const firma: ClaveDeFirma = { privada, ...(await kidYJwk(privada)) };

    const valorAnterior = config.get<string>('JWT_PREVIOUS_PUBLIC_KEY');
    let anterior: ClaveDeVerificacion | undefined;
    if (valorAnterior) {
      const publica = leerClavePublica('JWT_PREVIOUS_PUBLIC_KEY', valorAnterior);
      anterior = { publica, ...(await kidYJwk(publica)) };
    }
    return new ClavesService(firma, anterior);
  }

  /** La privada y el kid con que se firma cada token nuevo. */
  claveDeFirma(): { kid: string; privada: KeyObject } {
    return { kid: this.firma.kid, privada: this.firma.privada };
  }

  /** La clave con la que se verifica un token por su `kid`; undefined si no es de este servicio. */
  claveDeVerificacion(kid: string): KeyObject | undefined {
    return this.porKid.get(kid)?.publica;
  }

  /** El JWKS: la clave actual y, si hay, la anterior. Solo partes públicas (n, e). */
  jwks(): { keys: JwkPublica[] } {
    return { keys: [...this.porKid.values()].map((clave) => ({ ...clave.jwk })) };
  }
}

async function kidYJwk(clave: KeyObject): Promise<{ kid: string; jwk: JwkPublica }> {
  const jwk = await jwkPublica(clave);
  return { kid: jwk.kid, jwk };
}
