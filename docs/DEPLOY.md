# Despliegue — Quinde · Identity

Guía para levantar el servicio fuera de la máquina de desarrollo. No hay `render.yaml` ni
configuración de una nube: el despliegue a Azure es una fase posterior. Lo que sigue vale para
cualquier lugar que corra un contenedor y tenga un PostgreSQL.

## Qué se despliega

- **Una imagen de Docker** (`Dockerfile`, multi-etapa). Corre como el usuario `node` (uid 1000),
  sin privilegios y sin poder escribir en su propio código. No lleva claves ni credenciales:
  todo llega por variables de entorno.
- **Un PostgreSQL** con el esquema `identidad` (`db/esquema_identidad.sql` en una base nueva;
  `db/migrar.sh` en una que ya existe, ver "Migraciones").
- **Rutas de salud**, públicas y sin límite de peticiones:
  - `GET /identity/v1/health`: el proceso responde (no mira la base). Para reiniciar un
    contenedor colgado. Es la del `HEALTHCHECK` de la imagen.
  - `GET /identity/v1/health/ready`: 200 solo si la base contesta (503 si no). Para sacar la
    instancia del balanceador mientras la base no responde.

```bash
docker build -t quinde-identity .
docker run --rm -p 3001:3001 --env-file .env.produccion quinde-identity
```

## Variables de entorno

El servicio valida el entorno al arrancar: si una obligatoria falta o tiene un formato inválido,
no levanta y el error nombra la variable (nunca muestra su valor). Una variable vacía
(`JWT_PREVIOUS_PUBLIC_KEY=`) cuenta como no definida.

| Variable | Obligatoria | Ejemplo | Qué pasa si falta |
| --- | --- | --- | --- |
| `DATABASE_URL` | Sí | `postgresql://identity:***@host:5432/identity_db?schema=identidad&sslmode=require` | No arranca. `?schema=` elige el esquema (por defecto `identidad`) |
| `NODE_ENV` | Sí | `production` | No arranca. En `production` los logs no llevan `debug` y `JWT_ISSUER` tiene que ser https |
| `PORT` | Sí | `3001` | No arranca |
| `JWT_ISSUER` | Sí | `https://identity.quinde.example` | No arranca. Es el `iss` de los tokens y la base del descubrimiento: el origen público del servicio, sin ruta ni barra final. https en producción (salvo `localhost`) |
| `JWT_SIGNING_KEY` | Sí | salida de `npm run keys:generate` | No arranca. Tampoco si no es RSA, tiene menos de 2048 bits, es una pública o es el PEM sin base64 |
| `JWT_PREVIOUS_PUBLIC_KEY` | No | la pública del par anterior | Solo existe la clave actual: los tokens firmados con otra no verifican. Se usa durante una rotación |
| `JWT_AUDIENCE` | No | `quinde-vuelos-api` | Vale `quinde-vuelos-api`, el `aud` que el core ya acepta |
| `CORS_ORIGINS` | No | `https://quinde.example.com,http://localhost:5173` | Ningún origen de navegador puede llamar. Nunca `*` (no arranca). Tiene que incluir el origen del frontend y el del backoffice (este da de baja administradores con `DELETE` desde el navegador) |
| `TRUST_PROXY` | No | `1` | Se usa la IP del socket: detrás de un balanceador, todos los clientes comparten el límite por IP y la auditoría guarda la IP del balanceador. `true` no se acepta |
| `RATE_LIMIT_MAX` | No | `100` | 100 peticiones por IP y por ventana en todo el servicio |
| `RATE_LIMIT_WINDOW_SECONDS` | No | `60` | 60 segundos |
| `METRICS_PORT` | No | `9464` (contenedor), `9467` (los cinco servicios en una máquina) | `9464`. Puerto aparte de `GET /metrics` (Prometheus), que el ingress **nunca** expone; `0` lo apaga. Un puerto ocupado no tumba el servicio: avisa y sigue sin métricas |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://jaeger:4318` | No se exportan trazas. Igual hay `X-Trace-Id` y `traceId` en los logs. Los spans salen a `{endpoint}/v1/traces` en lotes cada 2 s; un recolector caído o lento nunca retrasa una petición |
| `OTEL_TRACES_SAMPLER_ARG` | No | `0.1` | 1 en desarrollo, 0.1 en producción: fracción de trazas raíz que se registran (0 a 1) |
| `TRACE_TRUST_INCOMING` | No | `true` | `true`: continúa el `traceparent` del gateway (identity es interno). Solo `true` o `false` |
| `OTEL_SERVICE_NAME` | No | `quinde-identity` | `quinde-identity` |
| `OTEL_BSP_SCHEDULE_DELAY` | No | `2000` | 2000 ms entre lotes de spans. Existe para las pruebas |
| `SEED_ADMIN_EMAIL` | No (solo `db/reset.sh`) | `admin@quinde.example` | `admin@quinde.example` |
| `SEED_ADMIN_PASSWORD` | No (solo `db/reset.sh`) | 12 a 128 caracteres | No se crea el administrador inicial |
| `DB_PORT` | No (solo `docker-compose.yml`) | `5433` | 5433 |

