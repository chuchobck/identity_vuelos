# CLAUDE.md

Reglas permanentes del proyecto. Léelas antes de tocar código.

## Proyecto

Quinde · Identity: el proveedor de identidad del sistema de vuelos (Reto 2 de Integración de
Sistemas, PUCE). NestJS 10 + TypeScript estricto + Prisma 7 + PostgreSQL. Emite tokens de acceso
JWT RS256 (RFC 9068) para personas (`/identity/v1/auth/*`, con la misma forma que
`/flights/v1/auth` del core) y para clientes OAuth 2.0 (`/oauth2/token`, client_credentials), y
publica sus claves públicas en `/.well-known/jwks.json`. El core
(`github.com/chuchobck/backend_vuelos`) los verificará con ese JWKS. El plan y el estado están en
`docs/PLAN.md`; el despliegue, en `docs/DEPLOY.md`; el contrato, en
`contracts/identity-openapi.json`.

## Alcance

- Solo identidad: cuentas de personas, clientes OAuth, claves de firma y auditoría de seguridad.
  Nada de vuelos.
- Desde este repo no se toca el core ni el frontend.
- El flujo authorizationCode del contrato no se implementa (ver Decisiones en `docs/PLAN.md`).

## Idioma

- Código, carpetas, comentarios y base de datos en español.
- Rutas y JSON hacia afuera en inglés. La respuesta de tokens y los errores de `/oauth2/token`
  van en snake_case, como RFC 6749.

## Estructura

- Por capas, como el core: `<entidad>.routes.ts` → controller → service → repository (el único
  archivo que usa Prisma), mapper y `dto/`. Una sola tabla de rutas: `src/routes/index.routes.ts`.
- `src/modules/`: `auth` (personas; `auth/administradores` es `/admin/users`, copia del core),
  `oauth2` (clientes), `claves` (claves, firma y verificación), `descubrimiento` (JWKS y
  openid-configuration), `auditoria` y `salud`.
- `src/cli/`: herramientas de línea de comandos (`keys:generate`, `cliente:crear`,
  `openapi:export`), compiladas con el resto: también corren dentro de la imagen.
- Lo propio cuelga de `/identity/v1`; `/.well-known/*` y `/oauth2/token` van en la raíz (los
  fijan los estándares y el `tokenUrl` del contrato del core). Swagger en `/api/docs`.

## Tokens y claves

- Solo RS256, con `kid` = huella de la clave (RFC 7638), `typ` `at+jwt` y los claims de RFC 9068:
  `iss`, `sub`, `aud`, `exp`, `iat`, `jti`, `scope` y `client_id` (solo en clientes). 15 minutos.
- `sub` es siempre un uuid (`usuario.id` o `cliente_oauth.id`): el core lo exige.
- Dos ranuras: `JWT_SIGNING_KEY` (privada, firma) y `JWT_PREVIOUS_PUBLIC_KEY` (pública, solo
  verifica). La privada nunca se loguea ni va a la base, a una respuesta o a git.
- Un cambio en cómo se firma o se verifica se prueba contra el verificador independiente
  (`test/utils/verificador.ts`, jose + JWKS por HTTP), no solo contra `TokensService`.
- Los scopes de cada rol están en `src/modules/auth/scopes.ts` (la tabla del core); los de cada
  cliente, en `cliente_oauth.scopes_permitidos`. Un cliente solo recibe `flights:ops`,
  `flights:admin` o `events:publish` si lo tiene permitido y lo pide; ningún rol de persona tiene
  `events:publish` y el rol `cliente` no tiene `flights:ops`.
- El partner Booking Prototipo es un cliente OAuth (`docs/PARTNER-BOOKING.md`): su token lleva
  `client_id` y solo sus cinco scopes; el core lo reconoce como partner por ese `client_id`.

## Seguridad

- Toda ruta exige token salvo las marcadas con `@Publico()`. Las de este servicio que piden
  token son de personas: el token de un cliente no entra.
- Nunca registrar ni devolver contraseñas, hashes, tokens, secretos de cliente ni claves, tampoco
  en mensajes de error ni en `auditoria_seguridad`. El correo de un login fallido se guarda
  parcial. El escaneo de `test/auditoria.e2e-spec.ts` lo comprueba.
- Correo inexistente, contraseña errónea y cuenta inactiva (y cliente desconocido, secreto errado
  y cliente inactivo) responden igual y tardan lo mismo: siempre se corre argon2.
- Cada evento de seguridad pasa por `AuditoriaSeguridad`, con un motivo de la lista cerrada, el
  `X-Request-Id` y el `X-Correlation-Id` de la petición.
