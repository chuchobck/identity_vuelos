# Changelog

Formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones según
[SemVer](https://semver.org/lang/es/).

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