Los límites propios (`/auth/login` 5 por minuto e IP, `/auth/register` 10 cada 10 minutos,
`/auth/refresh` 30 por minuto, `/oauth2/token` 20 por minuto e IP y 10 por minuto y client_id)
están en el código, no en el entorno.

## Claves de firma

### Generar

```bash
npm run keys:generate                 # 2048 bits
npm run keys:generate -- --bits 3072
```

Imprime `JWT_SIGNING_KEY=<PEM PKCS#8 en base64>` y, comentada, la pública del mismo par (la que
irá en `JWT_PREVIOUS_PUBLIC_KEY` cuando este par deje de firmar). No escribe archivos: la salida
va de la terminal al gestor de secretos del entorno. Reglas:

- La privada nunca va a git, a un log, a la base ni a un chat. El servicio no la registra: solo
  anota el `kid` (la huella pública, RFC 7638).
- Una clave por entorno (desarrollo, pruebas, producción); nunca la misma.
- El `kid` sale de la clave: no hay otra variable que mantener.

### Rotar (sin cortar sesiones)

Un token de acceso dura 15 minutos y un consumidor guarda el JWKS hasta 5 minutos
(`Cache-Control: public, max-age=300`). Por eso la clave anterior se deja publicada al menos
20 minutos después de cambiarla.

1. Generar un par nuevo (B) con `npm run keys:generate`.
2. Desplegar con `JWT_SIGNING_KEY` = privada de B y `JWT_PREVIOUS_PUBLIC_KEY` = pública de A
   (la línea comentada que imprimió `keys:generate` cuando se generó A). Si no se guardó, sale
   de la privada de A:

   ```bash
   printf '%s' "$CLAVE_A_BASE64" | base64 -d | openssl pkey -pubout | base64 -w0
   ```
3. Comprobar que `GET /.well-known/jwks.json` publica dos claves.
4. Esperar al menos 20 minutos (15 de vida del último token firmado con A, más 5 de caché).
5. Desplegar sin `JWT_PREVIOUS_PUBLIC_KEY`. El JWKS vuelve a tener una clave. Destruir la
   privada de A.

Los tokens de refresco no dependen de la clave (son opacos y viven en la base): rotar no cierra
ninguna sesión.

### Rotación de emergencia (la privada se filtró)

Desplegar enseguida con un par nuevo y **sin** `JWT_PREVIOUS_PUBLIC_KEY`. Todo token de acceso
vigente deja de verificar en cuanto los consumidores renuevan el JWKS (a lo sumo 5 minutos); las
personas siguen con su refresh y los clientes piden otro token. Revisar `auditoria_seguridad` del
período.