- `X-Correlation-Id` (contrato v2, §6): se lee si es válido (hasta 100 caracteres, sin espacios
  ni comillas), si no se genera; se devuelve en toda respuesta, en `ProblemDetails.correlation_id`,
  en cada línea de log y en la auditoría. Se propaga sin cambios.
- `/identity/v1` responde los errores como ProblemDetails (los mismos `code` y `type` que el
  core); `/oauth2/token`, con el formato de RFC 6749. Toda respuesta de `/auth` y de
  `/oauth2/token`, también un error, lleva `Cache-Control: no-store`.
- Cuerpos JSON, salvo `/oauth2/token` (formulario); otro tipo, 415. Máximo 100 kB.
- Un vencimiento (token, refresh, límite de peticiones) se decide con la hora del `Reloj`
  (`src/common/reloj.ts`), no con `new Date()`: las pruebas lo adelantan.

## Datos

- La base es la fuente de verdad (`db/*.sql`, esquema `identidad`); no se usa `prisma migrate`.
  Un cambio de esquema va en `db/esquema_identidad.sql` y, para las bases que ya existen, en una
  migración idempotente y aditiva de `db/migraciones/` (`db/migrar.sh`); CI exige que las dos
  den la misma base.
- Eliminación lógica siempre: nada de `DELETE` físico (la extensión de Prisma lo bloquea).
  `auditoria_seguridad` es de solo inserción (un trigger lo impone).
- `db/reset.sh` borra solo el esquema `identidad`, nunca la base.
- Las pruebas no borran: crean cuentas `@e2e.quinde.example` y clientes `e2e-...` y al final los
  dan de baja.
- Ningún `.json` con el mismo nombre base que un `.ts`: Jest importaría el JSON.

## Observabilidad

- El estándar es `docs/OBSERVABILIDAD.md` del repo `gateway_vuelos`; un cambio de nombres,
  etiquetas o atributos se hace allá primero. `traceparent.ts`, `atributos.ts`, `trazas.ts` y
  `metricas.ts` de `src/observabilidad/` son copia tal cual del gateway: no se editan aquí.
- Servicio interno: continúa el `traceparent` del gateway (`TRACE_TRUST_INCOMING=true`). Spans
  manuales con los atributos de `ATRIBUTOS_PERMITIDOS`; `route` es siempre la plantilla o
  `__unmatched__`. Un 4xx no marca error un span.
- Nunca a un span, una métrica o un log: tokens, `Authorization`, contraseñas, correos, la query
  ni cuerpos. Tampoco a un span o una métrica: ids de usuario o de cliente, `client_id` ni IPs
  (al log, solo el uuid de `sub` y la IP de la línea de acceso, como desde la 4a). Las etiquetas
  de las métricas propias (`identity_*`) son listas cerradas.
- Las métricas van en `METRICS_PORT`, nunca en el puerto público. En las pruebas es 0; la prueba
  de métricas abre el suyo y carga `crearApp` después de fijarlo.

## Pruebas

- Jest + supertest contra PostgreSQL real. Las claves de prueba son efímeras
  (`test/utils/entorno-pruebas.ts`).
- Una prueba nueva se comprueba rompiendo a propósito lo que cubre. Si es de seguridad, su
  mutación va a `scripts/mutaciones.mjs` (`npm run test:mutaciones`).
- `contracts/identity-openapi.json` se regenera con `npm run openapi:export`; una prueba falla si
  quedó desactualizado.

## Git

- Commits en Conventional Commits y en español: `tipo(ámbito): verbo en infinitivo y qué cambia`.
- Un commit por paso, y cada uno pasa `npm run lint`, `npm run format:check`, `npm run typecheck`
  y `npm run build`.
- Una rama por fase. Push solo de esa rama, al cerrar la fase y ya verificada; nunca a `main`,
  nunca `--force`, nunca reescribir commits subidos. El merge lo hace el dueño del repo.
- Nunca claves, secretos ni `.env` en git: solo `.env.example`.

## Verificación

- Verificar con `curl` o pruebas, no solo compilando. CI (`.github/workflows/ci.yml`) corre lint,
  formato, tipos, build, la suite e2e con PostgreSQL y la construcción de la imagen en cada push
  y pull request a `main`.
- Una variable de entorno nueva va en `src/config/entorno.ts`, `.env.example` y
  `docs/DEPLOY.md`.
- Al terminar cada fase: actualizar `docs/PLAN.md` y entregar un resumen con qué se verificó,
  qué no se pudo verificar y qué se decidió sin consultar.
