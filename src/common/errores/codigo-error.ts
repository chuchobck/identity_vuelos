/**
 * `code` de los ProblemDetails de /identity/v1. Son los mismos que usa hoy el core en
 * /flights/v1/auth/* (VALIDATION_FAILED como respaldo y RATE_LIMIT_EXCEEDED en el 429), para
 * que el frontend no note el cambio de servicio: solo cambia la URL.
 *
 * /oauth2/token no usa ProblemDetails: responde con el formato de RFC 6749 (ver
 * src/modules/oauth2/errores-oauth.ts).
 */
export enum CodigoError {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
}

/**
 * El código de los errores que no tienen uno propio (400, 401, 403, 404, 405, 409, 413, 415,
 * 5xx): el `status` HTTP dice qué pasó. Es el único lugar donde se decide.
 */
export const CODIGO_SIN_EQUIVALENTE = CodigoError.VALIDATION_FAILED;

/** Código que corresponde a un status cuando el error no trae uno propio. */
export function codigoPorStatus(status: number): CodigoError {
  return status === 429 ? CodigoError.RATE_LIMIT_EXCEEDED : CODIGO_SIN_EQUIVALENTE;
}