## Base de datos

El esquema `identidad` no apunta a ninguna tabla de vuelos ni al revés: puede vivir en una base
propia o en la misma base del core.

### Opción A (por defecto): base aparte

Una base `identity_db` (en Neon, otra base del mismo proyecto; en local, el `docker-compose.yml`
de este repo, en el puerto 5433). Separa las credenciales: quien tenga la de la base del core no
puede leer hashes de contraseñas, y cada base se respalda y se restaura por su cuenta.

```bash
DATABASE_URL="postgresql://...@host/identity_db?schema=identidad&sslmode=require" \
  CONFIRMAR_RESET=si ./db/reset.sh          # solo la primera vez: crea el esquema y la semilla
```

### Opción B: la misma base del core, otro esquema

Más barato (una sola base) y suficiente para el curso. Conviene un usuario de base solo para
este servicio, sin permisos sobre el esquema `vuelos` (como superusuario, una vez; el `REVOKE`
deja explícito lo que ya es el valor por defecto):

```sql
CREATE ROLE quinde_identity LOGIN PASSWORD '...';
CREATE SCHEMA identidad AUTHORIZATION quinde_identity;
REVOKE ALL ON SCHEMA vuelos FROM quinde_identity;
```

y cargar `db/esquema_identidad.sql` y `db/semilla_identidad.sql` con ese usuario.
`DATABASE_URL` lleva `?schema=identidad`.

**`db/reset.sh` borra solo el esquema `identidad`, nunca la base.** Contra un host que no es
local exige `CONFIRMAR_RESET=si`, porque borra cuentas reales. Sin `psql` en el PATH usa el del
contenedor de `docker-compose.yml`.

No se usa `prisma migrate`: la base nace de `db/*.sql` y Prisma solo introspecciona
(`npm run prisma:pull`).

### Migraciones

Una base nueva sale de `db/reset.sh` con el esquema al día. Una que ya existe (la de la versión
0.1.0, con cuentas reales) se pone al día con `db/migrar.sh`, que corre `db/migraciones/*.sql` en
orden. Las migraciones solo agregan y son idempotentes: correr `migrar.sh` dos veces deja la base
igual, por eso no pide confirmación. CI migra una base con el esquema de la 0.1.0 dos veces y
exige que `pg_dump` la vea igual a una nueva.

```bash
DATABASE_URL="postgresql://...@host/identity_db?schema=identidad&sslmode=require" ./db/migrar.sh
```

**0.1.0 → 0.2.0** (`001_admin_usuarios_y_events_publish.sql`). Correr la migración **antes** de
desplegar la imagen 0.2.0: la 0.2.0 escribe `actor_id` en cada fila de auditoría y, sin la
columna, un alta o una baja de `/admin/users` falla (500) y los demás eventos no se registran. La
0.1.0 sigue funcionando con la base ya migrada, así que el orden es seguro:

1. `./db/migrar.sh` contra la base.
2. Desplegar la imagen 0.2.0.

Qué cambia:

- `evento_seguridad` suma `ADMINISTRADOR_CREADO` y `ADMINISTRADOR_DADO_DE_BAJA`.
- `auditoria_seguridad` suma `actor_id uuid` (FK a `usuario`, índice parcial).
- El CHECK `ck_cliente_oauth_scopes` se reemplaza por uno que admite `events:publish` (hasta 7
  scopes). Es un `DROP CONSTRAINT IF EXISTS` y un `ADD CONSTRAINT` en la misma transacción: las
  filas existentes ya cumplen el nuevo, que solo amplía la lista. Sin este cambio,
  `cliente:crear --permitir-eventos` falla con `violates check constraint`.

