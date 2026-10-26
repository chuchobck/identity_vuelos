import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Express } from 'express';
import { middlewareContexto, middlewareRequestId } from './common/contexto/contexto.middleware';
import { LoggerJson, nivelesPorEntorno } from './common/logger/logger-json';
import { crearPipeValidacion } from './common/pipes/validacion.pipe';
import { parsearTrustProxy } from './config/proxy';
import { middlewareContextoTraza, middlewareObservacion } from './observabilidad/express';
import { Metricas } from './observabilidad/metricas';
import { Trazas } from './observabilidad/trazas';
import { configurarSeguridad } from './config/seguridad';
import { configurarSwagger, RUTA_SWAGGER } from './config/swagger';
import {
  excluidasDelPrefijo,
  PREFIJO_GLOBAL,
  RUTAS_SIN_CACHE,
  VERSION_POR_DEFECTO,
} from './routes/index.routes';

export interface OpcionesConfigurarApp {
  /** Logger de la app. Por defecto, JSON a la salida estándar con los niveles del entorno. */
  logger?: LoggerJson | false;
}

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y
 * las pruebas e2e, para que probar el servicio sea probar el que de verdad se despliega.
 *
 * El orden de los middlewares importa:
 *   1. request id: antes que todo, para que hasta un 413 del parser lleve X-Request-Id, y justo
 *      después la observabilidad (span SERVER, X-Trace-Id, métricas): el primero que sigue
 *   2. helmet, CORS, parser del cuerpo y tipo de contenido (configurarSeguridad)
 *   3. contexto asíncrono (el de la app y el del span): después del parser, que perdería el
 *      contexto si se abriera antes
 */
export function configurarApp(app: NestExpressApplication, opciones: OpcionesConfigurarApp = {}) {
  const config = app.get(ConfigService);
  // Antes del primer middleware: de esto depende que `req.ip` sea la IP del cliente
  app.set('trust proxy', parsearTrustProxy(config.get<string>('TRUST_PROXY')));
  // Ninguna respuesta dice con qué está hecho el servicio (helmet también lo quita)
  app.disable('x-powered-by');

  const logger =
    opciones.logger ?? new LoggerJson(undefined, nivelesPorEntorno(config.get('NODE_ENV')));
  app.useLogger(logger);

  const trazas = app.get(Trazas);
  app.use(middlewareRequestId);
  app.use(middlewareObservacion(trazas, app.get(Metricas)));
  configurarSeguridad(app, RUTAS_SIN_CACHE);
  app.use(middlewareContexto);
  // Igual que el contexto de la app: el del span se reabre después del parser del cuerpo
  app.use(middlewareContextoTraza(trazas));

  // /identity/v1/...: prefijo global más versión en la URL; las rutas de los estándares
  // (/.well-known, /oauth2/token) quedan en la raíz
  app.setGlobalPrefix(PREFIJO_GLOBAL, { exclude: excluidasDelPrefijo() });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_POR_DEFECTO });

  app.useGlobalPipes(crearPipeValidacion());

  // La raíz no es una ruta del servicio: lleva a la documentación
  const express: Express = app.getHttpAdapter().getInstance();
  express.get('/', (_req, res) => res.redirect(302, `/${RUTA_SWAGGER}`));
  configurarSwagger(app);
}
