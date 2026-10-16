import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fijarUsuario } from '../contexto/contexto-peticion';
import { ES_PUBLICO } from '../decorators/publico.decorator';
import { PeticionAutenticada } from '../decorators/usuario-actual.decorator';
import { desafioBearer, noAutenticado } from '../../modules/auth/errores-auth';
import { TokenInvalidoError, TokensService } from '../../modules/claves/tokens.service';

/** `Bearer <token>`; el esquema no distingue mayúsculas (RFC 7235). */
const CABECERA_BEARER = /^Bearer[ ]+([A-Za-z0-9._~+/-]+=*)[ ]*$/i;

const NO_ES_DE_PERSONA = 'The access token does not belong to a user account';

/**
 * Guard global: toda ruta exige un token de acceso válido salvo las marcadas con @Publico().
 * Corre después del límite de peticiones (un 401 también cuenta).
 *
 * - Sin cabecera Authorization, o con otro esquema: 401 con `WWW-Authenticate: Bearer realm=...`
 * - Token vencido, mal firmado, de otro emisor o audiencia: 401 con `error="invalid_token"`
 * - Token de un cliente OAuth (lleva client_id): 401 `invalid_token`; las rutas de este
 *   servicio que piden token (/auth/me, /auth/logout, /admin/users) son de personas.
 *
 * El token nunca va al log ni a la respuesta.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const esPublico = this.reflector.getAllAndOverride<boolean>(ES_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (esPublico) return true;

    const peticion = contexto.switchToHttp().getRequest<PeticionAutenticada>();
    const coincidencia = CABECERA_BEARER.exec(peticion.headers.authorization ?? '');
    if (!coincidencia) throw noAutenticado('A bearer access token is required');

    try {
      const identidad = await this.tokens.verificar(coincidencia[1]);
      if (identidad.clientId !== undefined) {
        throw noAutenticado(NO_ES_DE_PERSONA, desafioBearer('invalid_token', NO_ES_DE_PERSONA));
      }
      peticion.usuario = { id: identidad.sub, scopes: identidad.scopes, idToken: identidad.jti };
      fijarUsuario(identidad.sub);
      return true;
    } catch (error) {
      if (!(error instanceof TokenInvalidoError)) throw error;
      throw noAutenticado(error.message, desafioBearer('invalid_token', error.message));
    }
  }
}