**0.2.0 → 0.3.0** (`002_flights_ops.sql`, `003_cliente_secreto_rotado.sql` y
`004_auditoria_correlacion.sql`). Mismo orden: `./db/migrar.sh` y después la imagen. Correr la
migración **antes** importa más que en la 0.2.0: la 0.3.0 escribe `id_correlacion` en cada fila de
auditoría y, sin la columna, **todo** evento de seguridad falla al registrarse (login, refresh,
token; la petición sigue, pero se pierde el rastro). Qué cambia:

- `ck_cliente_oauth_scopes` admite `flights:ops` (hasta 8 scopes). Solo amplía la lista.
- `evento_seguridad` suma `CLIENTE_SECRETO_ROTADO`.
- `auditoria_seguridad` suma `id_correlacion text` (con su CHECK e índice parcial; nula en las
  filas viejas).

`migrar.sh` corre **todas** las migraciones en cada despliegue. Por eso las que reemplazan el CHECK
de los scopes (001 y 002) lo hacen solo si el vigente no admite ya su scope: una base con un
cliente que tiene `flights:ops` no puede volver a un CHECK más estrecho.

Para comprobarlo:

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_cliente_oauth_scopes';
SELECT unnest(enum_range(NULL::identidad.evento_seguridad));
```

## Clientes OAuth (client_credentials)

No hay endpoint para crearlos. Se crean con la herramienta, que imprime el secreto **una sola
vez** (en la base queda su hash argon2id):

```bash
npm run cliente:crear -- --nombre "Agencia Andina" --scopes "flights:read flights:hold"
npm run cliente:crear -- --nombre "Batch de catálogo" --scopes "flights:admin" --permitir-admin
npm run cliente:crear -- --nombre "Core eventos" --scopes "events:publish" --permitir-eventos

# dentro del contenedor desplegado
docker exec -it <contenedor> node dist/cli/crear-cliente.js --nombre "..." --scopes "..."
```

- `flights:ops` (operaciones de aeropuerto del contrato v2) exige `--permitir-ops`, y también solo
  sale si se pide.
- El partner Booking Prototipo no lleva ninguna bandera `--permitir-*`: su cliente, su token y la
  rotación de su secreto están en [`PARTNER-BOOKING.md`](PARTNER-BOOKING.md).
- `flights:admin` exige `--permitir-admin`, y aun así el cliente solo lo recibe si lo pide en
  el `scope` de cada token.
- `events:publish` (publicar eventos; es el del core cuando publique) exige `--permitir-eventos`
  y, igual, solo sale si se pide (`scope=events:publish`). Ningún rol de persona lo tiene.
- Dar de baja un cliente (no hay herramienta todavía; ver Pendientes en `docs/PLAN.md`):
  `UPDATE identidad.cliente_oauth SET activo = false WHERE codigo = '...';`
- Cambiar un secreto: crear un cliente nuevo, pasarle el secreto al sistema que lo usa y dar de
  baja el viejo.

## Observabilidad

Identity sigue el estándar de los cinco servicios (`docs/OBSERVABILIDAD.md` del repo
`gateway_vuelos`): `service.name` = `quinde-identity`.

- **Trazas.** El SDK siempre arranca: cada respuesta lleva `X-Trace-Id` y cada línea de log, su
  `traceId`. Los spans solo se exportan con `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP, en lotes). Un
  recolector caído o lento nunca retrasa una petición. Detrás del gateway, `TRACE_TRUST_INCOMING`
  queda en `true` (por defecto) para continuar su traza; si identity fuera alcanzable sin pasar
  por el gateway, ponerlo en `false`.
- **Métricas.** `GET /metrics` en `METRICS_PORT` (9464 en un contenedor), **un puerto aparte que
  el ingress nunca debe exponer**. En el puerto público no existe. Además de las comunes:
  `identity_logins_total{result}` (`success`, `invalid_credentials`, `inactive_account`) e
  `identity_tokens_issued_total{type}` (`user_login`, `user_refresh`, `client_credentials`).
