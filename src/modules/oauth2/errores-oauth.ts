/**
 * Errores de /oauth2/token con el formato de RFC 6749, sección 5.2:
 *
 *   { "error": "invalid_client", "error_description": "Client authentication failed" }
 *
 * Nunca ProblemDetails en esta ruta: un cliente de OAuth 2.0 (una biblioteca) lee `error`.
 * La descripción va en inglés, sin datos del cliente ni del secreto.
 */
export type CodigoErrorOAuth =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_scope'
  | 'unsupported_grant_type'
  // Registrado en RFC 6749 (4.1.2.1); aquí con 429 (límite) o 503 (base caída) y Retry-After
  | 'temporarily_unavailable'
  | 'server_error';

/** `realm` del desafío Basic del 401 (RFC 6749, sección 5.2, y RFC 7617). */
export const REALM_OAUTH = 'quinde-identity';

export class ErrorOAuth extends Error {
  constructor(
    readonly status: number,
    readonly error: CodigoErrorOAuth,
    readonly descripcion: string,
    readonly cabeceras: Record<string, string> = {},
  ) {
    super(descripcion);
    this.name = 'ErrorOAuth';
  }

  cuerpo(): { error: CodigoErrorOAuth; error_description: string } {
    return { error: this.error, error_description: this.descripcion };
  }
}

/**
 * Cliente desconocido, secreto errado, cliente inactivo, sin credenciales o con otro esquema
 * de autenticación: la misma respuesta, para no revelar qué client_id existen.
 */
export const clienteInvalido = () =>
  new ErrorOAuth(401, 'invalid_client', 'Client authentication failed', {
    'WWW-Authenticate': `Basic realm="${REALM_OAUTH}", charset="UTF-8"`,
  });

export const peticionInvalida = (descripcion: string) =>
  new ErrorOAuth(400, 'invalid_request', descripcion);

export const scopeInvalido = (descripcion: string) =>
  new ErrorOAuth(400, 'invalid_scope', descripcion);

export const grantNoSoportado = () =>
  new ErrorOAuth(400, 'unsupported_grant_type', 'Only the client_credentials grant is supported');

export const demasiadasPeticiones = (segundos: number) =>
  new ErrorOAuth(
    429,
    'temporarily_unavailable',
    `Too many token requests; retry in ${segundos} seconds`,
    { 'Retry-After': String(segundos) },
  );

/**
 * Cualquier otro error que salga de /oauth2/token (413 del parser, 405, una base caída, un
 * fallo no previsto) pasado al formato de RFC 6749 a partir de su status. Un 5xx no lleva
 * detalle interno.
 */
export function errorOAuthPorStatus(
  status: number,
  detalle: string | undefined,
  cabeceras: Record<string, string>,
): ErrorOAuth {
  if (status === 401) return clienteInvalido();
  if (status === 429) {
    return new ErrorOAuth(
      429,
      'temporarily_unavailable',
      detalle ?? 'Too many requests',
      cabeceras,
    );
  }
  if (status === 503) {
    return new ErrorOAuth(
      503,
      'temporarily_unavailable',
      'The service is temporarily unavailable',
      cabeceras,
    );
  }
  if (status >= 500) return new ErrorOAuth(500, 'server_error', 'Internal server error');
  // 413 y 415 son peticiones mal formadas para OAuth: 400 invalid_request. 404 y 405 conservan
  // su status (y el Allow), porque describen la ruta, no los parámetros.
  const conservaStatus = status === 404 || status === 405;
  return new ErrorOAuth(
    conservaStatus ? status : 400,
    'invalid_request',
    detalle ?? 'The request is not valid',
    cabeceras,
  );
}
