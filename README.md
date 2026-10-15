# Quinde · Identity

Proveedor de identidad del sistema de vuelos Quinde. Separa la identidad del core
([backend_vuelos](https://github.com/chuchobck/backend_vuelos)), que hasta ahora emitía sus
propios JWT HS256: aquí se emiten tokens de acceso **RS256** y el core los verifica con las
claves públicas que este servicio publica, sin compartir ningún secreto.

- **Personas**: `POST /identity/v1/auth/register`, `/login`, `/refresh`, `/logout` y
  `GET /identity/v1/auth/me`, con la misma forma que `/flights/v1/auth` del core (para el
  frontend, cambiar de servicio es cambiar la URL).
- **Sistemas** (máquina a máquina): `POST /oauth2/token` con `grant_type=client_credentials`
  (RFC 6749, sección 4.4).
- **Descubrimiento**: `GET /.well-known/jwks.json` y `GET /.well-known/openid-configuration`.
- **Salud**: `GET /identity/v1/health` y `/identity/v1/health/ready`.
- **Documentación**: Swagger en `/api/docs`; el contrato en
  [`contracts/identity-openapi.json`](contracts/identity-openapi.json).

NestJS 10, TypeScript estricto, Prisma 7 sobre PostgreSQL (esquema `identidad`), `jose` para
firmar y argon2id para contraseñas y secretos. Las reglas del proyecto están en
[`CLAUDE.md`](CLAUDE.md), el plan y las decisiones en [`docs/PLAN.md`](docs/PLAN.md) y el
despliegue en [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Los tokens

```text
cabecera  { "alg": "RS256", "typ": "at+jwt", "kid": "<huella SHA-256 de la clave>" }
claims    iss  JWT_ISSUER (https://identity.quinde.example)
          sub  uuid: usuario.id (persona) o cliente_oauth.id (cliente)
          aud  quinde-vuelos-api
          exp  iat + 900 (15 minutos)
          iat, jti (uuid)
          scope      "flights:read flights:hold ..." (separados por espacio)
          client_id  solo en el token de un cliente
```

El refresh token de las personas es opaco (256 bits, guardado como SHA-256), dura 7 días y se
rota en cada uso; reusar uno rotado revoca toda la sesión. Los clientes no reciben refresh
token: piden otro cuando el suyo vence.

## Empezar en local

Requisitos: Node 22 (`.nvmrc`) y Docker (o un PostgreSQL propio).

```bash
npm ci
cp .env.example .env
npm run --silent keys:generate                 # pega JWT_SIGNING_KEY en el .env
docker compose up -d                           # PostgreSQL 18 en el puerto 5433
./db/reset.sh                                  # esquema identidad + roles (+ admin si hay SEED_ADMIN_PASSWORD)
npm run start:dev                              # http://localhost:3001
```

Un recorrido con `curl`:

```bash
B=http://localhost:3001/identity/v1/auth
curl -s -X POST $B/register -H 'Content-Type: application/json' \
  -d '{"email":"ana@correo.ec","password":"una frase larga y fácil de recordar"}'
curl -s -X POST $B/login -H 'Content-Type: application/json' \
  -d '{"email":"ana@correo.ec","password":"una frase larga y fácil de recordar"}'
curl -s $B/me -H "Authorization: Bearer $ACCESS_TOKEN"

npm run cliente:crear -- --nombre "Agencia Andina" --scopes "flights:read flights:hold"
curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials \
  http://localhost:3001/oauth2/token

curl -s http://localhost:3001/.well-known/jwks.json
```

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run start:dev` | El servicio con recarga |
| `npm run build` / `npm run start:prod` | Compilar y correr `dist/` |
| `npm run lint`, `format:check`, `typecheck` | Calidad (lo mismo que CI) |
| `npm test` | Suite e2e contra PostgreSQL (necesita la base del `.env` o `DATABASE_URL`) |
| `npm run test:mutaciones` | Rompe el código a propósito (25 mutaciones) y exige que alguna prueba falle |
| `npm run keys:generate` | Imprime un par RSA nuevo para `JWT_SIGNING_KEY` |
| `npm run cliente:crear -- --nombre ... --scopes ...` | Crea un cliente OAuth e imprime su secreto una sola vez |
| `npm run openapi:export` | Regenera `contracts/identity-openapi.json` |
| `./db/reset.sh` | Borra y recrea el esquema `identidad` (nunca la base) |

## Estructura

```text
src/
  modules/
    auth/            personas: registro, login, refresh, logout, perfil; scopes por rol
    oauth2/          /oauth2/token (client_credentials) y alta de clientes
    claves/          claves RSA en dos ranuras, firma y verificación (TokensService)
    descubrimiento/  /.well-known/jwks.json y openid-configuration
    auditoria/       auditoria_seguridad
    salud/           /health y /health/ready
  common/            contexto y X-Request-Id, errores, logs JSON, límites, guard de token
  config/            entorno validado, seguridad HTTP, Swagger
  cli/               keys:generate, cliente:crear, openapi:export
db/                  esquema_identidad.sql, semilla, reset.sh
test/                e2e (verificador independiente, ataques, rotación, auditoría...)
```