- **X-Correlation-Id.** Viaja en la cabecera de la petición y de la respuesta, en
  `ProblemDetails.correlation_id`, en cada línea de log (`correlationId`) y en
  `auditoria_seguridad.id_correlacion`. Para reconstruir un proceso:
  `SELECT fecha_evento, evento, resultado FROM identidad.auditoria_seguridad WHERE id_correlacion = 'corr-123' ORDER BY id;`
  (el rastro completo está en los logs y en la auditoría de cada servicio con ese mismo id).

## Verificación después de desplegar

```bash
BASE=https://identity.quinde.example
curl -s $BASE/identity/v1/health/ready                       # 200, database UP
curl -s $BASE/.well-known/openid-configuration               # issuer = JWT_ISSUER
curl -s -i $BASE/.well-known/jwks.json | grep -i cache       # public, max-age=300
curl -s -X POST $BASE/identity/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@quinde.example","password":"..."}'     # access_token, refresh_token
curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials $BASE/oauth2/token
curl -s "$BASE/identity/v1/admin/users?limit=5" -H "Authorization: Bearer $ACCESS_TOKEN_ADMIN"
curl -s $BASE/.well-known/openid-configuration | grep -o events:publish   # scopes_supported
```

## Lo que necesita el core (fase 4b)

| Dato | Valor |
| --- | --- |
| `issuer` | `JWT_ISSUER` de este servicio (por ejemplo `https://identity.quinde.example`). Compararlo texto a texto |
| `audience` | `quinde-vuelos-api` (`JWT_AUDIENCE`), el mismo `aud` que el core ya acepta |
| JWKS | `{issuer}/.well-known/jwks.json` (también en `jwks_uri` del descubrimiento) |
| Algoritmo | Solo `RS256`; elegir la clave por el `kid` de la cabecera; exigir `typ` `at+jwt` |
| Caché del JWKS | `Cache-Control: public, max-age=300`. Con jose: `createRemoteJWKSet(url)` ya cachea y vuelve a bajar el JWKS cuando llega un `kid` desconocido |
| Claims obligatorios | `iss`, `sub`, `aud`, `exp`, `iat`, `jti`, `scope` |
| `sub` | Un uuid: `usuario.id` (persona) o `cliente_oauth.id` (cliente). Sigue siendo el `id_propietario` de retenciones, reservas y webhooks |
| `client_id` | Solo en tokens de clientes (client_credentials). Sin él, el token es de una persona |
| `scope` | Separado por espacios. Los 7 de `PartnerOAuth2` del contrato v2 (`flights:read`, `hold`, `book`, `cancel`, `webhooks`, `ops` y `admin`) y `events:publish`, que solo llevan los tokens de clientes |

## Lo que cambia para el backoffice (administradores)

`/identity/v1/admin/users` es `/flights/v1/admin/users` del core con otra base: los mismos
sufijos (`/admin/users`, `/admin/users/{id}`), métodos, cabeceras (`Authorization: Bearer`,
`Content-Type: application/json`), cuerpos, status y ProblemDetails. El backoffice manda a este
servicio el login (`/auth/*`) y los administradores, y deja en el core lo demás (catálogo,
auditoría y reservas):

| Llamada del backoffice | Antes | Ahora |
| --- | --- | --- |
| `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me` | `{core}/flights/v1` | `{identity}/identity/v1` |
| `/admin/users` (listar, crear, dar de baja) | `{core}/flights/v1` | `{identity}/identity/v1` |
| Catálogo, `/admin/audit-log`, `/admin/bookings` | `{core}/flights/v1` | Sin cambio (el core tiene que aceptar los tokens RS256 de este servicio: fase 4b) |

Diferencias visibles: el `realm` de `WWW-Authenticate` es `quinde-identity`, y el alta y la baja
de un administrador quedan en `identidad.auditoria_seguridad` (no en el `/admin/audit-log` del
core). Este servicio necesita el origen del backoffice en `CORS_ORIGINS`.
