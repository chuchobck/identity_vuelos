import { Context, context, Span } from '@opentelemetry/api';
import type { Request } from 'express';

/** Lo que la observabilidad sabe de una petición de Express. */
export interface ObservacionPeticion {
  span: Span;
  /** El contexto de OpenTelemetry con el span SERVER activo y el request id. */
  contexto: Context;
  inicio: bigint;
}

const OBSERVACION = Symbol('observacionPeticion');
type PeticionObservada = Request & { [OBSERVACION]?: ObservacionPeticion };

export function guardarObservacion(peticion: Request, observacion: ObservacionPeticion): void {
  (peticion as PeticionObservada)[OBSERVACION] = observacion;
}

export function observacionDe(peticion: Request): ObservacionPeticion | undefined {
  return (peticion as PeticionObservada)[OBSERVACION];
}

/**
 * Corre `trabajo` con el span de la petición activo, también desde un lugar que corre FUERA de
 * su contexto asíncrono: el `finish` de la respuesta (se emite desde el socket) o el filtro ante
 * un error del parser del cuerpo. Así esas líneas de log también llevan traceId y spanId.
 */
export function enObservacion<T>(peticion: Request, trabajo: () => T): T {
  const observacion = observacionDe(peticion);
  return observacion ? context.with(observacion.contexto, trabajo) : trabajo();
}
