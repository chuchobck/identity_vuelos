import { SpanKind, trace } from '@opentelemetry/api';
import { NextFunction, Request, Response } from 'express';
import { contextoDeLaPeticion } from '../common/contexto/contexto.middleware';
import { metodoNormalizado, RUTA_SIN_PLANTILLA } from './atributos';
import { Metricas } from './metricas';
import { enObservacion, guardarObservacion, observacionDe } from './observacion';
import { CLAVE_REQUEST_ID, marcarError, Trazas } from './trazas';

/**
 * El equivalente a `fastify.ts` del gateway, para Express/Nest (docs/OBSERVABILIDAD.md, sección
 * 5, punto 3). Dos middlewares:
 *
 * 1. `middlewareObservacion`, el primero tras el request id (que fija el X-Request-Id que este
 *    span necesita): abre el span SERVER, pone X-Trace-Id en la respuesta y, al terminar, lo
 *    cierra con la PLANTILLA de la ruta y registra las métricas del servidor.
 * 2. `middlewareContextoTraza`, después del parser del cuerpo: vuelve a entrar al contexto del
 *    span. Igual que el contexto de la app, el de OpenTelemetry se perdería si se abriera antes
 *    del parser (sus eventos se emiten fuera del contexto) y el handler correría sin span.
 */
export const CABECERA_TRACE_ID = 'X-Trace-Id';

export function middlewareObservacion(trazas: Trazas, metricas: Metricas) {
  return (peticion: Request, respuesta: Response, next: NextFunction): void => {
    const metodo = metodoNormalizado(peticion.method);
    const requestId = contextoDeLaPeticion(peticion)?.requestId;
    const padre = trazas.contextoEntrante(peticion.headers.traceparent);
    // El nombre definitivo ("METHOD /plantilla") se pone al terminar, cuando se conoce la plantilla
    const span = trazas.iniciar(
      metodo,
      SpanKind.SERVER,
      { 'http.request.method': metodo, 'quinde.request_id': requestId },
      padre,
    );
    const inicio = process.hrtime.bigint();
    const contexto = trace.setSpan(padre, span).setValue(CLAVE_REQUEST_ID, requestId);
    guardarObservacion(peticion, { span, contexto, inicio });
    respuesta.setHeader(CABECERA_TRACE_ID, span.spanContext().traceId);

    respuesta.on('finish', () => {
      const ruta = plantillaDe(peticion);
      const status = respuesta.statusCode;
      span.updateName(`${metodo} ${ruta ?? RUTA_SIN_PLANTILLA}`);
      span.setAttributes({
        'http.route': ruta ?? RUTA_SIN_PLANTILLA,
        'http.response.status_code': status,
      });
      // En un span de servidor, solo un 5xx es error (un 4xx es culpa del cliente)
      if (status >= 500) marcarError(span, String(status));
      span.end();
      const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;
      metricas.registrarServidor(metodo, ruta, status, segundos);
    });

    trazas.enContexto(contexto, next);
  };
}

/** Va después del parser del cuerpo: reabre el contexto del span para el resto de la cadena. */
export function middlewareContextoTraza(trazas: Trazas) {
  return (peticion: Request, _respuesta: Response, next: NextFunction): void => {
    const observacion = observacionDe(peticion);
    if (!observacion) return next();
    trazas.enContexto(observacion.contexto, next);
  };
}

/**
 * La plantilla de la ruta que atendió la petición (`/identity/v1/admin/users/{id}`), o undefined
 * si ninguna ruta la atendió (404, 405, un error del parser antes de enrutar): una sola serie,
 * `__unmatched__`. Nunca `req.url`: lleva ids y query.
 */
export function plantillaDe(peticion: Request): string | undefined {
  const ruta = (peticion.route as { path?: unknown } | undefined)?.path;
  if (typeof ruta !== 'string') return undefined;
  const completa = `${peticion.baseUrl}${ruta}`;
  // Nest/Express: `:id` → `{id}`, como las plantillas del contrato
  return completa.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export { enObservacion };
