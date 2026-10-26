import { randomUUID } from 'node:crypto';

export const CABECERA_CORRELATION_ID = 'X-Correlation-Id';

/**
 * Formato aceptado para un X-Correlation-Id que manda el cliente: el contrato v2 (§6) solo fija
 * el largo máximo (100); aquí, además, letras, dígitos, punto, guion, guion bajo y dos puntos,
 * empezando por letra o dígito (`corr-vuelos-7f3a9c`, un UUID, un ULID). Lo demás podría falsear
 * una línea de log (saltos de línea, espacios) o una fila de auditoría.
 */
const FORMATO_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function esCorrelationIdValido(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO_VALIDO.test(valor);
}

/**
 * El id del proceso de negocio (contrato v2, §6): el que manda el cliente si tiene un formato
 * válido, que se propaga sin cambios; si falta, no es válido o llega repetido, uno nuevo
 * (`corr-<uuid>`: "el primer servicio lo genera"). Nunca se rechaza la petición por esto.
 */
export function resolverCorrelationId(cabecera: string | string[] | undefined): string {
  return esCorrelationIdValido(cabecera) ? cabecera : `corr-${randomUUID()}`;
}
