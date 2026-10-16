import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Scope } from '../../modules/auth/scopes';
import { ApiProblema, DocumentarAutenticacion } from './documentacion.decorator';

export const SCOPES_REQUERIDOS = 'scopesRequeridos';

/**
 * Scopes que debe traer el token para entrar a la ruta (todos los indicados). Sin ellos,
 * ScopesGuard responde 403 diciendo cuáles faltan. Implica JWT: no va junto con @Publico().
 * Es el decorador del core (src/common/decorators/scopes.decorator.ts).
 *
 *   @Scopes('flights:admin')
 *   @Get()
 *   listar() {}
 *
 * En Swagger lo documenta con el candado de `bearer` y las respuestas 401 y 403. A diferencia
 * del core no declara el esquema OAuth2Security: las rutas de este servicio que piden token son
 * de personas, y el token de un cliente (client_credentials) no entra aunque traiga el scope.
 */
export const Scopes = (...scopes: [Scope, ...Scope[]]) =>
  applyDecorators(
    SetMetadata(SCOPES_REQUERIDOS, scopes),
    DocumentarAutenticacion(),
    ApiProblema(403, `El token no trae los scopes requeridos: ${scopes.join(', ')}`),
  );
