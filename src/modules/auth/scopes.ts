/**
 * Permisos (`scope` del token) y qué roles los tienen. Es la tabla del core
 * (src/modules/auth/scopes.ts de backend_vuelos), copiada tal cual, más `events:publish`, que
 * todavía no está allá: este servicio la emite y el core la exige con sus `@Scopes(...)`.
 *
 * DÓNDE VIVE ESTA TABLA: en código y no en la base, a propósito (la misma razón que en el core).
 * - Un scope solo significa algo si un `@Scopes(...)` del core lo exige: agregar uno en la base
 *   sin cambiar el código no protege nada. Cualquier cambio de permisos ya implica desplegar.
 * - Son 2 roles y 7 scopes (5 del contrato y 2 del proyecto): una tabla `alcance` y otra
 *   `rol_alcance` sumarían dos joins a cada login y refresh sin dar flexibilidad real.
 * Lo que sí está en la base es qué rol tiene cada usuario (usuario_rol) y qué scopes puede pedir
 * cada cliente OAuth (cliente_oauth.scopes_permitidos): eso cambia sin desplegar. Los códigos de
 * rol de aquí deben coincidir con los de db/semilla_identidad.sql, y SCOPES con el CHECK
 * ck_cliente_oauth_scopes de db/esquema_identidad.sql.
 */

/**
 * Los 5 scopes de components.securitySchemes.OAuth2Security del contrato del core, más dos
 * propios del proyecto que no están en el contrato: `flights:admin`, para la administración
 * (/admin del core y /identity/v1/admin de aquí), y `events:publish`, para que un servicio (el
 * core) publique eventos. El orden es el de la respuesta (`scope` del token y `scopes` de
 * /auth/me).
 */
export const SCOPES = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
  'flights:admin',
  'events:publish',
] as const;

export type Scope = (typeof SCOPES)[number];

/** El scope de administración: un cliente OAuth solo lo recibe si lo tiene permitido y lo pide. */
export const SCOPE_ADMINISTRACION: Scope = 'flights:admin';

/**
 * El scope para publicar eventos. Es de máquina a máquina: ningún rol de persona lo tiene (no
 * está en SCOPES_POR_ROL) y un cliente OAuth solo lo recibe si lo tiene permitido de forma
 * explícita (`cliente:crear --permitir-eventos`) y lo pide.
 */
export const SCOPE_EVENTOS: Scope = 'events:publish';

/**
 * Lo que un cliente OAuth nunca recibe por defecto: aunque los tenga permitidos, sin `scope` en
 * la petición no salen. Hay que pedirlos uno por uno.
 */
export const SCOPES_SOLO_A_PEDIDO: readonly Scope[] = [SCOPE_ADMINISTRACION, SCOPE_EVENTOS];

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
  // Los de vuelos, uno por uno: events:publish no es de personas y no se cuela si se agrega
  // otro scope a SCOPES
  administrador: [
    'flights:read',
    'flights:hold',
    'flights:book',
    'flights:cancel',
    'flights:webhooks',
    'flights:admin',
  ],
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
