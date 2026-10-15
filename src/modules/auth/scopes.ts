/**
 * Permisos (`scope` del token) y qué roles los tienen. Es la tabla del core
 * (src/modules/auth/scopes.ts de backend_vuelos), copiada tal cual: este servicio la emite y el
 * core la exige con sus `@Scopes(...)`.
 *
 * DÓNDE VIVE ESTA TABLA: en código y no en la base, a propósito (la misma razón que en el core).
 * - Un scope solo significa algo si un `@Scopes(...)` del core lo exige: agregar uno en la base
 *   sin cambiar el código no protege nada. Cualquier cambio de permisos ya implica desplegar.
 * - Son 2 roles y 6 scopes fijados por el contrato: una tabla `alcance` y otra `rol_alcance`
 *   sumarían dos joins a cada login y refresh sin dar flexibilidad real.
 * Lo que sí está en la base es qué rol tiene cada usuario (usuario_rol) y qué scopes puede pedir
 * cada cliente OAuth (cliente_oauth.scopes_permitidos): eso cambia sin desplegar. Los códigos de
 * rol de aquí deben coincidir con los de db/semilla_identidad.sql, y SCOPES con el CHECK
 * ck_cliente_oauth_scopes de db/esquema_identidad.sql.
 */

/**
 * Los 5 scopes de components.securitySchemes.OAuth2Security del contrato del core, más
 * `flights:admin`, propio del proyecto para el CRUD de catálogo en /admin (no está en el
 * contrato). El orden es el de la respuesta (`scope` del token y `scopes` de /auth/me).
 */
export const SCOPES = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
  'flights:admin',
] as const;

export type Scope = (typeof SCOPES)[number];

/** El scope de administración: un cliente OAuth solo lo recibe si lo tiene permitido y lo pide. */
export const SCOPE_ADMINISTRACION: Scope = 'flights:admin';

/** Roles de db/semilla_identidad.sql (tabla rol, columna codigo). */
export const ROLES = ['cliente', 'administrador'] as const;

export type CodigoRol = (typeof ROLES)[number];

/** El único rol que tiene `flights:admin`. */
export const ROL_ADMINISTRADOR: CodigoRol = 'administrador';

/** El rol que recibe una cuenta creada con POST /auth/register. */
export const ROL_DEL_REGISTRO: CodigoRol = 'cliente';

export const SCOPES_POR_ROL: Readonly<Record<CodigoRol, readonly Scope[]>> = {
  // Todo lo que el contrato permite a un cliente, incluidos sus propios webhooks
  cliente: ['flights:read', 'flights:hold', 'flights:book', 'flights:cancel', 'flights:webhooks'],
  administrador: SCOPES,
};

/**
 * Unión de los scopes de los roles, en el orden de SCOPES. Un rol que no está en la tabla
 * (uno nuevo en la base sin su entrada aquí) no concede nada: se niega por defecto.
 */
export function scopesDeRoles(roles: readonly string[]): Scope[] {
  const concedidos = new Set<Scope>(
    roles.flatMap((rol) => (esRolConocido(rol) ? SCOPES_POR_ROL[rol] : [])),
  );
  return SCOPES.filter((scope) => concedidos.has(scope));
}

export function esScope(valor: string): valor is Scope {
  return (SCOPES as readonly string[]).includes(valor);
}

function esRolConocido(rol: string): rol is CodigoRol {
  // hasOwn y no `in`: "constructor" o "__proto__" no son roles
  return Object.prototype.hasOwnProperty.call(SCOPES_POR_ROL, rol);
}
