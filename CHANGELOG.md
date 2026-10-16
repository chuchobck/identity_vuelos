# Changelog

Formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones según
[SemVer](https://semver.org/lang/es/).

## [0.2.0] — sin publicar (fase 4c del Reto 2)

### Agregado

- `/identity/v1/admin/users`: `POST`, `GET` y `DELETE /{id}`, copia de `/flights/v1/admin/users`
  del core con las mismas rutas, cuerpos, respuestas, reglas (la propia cuenta y el último
  administrador no se dan de baja), paginación y errores. Exige el token de una persona con
  `flights:admin`; sin el scope, 403 `insufficient_scope` (el `ScopesGuard` del core).
- Eventos `ADMINISTRADOR_CREADO` y `ADMINISTRADOR_DADO_DE_BAJA` en `auditoria_seguridad`, con la
  columna nueva `actor_id` (el administrador que hizo el cambio), en la misma transacción.
- Scope `events:publish`, solo para clientes OAuth: ningún rol de persona lo tiene, un cliente
  lo recibe solo si lo tiene permitido (`cliente:crear --permitir-eventos`) y lo pide.
- `db/migraciones/001_admin_usuarios_y_events_publish.sql` y `db/migrar.sh` para llevar una base
  de la 0.1.0 al esquema nuevo; CI comprueba que la migración es idempotente y que deja la base
  igual a una nueva.
- 49 pruebas nuevas (154 en total) y 15 mutaciones nuevas (40).

### Cambiado

- El rol `administrador` lleva sus seis scopes uno por uno (antes, "todos los scopes").
- Sin `scope`, `/oauth2/token` deja fuera `flights:admin` y también `events:publish`.
- CORS admite `DELETE`; `/identity/v1/admin/` responde con `Cache-Control: no-store`.
- `ck_cliente_oauth_scopes` admite `events:publish` (hasta 7 scopes por cliente).

### Migración

- Una base de la 0.1.0 necesita `./db/migrar.sh` **antes** de desplegar esta versión (ver
  `docs/DEPLOY.md`). La migración solo agrega: la 0.1.0 sigue funcionando con la base migrada.

## [0.1.0] — sin publicar (fase 4a del Reto 2)

### Agregado

- Esquema `identidad` (`db/esquema_identidad.sql`): `usuario`, `rol`, `usuario_rol` y
  `token_refresco` (del core), más `cliente_oauth` y `auditoria_seguridad` (solo inserción).
  `db/reset.sh` borra y recrea solo el esquema.
- Cuentas de personas en `/identity/v1/auth` con la misma forma que `/flights/v1/auth` del core:
  registro, login, refresh con rotación y detección de reuso, logout y perfil.
- Tokens de acceso JWT RS256 (RFC 9068) con `kid`, firmados con `jose`, y dos ranuras de clave
  para rotar (`JWT_SIGNING_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`). `npm run keys:generate`.
- `/.well-known/jwks.json` y `/.well-known/openid-configuration`.
- `POST /oauth2/token` con client_credentials y errores de RFC 6749; `npm run cliente:crear`.
- Auditoría de cada evento de seguridad, sin datos sensibles.
- Helmet, CORS por lista, 100 kB, límites por IP y por cliente, X-Request-Id, logs JSON,
  `/identity/v1/health` y `/health/ready`, entorno validado.
- Swagger en `/api/docs` y `contracts/identity-openapi.json` (`npm run openapi:export`).
- Dockerfile multi-etapa sin privilegios, CI con PostgreSQL 18 y `docs/DEPLOY.md`.
- Pruebas e2e (105) con un verificador independiente sobre el JWKS, y
  `npm run test:mutaciones` (25 mutaciones detectadas).
