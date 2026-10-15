import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { CODIGO_SIN_EQUIVALENTE } from '../common/errores/codigo-error';
import { ErrorNegocio } from '../common/errores/error-negocio';
import { listarOrigenes } from './origenes-cors';

/** Tope del cuerpo de una petición (JSON y formularios). Más grande responde 413. */
export const LIMITE_CUERPO = '100kb';

/** Cabeceras que un navegador puede enviar a este servicio desde un origen permitido. */
const CABECERAS_PERMITIDAS = ['Authorization', 'Content-Type', 'X-Request-Id'];

/** Cabeceras de la respuesta que el navegador deja leer al código del origen permitido. */
const CABECERAS_EXPUESTAS = [
  'X-Request-Id',
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

/**
 * Seguridad HTTP de la app: helmet, CORS por lista de orígenes, tope del cuerpo y tipo de
 * contenido. Va antes de las rutas; los errores que genere (413, 415) los da el filtro global.
 */
export function configurarSeguridad(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  const enProduccion = config.get<string>('NODE_ENV') === 'production';

  // Helmet con su política por defecto. Swagger UI en /api/docs funciona con ella.
  // `upgrade-insecure-requests` solo se deja en producción: en http://localhost el navegador
  // subiría los recursos a https y Swagger UI no cargaría.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: enProduccion ? {} : { 'upgrade-insecure-requests': null },
      },
    }),
  );

  // Una lista vacía no deja pasar ningún origen. No se usan cookies, así que no hay
  // `credentials`: los tokens viajan en el cuerpo y en Authorization.
  app.enableCors({
    origin: listarOrigenes(config.get<string>('CORS_ORIGINS')),
    methods: ['GET', 'HEAD', 'POST'],
    allowedHeaders: CABECERAS_PERMITIDAS,
    exposedHeaders: CABECERAS_EXPUESTAS,
    maxAge: 600,
  });

  app.useBodyParser('json', { limit: LIMITE_CUERPO });
  // `extended: false`: un formulario de OAuth 2.0 es plano; con `qs` un `scope[a]=b` llegaría
  // como objeto. Un parámetro repetido sigue llegando como arreglo y lo rechaza el endpoint.
  app.useBodyParser('urlencoded', { limit: LIMITE_CUERPO, extended: false });
  // Después de los parsers: un formulario de más de 100 kB sigue siendo 413
  app.use(exigirTipoDeContenido);
}

const METODOS_CON_CUERPO = new Set(['POST', 'PUT', 'PATCH']);

/** Rutas que reciben un formulario de OAuth 2.0 (RFC 6749) en lugar de JSON. */
export const RUTAS_FORMULARIO = new Set(['/oauth2/token']);

/**
 * Toda operación con cuerpo recibe JSON, salvo /oauth2/token, que recibe
 * `application/x-www-form-urlencoded` como manda RFC 6749. Otro tipo (texto, XML, multipart, o
 * JSON en /oauth2/token) responde 415 en lugar de llegar vacío a la validación. Una petición
 * sin cuerpo no se mira.
 */
export function exigirTipoDeContenido(req: Request, _res: Response, next: NextFunction): void {
  const tieneCuerpo =
    Number(req.headers['content-length'] ?? 0) > 0 ||
    req.headers['transfer-encoding'] !== undefined;
  if (!METODOS_CON_CUERPO.has(req.method) || !tieneCuerpo) return next();
  const tipo = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const esperado = RUTAS_FORMULARIO.has(req.path)
    ? 'application/x-www-form-urlencoded'
    : 'application/json';
  if (tipo === esperado) return next();
  next(new ErrorNegocio(415, CODIGO_SIN_EQUIVALENTE, `Content-Type must be ${esperado}`));
}
