import { CodigoError } from '../../src/common/errores/codigo-error';

const CAMPOS = ['type', 'title', 'status', 'detail', 'code', 'invalidParams', 'correlation_id'];

/**
 * Comprueba que el cuerpo es un ProblemDetails con la misma forma que el del core: campos
 * obligatorios, ningún campo extra y `code` dentro de la lista.
 */
export function esperarProblemDetails(respuesta: {
  status: number;
  type: string;
  body: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): void {
  expect(respuesta.type).toBe('application/problem+json');
  expect(Object.keys(respuesta.body).filter((c) => !CAMPOS.includes(c))).toEqual([]);
  expect(typeof respuesta.body.type).toBe('string');
  expect(typeof respuesta.body.title).toBe('string');
  expect(respuesta.body.status).toBe(respuesta.status);
  expect(Object.values(CodigoError)).toContain(respuesta.body.code);
  // Contrato v2, §6: todo error lleva el id del proceso, el mismo de la cabecera
  expect(typeof respuesta.body.correlation_id).toBe('string');
  expect(respuesta.body.correlation_id).toBe(respuesta.headers?.['x-correlation-id']);
}

/** Un error de /oauth2/token: exactamente `error` y `error_description` (RFC 6749, 5.2). */
export function esperarErrorOAuth(
  respuesta: { status: number; type: string; body: Record<string, unknown> },
  status: number,
  error: string,
): void {
  expect(respuesta.status).toBe(status);
  expect(respuesta.type).toBe('application/json');
  expect(Object.keys(respuesta.body).sort()).toEqual(['error', 'error_description']);
  expect(respuesta.body.error).toBe(error);
  expect(typeof respuesta.body.error_description).toBe('string');
}
