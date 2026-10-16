import { CODIGO_SIN_EQUIVALENTE } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';

/**
 * Paginación de las listas, la del core (src/modules/vuelos/catalogo/base/paginacion.ts): como
 * `limit` de GET /bookings en el contrato, 10 por defecto y 50 como máximo, con `cursor` en la
 * query y `{ nextCursor, items }` en la respuesta.
 */
export const LIMITE_POR_DEFECTO = 10;
export const LIMITE_MAXIMO = 50;

/** `true` y `false` llegan como texto en la query; cualquier otro valor lo rechaza @IsBoolean. */
export const booleanoDeQuery = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** El cursor es la clave de la última fila de la página en base64url: opaco para el cliente. */
export function codificarCursor(clave: string): string {
  return Buffer.from(clave, 'utf8').toString('base64url');
}

export function decodificarCursor(cursor: string): string | undefined {
  const clave = Buffer.from(cursor, 'base64url').toString('utf8');
  // Un texto que no era base64url no vuelve igual al codificarlo: no es un cursor de la API
  return clave !== '' && codificarCursor(clave) === cursor ? clave : undefined;
}

/** 400: el cursor no salió de esta lista (el mismo error del core). */
export const cursorInvalido = () =>
  new ErrorNegocio(400, CODIGO_SIN_EQUIVALENTE, 'cursor: is not a cursor of this list', {
    invalidParams: [{ name: 'cursor', reason: 'is not a cursor of this list' }],
  });

/** 404: la clave no existe (el `noEncontrado` del catálogo del core). */
export const noEncontrado = (entidad: string, clave: string) =>
  new ErrorNegocio(404, CODIGO_SIN_EQUIVALENTE, `${entidad} ${clave} was not found`);
