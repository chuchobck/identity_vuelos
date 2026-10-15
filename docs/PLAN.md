# Plan — Quinde · Identity

Actualizado: 2026-10-15 (cierre de la fase 4a) · Este archivo se actualiza al cerrar cada fase.

El Reto 2 separa la identidad del core de vuelos. Hasta ahora el core
([backend_vuelos](https://github.com/chuchobck/backend_vuelos)) emitía sus propios JWT HS256 en
`src/modules/auth`, un proveedor de identidad simulado que su `docs/PLAN.md` prometía cambiar
"por el proveedor real" en RDA2. Este servicio es ese proveedor.

## Avance

| Fase | Estado | Verificado |
| --- | --- | --- |
| 4a. Servicio de identidad | Hecha en la rama `feat/r2-identity` (2026-10-15); falta la revisión y el merge | Cada commit pasa `lint`, `format:check` y `build` (y `typecheck` desde que existe). `npm test`: 105 pruebas en 9 archivos contra PostgreSQL 16 local, también sobre una base recién cargada como en CI. `npm run test:mutaciones`: 25 de 25 mutaciones detectadas. Con `curl` contra el servicio compilado: register → login → me, refresh, reuso (401 y familia revocada), client_credentials (200 y 401 con `WWW-Authenticate`), JWKS con `Cache-Control: public, max-age=300` y los dos tokens decodificados. La imagen de Docker construye, corre como uid 1000, no puede escribir en `/app/dist`, queda `healthy` y `crear-cliente` funciona dentro |
| 4b. El core verifica con el JWKS | Pendiente (otra fase, en backend_vuelos) | — |
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
| Fuera | — | `/admin/users`, `ScopesGuard` y todo lo de vuelos: este servicio no tiene rutas con `@Scopes` |

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
| `npm audit` | Las dependencias de producción de Nest 10 traen avisos (`@nestjs/core`, `body-parser`, `multer`, `qs`, `lodash`, `file-type`) | Los mismos que el core; el arreglo es Nest 11 (ver Pendientes). El servicio no usa multipart y fija el límite del cuerpo |

## Pendientes

- [ ] Dueño del repo: revisar y fusionar el pull request de `feat/r2-identity`.
- [ ] Fase 4b (core): verificar con el JWKS de este servicio (ver `docs/DEPLOY.md`, "Lo que
      necesita el core"), quitar `src/modules/auth` del core (y `JWT_SECRET`), mover
      `/admin/users` a este servicio o a una herramienta, y decidir qué pasa con las cuentas que
      hoy viven en `vuelos.usuario` (migrarlas a `identidad.usuario` con su mismo uuid, para no
      romper `id_propietario`).
- [ ] Fase 4b (frontend): cambiar la URL de `/flights/v1/auth` por `/identity/v1/auth`.
- [ ] Despliegue en Azure (fase posterior): imagen, base, `JWT_SIGNING_KEY` en el gestor de
      secretos, `JWT_ISSUER` con el dominio https, `TRUST_PROXY` según el balanceador.
- [ ] Administración de clientes: no hay herramienta para dar de baja un cliente ni para cambiar
      su secreto (hoy es SQL, ver `docs/DEPLOY.md`), ni para administrar personas y roles.
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
