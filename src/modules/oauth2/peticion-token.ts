import { clienteInvalido, ErrorOAuth, grantNoSoportado, peticionInvalida } from './errores-oauth';

/** El único grant que acepta /oauth2/token. authorizationCode no se implementa (docs/PLAN.md). */
export const GRANT_CLIENT_CREDENTIALS = 'client_credentials';

/** Más largo que esto no puede ser un client_id ni un secreto emitido aquí: ni se busca. */
const LARGO_MAXIMO_CREDENCIAL = 256;

export interface CredencialesCliente {
  clientId: string;
  secreto: string;
  /** Por dónde llegaron: `client_secret_basic` (Authorization) o `client_secret_post` (cuerpo). */
  metodo: 'client_secret_basic' | 'client_secret_post';
}

export interface PeticionToken {
  credenciales: CredencialesCliente;
  /** El `scope` pedido, tal cual (separado por espacios), o undefined si no vino. */
  scope?: string;
}

/** Por qué no se pudo leer la petición, para la auditoría (antes de saber de qué cliente es). */
export class PeticionTokenInvalida extends Error {
  constructor(
    readonly error: ErrorOAuth,
    readonly motivo: 'GRANT_NO_SOPORTADO' | 'PETICION_INVALIDA' | 'CLIENTE_DESCONOCIDO',
  ) {
    super(error.message);
    this.name = 'PeticionTokenInvalida';
  }
}

/**
 * Lee la petición de POST /oauth2/token (RFC 6749, secciones 2.3.1, 4.4.2 y 3.3). No toca la
 * base: lo que sale de aquí todavía hay que autenticarlo.
 *
 * - `grant_type` es obligatorio y solo vale `client_credentials` (si no, unsupported_grant_type).
 * - Ningún parámetro puede repetirse (RFC 6749, sección 3.1): invalid_request.
 * - Las credenciales van por Authorization: Basic o por `client_id` y `client_secret` en el
 *   cuerpo, no por los dos a la vez (sección 2.3). Sin credenciales: invalid_client.
 * - Los parámetros que no conoce se ignoran (sección 3.2).
 */
export function leerPeticionToken(
  cuerpo: unknown,
  autorizacion: string | undefined,
): PeticionToken {
  const parametros = typeof cuerpo === 'object' && cuerpo !== null ? cuerpo : {};
  const repetidos = Object.entries(parametros)
    .filter(([, valor]) => typeof valor !== 'string')
    .map(([nombre]) => nombre);
  if (repetidos.length > 0) {
    throw new PeticionTokenInvalida(
      peticionInvalida(`Parameters must not be repeated: ${repetidos.join(', ')}`),
      'PETICION_INVALIDA',
    );
  }
  const valores = parametros as Record<string, string>;

  if (!valores.grant_type) {
    throw new PeticionTokenInvalida(
      peticionInvalida('The grant_type parameter is required'),
      'PETICION_INVALIDA',
    );
  }
  if (valores.grant_type !== GRANT_CLIENT_CREDENTIALS) {
    throw new PeticionTokenInvalida(grantNoSoportado(), 'GRANT_NO_SOPORTADO');
  }

  return {
    credenciales: leerCredenciales(valores, autorizacion),
    ...(valores.scope === undefined ? {} : { scope: valores.scope }),
  };
}

function leerCredenciales(
  valores: Record<string, string>,
  autorizacion: string | undefined,
): CredencialesCliente {
  const enCuerpo = valores.client_secret !== undefined;
  if (autorizacion !== undefined && autorizacion !== '') {
    if (enCuerpo) {
      throw new PeticionTokenInvalida(
        peticionInvalida('Use only one client authentication method'),
        'PETICION_INVALIDA',
      );
    }
    const basica = leerBasic(autorizacion);
    // Un client_id en el cuerpo está permitido, pero tiene que ser el mismo
    if (valores.client_id !== undefined && valores.client_id !== basica.clientId) {
      throw new PeticionTokenInvalida(
        peticionInvalida('The client_id does not match the Authorization header'),
        'PETICION_INVALIDA',
      );
    }
    return basica;
  }
  if (enCuerpo && valores.client_id) {
    return comprobarLargo({
      clientId: valores.client_id,
      secreto: valores.client_secret,
      metodo: 'client_secret_post',
    });
  }
  throw new PeticionTokenInvalida(clienteInvalido(), 'CLIENTE_DESCONOCIDO');
}

/**
 * `Basic base64(urlencode(client_id) ":" urlencode(secreto))`. RFC 6749 (2.3.1) pide codificar
 * cada parte como formulario antes de base64: un `+` es un espacio y `%3A` un ":". Otro esquema
 * (Bearer, Digest) o un valor ilegible: invalid_client.
 */
function leerBasic(autorizacion: string): CredencialesCliente {
  const coincidencia = /^Basic[ ]+([A-Za-z0-9+/]+={0,2})[ ]*$/i.exec(autorizacion);
  if (!coincidencia) throw new PeticionTokenInvalida(clienteInvalido(), 'CLIENTE_DESCONOCIDO');
  const texto = Buffer.from(coincidencia[1], 'base64').toString('utf8');
  const separador = texto.indexOf(':');
  if (separador < 1) throw new PeticionTokenInvalida(clienteInvalido(), 'CLIENTE_DESCONOCIDO');
  try {
    return comprobarLargo({
      clientId: decodificarFormulario(texto.slice(0, separador)),
      secreto: decodificarFormulario(texto.slice(separador + 1)),
      metodo: 'client_secret_basic',
    });
  } catch (error) {
    if (error instanceof PeticionTokenInvalida) throw error;
    throw new PeticionTokenInvalida(clienteInvalido(), 'CLIENTE_DESCONOCIDO');
  }
}

function decodificarFormulario(valor: string): string {
  return decodeURIComponent(valor.replace(/\+/g, ' '));
}

function comprobarLargo(credenciales: CredencialesCliente): CredencialesCliente {
  if (
    credenciales.clientId === '' ||
    credenciales.secreto === '' ||
    credenciales.clientId.length > LARGO_MAXIMO_CREDENCIAL ||
    credenciales.secreto.length > LARGO_MAXIMO_CREDENCIAL
  ) {
    throw new PeticionTokenInvalida(clienteInvalido(), 'CLIENTE_DESCONOCIDO');
  }
  return credenciales;
}
