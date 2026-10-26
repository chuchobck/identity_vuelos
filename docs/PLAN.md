# Plan — Quinde · Identity

Actualizado: 2026-10-26 (cierre de la fase I2) · Este archivo se actualiza al cerrar cada fase.

El Reto 2 separa la identidad del core de vuelos. Hasta ahora el core
([backend_vuelos](https://github.com/chuchobck/backend_vuelos)) emitía sus propios JWT HS256 en
`src/modules/auth`, un proveedor de identidad simulado que su `docs/PLAN.md` prometía cambiar
"por el proveedor real" en RDA2. Este servicio es ese proveedor.

## Avance

| Fase | Estado | Verificado |
| --- | --- | --- |
| 4a. Servicio de identidad | Fusionada en `main` (pull request #1, 2026-10-15) | Cada commit pasa `lint`, `format:check` y `build` (y `typecheck` desde que existe). `npm test`: 105 pruebas en 9 archivos contra PostgreSQL 16 local, también sobre una base recién cargada como en CI. `npm run test:mutaciones`: 25 de 25 mutaciones detectadas. Con `curl` contra el servicio compilado: register → login → me, refresh, reuso (401 y familia revocada), client_credentials (200 y 401 con `WWW-Authenticate`), JWKS con `Cache-Control: public, max-age=300` y los dos tokens decodificados. La imagen de Docker construye, corre como uid 1000, no puede escribir en `/app/dist`, queda `healthy` y `crear-cliente` funciona dentro |
| 4b. El core verifica con el JWKS | Pendiente (otra fase, en backend_vuelos) | — |
| 4c. `/admin/users` y `events:publish` | Fusionada en `main` (pull request #2, 2026-10-16) | Cada commit pasa `lint`, `format:check`, `typecheck` y `build`. `npm test`: 154 pruebas en 11 archivos (49 nuevas, entre ellas las dos suites de `/admin/users` del core portadas) contra PostgreSQL 16 local y contra una base cargada como en CI (sin administrador de la semilla, donde corre la prueba del último administrador). `npm run test:mutaciones`: 40 de 40 detectadas (15 nuevas). La migración 001 corrida dos veces sobre una base de la 0.1.0 deja un `pg_dump` igual al de una base nueva. Con `curl` contra el servicio compilado: alta de un administrador (201, `no-store`), 409 y 400, lista paginada, el nuevo inicia sesión con rol `administrador`, `PATCH`/`PUT`/`GET /{id}` 405 y `/reactivate` 404 (como en el core), baja 204 e idempotente, login del dado de baja 401, 409 de la propia cuenta, 404 y 400, auditoría con `actor_id` y sin contraseña, hash ni correo, 403 `insufficient_scope` con un token de cliente, 401 sin token, preflight de CORS con `DELETE`, `cliente:crear` sin `--permitir-eventos` rechazado, el cliente con `events:publish` recibe el scope solo al pedirlo, otro sin permiso recibe `invalid_scope`, ningún login de persona lo trae y el descubrimiento lo publica |
| I2. Contrato v2: partner Booking, `flights:ops`, correlación y observabilidad | Hecha en la rama `feat/v2-partner` (2026-10-26); falta la revisión y el merge | Cada commit pasa `lint`, `format:check`, `typecheck` y `build`. `npm test`: 195 pruebas en 14 archivos (41 nuevas) contra PostgreSQL 16 local y contra una base cargada como en CI. `npm run test:mutaciones`: 56 de 56 detectadas (16 nuevas: `flights:ops` a un rol cliente o sin pedirlo, token de partner sin `client_id`, correlación perdida en la respuesta, el log, la auditoría o el error, ruta cruda y atributo sensible en las trazas, etiqueta por correo en las métricas). Las migraciones 002 a 004 corridas dos veces sobre una base de la 4a dejan un `pg_dump` igual al de una base nueva, y una tercera pasada con un cliente de los ocho scopes no falla. Con `curl` contra el servicio compilado: el comando de producción del cliente `booking-prototipo`, su token (`client_id`, 15 minutos, solo sus cinco scopes), `invalid_scope` al pedir `events:publish`, `flights:admin` o `flights:ops`, la rotación del secreto (el anterior da `invalid_client`), `flights:ops` en el administrador y no en el cliente, `X-Correlation-Id` en respuesta, error, log y auditoría, `X-Trace-Id` que continúa un `traceparent`, los spans que llegan a un recolector, `/metrics` en el 9467 (404 en el puerto público) y ninguna etiqueta con ids ni correos |
| Despliegue en Azure | Pendiente (fase posterior) | — |

## Qué se copió del core y qué cambió

| Tema | Del core, tal cual | Cambio y por qué |
| --- | --- | --- |
| Correo y contraseña | `CorreoNormalizado`, 12 a 128 caracteres con NFKC, argon2id (19 MiB, t=2, p=1) y el hash ficticio | — |
| Refresh token | Opaco de 256 bits, SHA-256 en la base, familia, rotación con UPDATE condicionado y revocación de la familia ante un reuso (también en carrera), 7 días | Los vencimientos usan el `Reloj` (el core usaba `Date.now()`), para probarlos sin esperas |
| Respuestas de `/auth` | Snake_case de OAuth 2.0, el mismo 401 genérico, ProblemDetails con los mismos `code` y `type` | `realm` del `WWW-Authenticate` es `quinde-identity`. `Cache-Control: no-store` en toda respuesta de `/auth`, también en los errores (el core solo lo ponía en login y refresh) |
| Scopes | `SCOPES`, `SCOPES_POR_ROL` y `scopesDeRoles` (un rol desconocido no concede nada) | — |
| Token de acceso | Vigencia de 15 minutos, `sub` uuid, `scope` con espacios | RS256 con `jose` en lugar de HS256 con `jsonwebtoken`: el core verificará con la pública del JWKS sin compartir un secreto. Cabecera `typ: at+jwt` y `kid`; `client_id` en los tokens de clientes |
| Transversal | Entorno validado, X-Request-Id con contexto asíncrono, filtro ProblemDetails, ValidationPipe, `AlmacenLimites` con `Reloj`, `@LimiteEstricto`, helmet, CORS por lista, 100 kB, `TRUST_PROXY`, bloqueo del borrado físico | Logs JSON de una línea (en lugar de `ConsoleLogger` con prefijo). Un error de Prisma va al log sin su mensaje (puede copiar los valores). TypeScript con `strict` (el core lo tiene apagado) |
| Base | `usuario`, `rol`, `usuario_rol`, `token_refresco` | Esquema `identidad` (no `vuelos`); `cliente_oauth` y `auditoria_seguridad` nuevas; sin la auditoría genérica (`fn_auditar`) ni `transaccionAuditada`: aquí se auditan eventos de seguridad, explícitos desde el service |
| `/admin/users` (fase 4c) | Controller, service, repository, mapper y DTO de `src/modules/auth/administradores`; `ScopesGuard`, `@Scopes`, `UuidPipe` y la paginación por cursor del catálogo; las mismas dos suites de pruebas | Auditoría en `auditoria_seguridad` (con `actor_id`) en lugar de `transaccionAuditada`; los intentos rechazados también quedan. La hora de la revocación sale del `Reloj`. `@Scopes` no declara `OAuth2Security` en Swagger: el token de un cliente no entra |
| Fuera | — | Todo lo de vuelos |

## Decisiones

Tomadas sin consultar, con la lectura más razonable del pedido.

| Tema | Decisión | Por qué |
| --- | --- | --- |
| Rutas | `/identity/v1/auth/*` y `/identity/v1/health(/ready)`; `/.well-known/*` y `/oauth2/token` en la raíz | El descubrimiento busca `{issuer}/.well-known/...` y el `tokenUrl` del contrato del core es `.../oauth2/token`. Lo propio sigue el patrón del core (`/flights/v1`) |
| `JWT_ISSUER` | Obligatoria; el origen del servicio, sin ruta ni barra final; https en producción salvo `localhost` | Es el `iss` y la base de `jwks_uri`; el core lo compara texto a texto. Con ruta, `/.well-known` no quedaría en `{issuer}/.well-known` |
| `JWT_AUDIENCE` | Opcional, `quinde-vuelos-api` por defecto | Es el `aud` que el core ya acepta: en la fase 4b solo cambia cómo verifica, no qué |
| Claves | PEM en base64 en `JWT_SIGNING_KEY` (privada) y `JWT_PREVIOUS_PUBLIC_KEY` (pública). La anterior debe ser pública: una privada ahí no arranca | La ranura anterior solo verifica: no debe tener con qué firmar. Base64 porque un valor de varias líneas se rompe en un .env, en Docker o en el panel de una nube |
| `kid` | Huella SHA-256 de la clave (RFC 7638) | Sale de la clave: no hay otra variable que mantener y la misma clave da siempre el mismo `kid` |
| `client_id` en tokens de personas | No va | Lo pidió así el enunciado. RFC 9068 lo marca como obligatorio; aquí su ausencia es lo que distingue un token de persona de uno de cliente (el login de personas no pasa por un cliente OAuth) |
| `typ` | El servicio exige `at+jwt` al verificar | RFC 9068 (sección 4): evita aceptar como token de acceso otro JWT del mismo emisor |
| Token de cliente en `/auth/me` | 401 `invalid_token` | Las rutas de este servicio que piden token son de personas |
| authorizationCode | No se implementa | Lo indica el enunciado. Exigiría pantalla de login, redirecciones registradas, PKCE y consentimiento: es otra fase. El frontend sigue con el login JSON de `/auth/login` |
| `/oauth2/token` | Solo `application/x-www-form-urlencoded` (JSON: 400 `invalid_request`); un parámetro repetido, 400; los desconocidos se ignoran | RFC 6749 (secciones 3.1, 3.2 y 4.4.2) |
| Autenticación del cliente | `client_secret_basic` o `client_secret_post`, no las dos; sin credenciales, otro esquema o un Basic ilegible: `invalid_client` | RFC 6749, sección 2.3 |
| `scope` en client_credentials | Si se pide algo fuera de lo permitido: `invalid_scope` (no se entrega un subconjunto). Sin `scope`: los permitidos menos `flights:admin` | RFC 6749 3.3 permite las dos cosas; fallar es más claro. `flights:admin` nunca sale por defecto |
| 429 de `/oauth2/token` | `{ "error": "temporarily_unavailable" }` con `Retry-After` | RFC 6749 no define un código para el límite; `temporarily_unavailable` es el registrado más cercano |
| 413, 415, 405 y 5xx en `/oauth2/token` | También con el formato de RFC 6749 (413 y 415 como 400 `invalid_request`; 405 conserva su status y el `Allow`; 5xx `server_error` sin detalle) | El enunciado: "nunca ProblemDetails aquí" |
| Límites de `/oauth2/token` | 20 por minuto e IP y 10 por minuto y client_id presentado | Un cliente legítimo pide un token cada 15 minutos. El límite por client_id frena a quien reparte intentos entre IP |
| Secreto de cliente | 256 bits aleatorios en base64url; hash argon2id con los parámetros de las contraseñas; cliente desconocido corre argon2 contra el hash ficticio | Misma respuesta y mismo tiempo para cliente desconocido, secreto errado e inactivo |
| `client_id` | `cli-` y 20 hexadecimales, o el que se elija con `--client-id`; minúsculas, dígitos, `.`, `-` y `_`, sin `:` | `:` separa id y secreto en Basic |
| `/health` y `/health/ready` | `/health` no mira la base (vida); `/health/ready` sí (disponibilidad) | Un contenedor no se reinicia porque la base se cayó; el balanceador sí lo saca |
| Auditoría | Tabla propia `auditoria_seguridad`, de solo inserción (trigger), con motivo de una lista cerrada (CHECK) y el correo de un fallo solo parcial (CHECK `an***@dominio`). Si la escritura falla, se loguea sin datos y la petición sigue | La base impide guardar texto libre o un correo completo aunque el código se equivoque. Un login no se cae por la auditoría |
| Base por defecto | Base aparte (`identity_db`, esquema `identidad`); documentada también la opción de la misma base del core | Aísla los hashes de contraseñas de las credenciales del core. En local, otro contenedor en el 5433 |
| `db/reset.sh` | Borra solo el esquema; contra un host no local exige `CONFIRMAR_RESET=si`; la contraseña va por `PGPASSWORD`, no como argumento | Puede ser la misma base del core |
| Logs | JSON de una línea, sin filtro que borre datos sensibles | La regla es no ponerlos; un filtro escondería el error. La prueba de escaneo y la mutación `loguea-token` lo comprueban |
| `jose` 6 | Se usa la versión actual, solo ESM | Node 22 la carga con `require` (require(esm)). Para Jest hay un transformador propio (ver Hallazgos). El core necesitará lo mismo en la fase 4b |
| CLI | `keys:generate`, `cliente:crear` y `openapi:export` en `src/cli/`, compiladas con el servicio | También corren dentro de la imagen (`node dist/cli/...`), sin ts-node |

### Fase 4c

| Tema | Decisión | Por qué |
| --- | --- | --- |
| Cambio de rol y reactivación | No se implementan: solo `POST`, `GET` y `DELETE /{id}`, como el core | El pedido decía "las mismas operaciones" y "copia las reglas, no las inventes"; el core no tiene esas rutas y el backoffice dice que no usa `get`, `update` ni `reactivate` de administradores. Cambiar un rol o reactivar sigue siendo SQL (como en el core); si hacen falta, son una fase que también cambia el core o el backoffice |
| Token de un cliente OAuth en `/admin/users` | 401 `invalid_token`, aunque traiga `flights:admin` | La regla de CLAUDE.md: las rutas de este servicio que piden token son de personas. Así un administrador queda atado a una persona (`actor_id` es FK a `usuario`) |
| Auditoría de `/admin/users` | `ADMINISTRADOR_CREADO` y `ADMINISTRADOR_DADO_DE_BAJA` con `usuario_id` (la cuenta) y `actor_id` (el `sub` del administrador), dentro de la transacción del cambio; los rechazos (correo repetido, propia cuenta, último administrador) como `FALLO` fuera de ella. La baja repetida no deja fila. El 404 tampoco (no hay cuenta a la que apuntar) | Un cambio de permisos no puede quedar sin rastro: si la auditoría falla, el cambio se revierte (500). En los demás eventos se mantiene la regla de la 4a: la auditoría no tumba la petición |
| `actor_id` | Columna nueva, al final de la tabla, con FK a `usuario` | Separa quién hizo el cambio de la cuenta afectada sin cambiar el significado de `usuario_id`. Al final para que una base migrada y una nueva sean iguales columna a columna |
| `events:publish` | Scope de `SCOPES`, fuera de `SCOPES_POR_ROL`; `administrador` lista sus seis scopes uno por uno; sin `scope`, un cliente no lo recibe (`SCOPES_SOLO_A_PEDIDO`); el alta exige `--permitir-eventos` (no basta `--permitir-admin`) | Lo pedido: solo un cliente máquina a máquina con el scope permitido de forma explícita, y nunca por defecto. Con la lista explícita, un scope nuevo en `SCOPES` no le llega a una persona por accidente |
| Migraciones | `db/migraciones/NNN_*.sql`, idempotentes y solo aditivas; `db/migrar.sh` las corre; `db/reset.sh` también (en una base nueva no cambian nada); CI exige que una base de la 0.1.0 migrada dos veces sea igual a una nueva | El pedido pidió una migración idempotente para las bases existentes. Sin `prisma migrate` (CLAUDE.md), un script y una prueba de igualdad evitan que el esquema y las migraciones se separen |
| CORS | `DELETE` entre los métodos permitidos | El backoffice da de baja administradores desde el navegador |
| `no-store` | También en `/identity/v1/admin/` | La lista lleva correos de cuentas con permisos de administración |
| Versión | 0.2.0 | Agregados compatibles (rutas y un scope) |

### Fase I2

| Tema | Decisión | Por qué |
| --- | --- | --- |
| `flights:ops` | Entre `webhooks` y `admin` en `SCOPES` (como `PartnerOAuth2`); el rol `administrador` lo lleva en su lista explícita, el rol `cliente` no; a un cliente OAuth solo si tiene `--permitir-ops` y lo pide | Lo pedido. Como `flights:admin`: un scope de operaciones nunca sale por defecto, aunque el cliente lo tenga permitido |
| El partner no necesita un perfil nuevo en el código | Booking es un cliente OAuth normal; su definición está en `docs/PARTNER-BOOKING.md` (el comando exacto) | `cliente:crear` ya hacía lo necesario: ninguna bandera `--permitir-*` impide `flights:ops`, `flights:admin` y `events:publish`. El token trae `client_id` desde la 4a, y así el core lo reconoce como partner |
| Rotación del secreto | `npm run cliente:rotar-secreto`, sin período de gracia; evento `CLIENTE_SECRETO_ROTADO` (migración 003) | Hacía falta cambiar el secreto sin cambiar el `client_id` (el de Booking es fijo). Sin gracia, porque dos hashes por cliente complican el modelo; se documenta la ventana y cómo rotar sin cortar (tener listo el secreto nuevo) |
| Migraciones monótonas | 001 y 002 reemplazan `ck_cliente_oauth_scopes` solo si el vigente no admite su scope | `migrar.sh` corre todas en cada despliegue: la 001 volvía a poner el CHECK de 7 scopes y fallaba con un cliente con `flights:ops`. Lo encontró la base local; CI lo prueba con un cliente de los ocho scopes |
| `X-Correlation-Id` | Formato: hasta 100 caracteres, `[A-Za-z0-9][A-Za-z0-9._:-]*`; inválido o repetido, uno nuevo `corr-<uuid>`; nunca rechaza la petición | El contrato solo fija el largo; el resto evita falsear un log JSON o una fila de auditoría (como el `X-Request-Id`). La cabecera vuelve en toda respuesta, también los errores de CORS y del parser |
| `ProblemDetails.correlation_id` | Se agrega en el filtro a todo error de `/identity/v1` | Lo pide el §6 del contrato v2. Los errores de `/oauth2/token` siguen en el formato de RFC 6749 (solo la cabecera) |
| Auditoría | Columna `id_correlacion` (migración 004), nula en las filas viejas | Reconstruir un proceso con una consulta por `id_correlacion`, como pide el §6 |
| El estándar del gateway | Copia tal cual de `traceparent.ts`, `atributos.ts`, `trazas.ts` y `metricas.ts`; `express.ts` reemplaza a `fastify.ts`; `TRACE_TRUST_INCOMING=true` por defecto (servicio interno) | Es lo que dice el estándar para un servicio NestJS interno |
| Contexto del span y el parser | Un segundo middleware reabre el contexto de OpenTelemetry después del parser del cuerpo, y `finish` y el filtro de errores lo reentran | El parser emite sus eventos fuera del contexto asíncrono (igual que pasa con el de la app): sin esto, los handlers corren sin span y el log de acceso sin `traceId` |
| Métricas propias | `identity_logins_total{result}` (`success`, `invalid_credentials`, `inactive_account`) e `identity_tokens_issued_total{type}` (`user_login`, `user_refresh`, `client_credentials`) | Lo pedido, con listas cerradas. Correo desconocido y contraseña errónea cuentan igual (`invalid_credentials`): la métrica no distingue lo que la respuesta tampoco distingue |
| `METRICS_PORT` | 9464 por defecto (contenedor); 9467 en `.env.example` (los cinco servicios en una máquina); un puerto ocupado avisa y no tumba el servicio | El estándar. Un servicio de identidad no debe caerse por su monitoreo |
| Versión | 0.3.0 | Agregados compatibles |

## Hallazgos

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| jose y KeyObject privado | `jwtVerify` rechaza un `KeyObject` privado para RS256 ("must be of type public"); todo token salía inválido | La ranura actual guarda la pública derivada de la privada (`fix(claves)`). Lo encontró la verificación con curl de `/auth/me` |
| jose 6 bajo Jest | Es solo ESM. Transformado con ts-jest y target es2021, TypeScript mueve los campos de clase antes del `super()` de sus errores (que va dentro de una expresión con comas) y `new JOSEError()` lanza "Must call super constructor". Además Jest guarda un transformador por ruta: no admite una segunda configuración de ts-jest | `test/utils/transformar-jose.js` pasa jose a CommonJS con `transpileModule` y target es2022. Si el core usa jose 6 con Jest, necesita lo mismo |
| `ConfigService.get` | Lee primero `process.env` y después la configuración que recibió: un `ConfigService` armado en una prueba devolvía las claves del entorno | `ClavesService.desdeValores(firma, anterior)` para la prueba de rotación |
| Logger global | El `Logger` de Nest es global en el proceso: una segunda app con `logger: false` apagaba los logs de la primera | En las pruebas, todas las apps de un archivo comparten el mismo destino de logs |
| PEM directo | Un PEM pegado sin base64 pasaba el filtro de base64 (el guion está en ese alfabeto) | Se detecta `-----BEGIN` antes y el mensaje lo dice |
| Emisor local en producción | Se comparaba `host` (con puerto) en vez de `hostname` | Corregido; lo encontró la prueba del entorno |
| Rutas inexistentes y el límite | Un 404 no pasa por los guards, así que no cuenta en el límite global (como en el core) | La prueba de la salud usa una ruta real para agotar el límite |
| Docker en esta máquina | El `docker build` no tiene salida a npm sin el proxy y la CA de este entorno | Se verificó con una variante local del Dockerfile que agrega el proxy y la CA (no está en el repo); el Dockerfile del repo se construye en CI |
| El exportador OTLP bajo Jest | `@opentelemetry/otlp-exporter-base` carga su transporte con `import('http')`, que la VM de Jest rechaza sin `--experimental-vm-modules`: los spans nunca salían y la prueba no veía nada | `transformar-jose.js` lo pasa a CommonJS, igual que el gateway. La causa se vio con `diag` de OpenTelemetry (el exportador falla en silencio) |
| `ConfigService` y el entorno de las pruebas | Da prioridad al entorno validado al importar `AppModule`: la prueba de métricas no podía cambiar `METRICS_PORT` | `crear-app` se carga con `import()` dinámico, después de fijar el puerto y el recolector |
| `GET /admin/users/{id}` | Responde 405 (la ruta existe con `DELETE`), y su métrica va a `__unmatched__` | La plantilla solo la tiene una ruta que atendió la petición; un 405 no la tiene, como en el estándar |
| La 0.2.0 sobre una base sin migrar | Arranca, pero cada fila de auditoría falla con P2022 (falta `actor_id`): el login sigue y el evento se pierde; un alta o una baja de `/admin/users` responde 500 | `docs/DEPLOY.md` pide correr `db/migrar.sh` antes de desplegar. Se comprobó levantando la 0.2.0 sobre una base con el esquema de la 0.1.0 |
| `PATCH`/`PUT`/`GET /admin/users/{id}` | Responden 405 (la ruta existe con `DELETE`), como en el core, que tiene el mismo `traducir-excepcion.ts` | La respuesta es idéntica a la del core |
| La prueba del último administrador | Se omite (con aviso) si hay un administrador fuera de las pruebas, como en el core. En una base local con `SEED_ADMIN_PASSWORD` no corre | Corre en CI (la semilla va sin administrador). La mutación `ultimo-admin` se comprueba con `DATABASE_URL` de una base así |
| `npm audit` | Las dependencias de producción de Nest 10 traen avisos (`@nestjs/core`, `body-parser`, `multer`, `qs`, `lodash`, `file-type`) | Los mismos que el core; el arreglo es Nest 11 (ver Pendientes). El servicio no usa multipart y fija el límite del cuerpo |

## Pendientes

- [ ] Dueño del repo: revisar y fusionar el pull request de `feat/v2-partner`.
- [ ] Al desplegar la 0.3.0: correr `./db/migrar.sh` contra la base antes de la imagen nueva (002 a
      004; sin la 004 la auditoría no puede escribir).
- [ ] Producción: crear el cliente de Booking (comando en `docs/PARTNER-BOOKING.md`) y entregarle
      el secreto por el gestor de secretos, no por chat.
- [ ] Gateway: confirmar que publique `/api/v2/oauth2/token` (hoy expone `/oauth2/token`); si no,
      Booking pide el token directo a identity.
- [ ] Core (fase del contrato v2): exigir `flights:ops` en las operaciones de aeropuerto y
      reconocer al partner por el `client_id` del token.
- [ ] Exponer `METRICS_PORT` solo a la red interna (el ingress nunca) y apuntar Prometheus a
      `quinde-identity`.
- [ ] Fase 4b (core): verificar con el JWKS de este servicio (ver `docs/DEPLOY.md`, "Lo que
      necesita el core"), quitar `src/modules/auth` del core (y `JWT_SECRET`) y decidir qué pasa
      con las cuentas que hoy viven en `vuelos.usuario` (migrarlas a `identidad.usuario` con su
      mismo uuid, para no romper `id_propietario`). `/admin/users` ya está aquí.
- [ ] Backoffice: mandar `/auth/*` y `/admin/users` a la URL de este servicio (ver
      `docs/DEPLOY.md`, "Lo que cambia para el backoffice") y agregar su origen a
      `CORS_ORIGINS`.
- [ ] Core: cuando publique eventos, sumar `events:publish` a su tabla de scopes y pedir un
      cliente con `cliente:crear --permitir-eventos`.
- [ ] Fase 4b (frontend): cambiar la URL de `/flights/v1/auth` por `/identity/v1/auth`.
- [ ] Despliegue en Azure (fase posterior): imagen, base, `JWT_SIGNING_KEY` en el gestor de
      secretos, `JWT_ISSUER` con el dominio https, `TRUST_PROXY` según el balanceador.
- [ ] Administración de clientes: no hay herramienta para dar de baja un cliente ni para cambiar
      su secreto (hoy es SQL, ver `docs/DEPLOY.md`). De personas: cambiar un rol o reactivar a
      un administrador sigue siendo SQL, como en el core.
- [ ] Límite conocido: la baja de un administrador no corta su token de acceso vigente (15
      minutos), como en el core.
- [ ] Límite conocido: quien conoce un `client_id` puede agotar su cupo de 10 por minuto (el
      cliente legítimo recibe 429 ese minuto). Si molesta, contar solo los intentos fallidos.
- [ ] Límite conocido: el rechazo por el límite por IP (el guard) no queda en
      `auditoria_seguridad` (sí en el log de acceso); el límite por cliente sí
      (`LIMITE_EXCEDIDO`).
- [ ] Límite conocido: un token de acceso sigue sirviendo hasta que vence (15 minutos) aunque se
      haga logout o se desactive la cuenta (como en el core).
- [ ] Límite conocido: dos refresh simultáneos con el mismo token cuentan como reuso y cierran la
      sesión (como en el core).
- [ ] Purgar los `token_refresco` vencidos con una tarea programada (y recién entonces
      agregarlo a `TABLAS_CON_BORRADO_FISICO`).
- [ ] Planificar Nest 11 para los avisos de `npm audit` (en una rama aparte, con la suite
      completa), igual que en el core.
- [ ] La suite se corrió con PostgreSQL 16 en esta máquina; CI usa PostgreSQL 18.
