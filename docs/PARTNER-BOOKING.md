# Partner: Booking Prototipo

En el contrato v2 (`PartnerOAuth2`, `contracts/vuelos-openapi-v2.yaml` del core), **Booking Prototipo
es el partner** de la aerolínea: su backend pide aquí un token de servicio (`client_credentials`) y
lo manda al core en cada llamada, con el usuario final en `X-User-Id`. Este documento es la guía
para crear su cliente, pedir el token y rotar el secreto.

## 1. Crear el cliente

Una sola vez por entorno, con acceso a la base (`DATABASE_URL`):

```bash
npm run cliente:crear -- \
  --nombre "Booking Prototipo" \
  --client-id booking-prototipo \
  --scopes "flights:read flights:hold flights:book flights:cancel flights:webhooks"
```

Dentro de la imagen desplegada:

```bash
docker exec -it <contenedor> node dist/cli/crear-cliente.js \
  --nombre "Booking Prototipo" \
  --client-id booking-prototipo \
  --scopes "flights:read flights:hold flights:book flights:cancel flights:webhooks"
```

- **Sin ninguna bandera `--permitir-*`**: así Booking no puede tener `flights:admin`, `flights:ops`
  ni `events:publish`. La herramienta rechaza el alta si se los incluye sin la bandera, y la base lo
  limita a la lista de scopes que existen.
- Imprime el `client_secret` **una sola vez**. Va al gestor de secretos de Booking (la variable que
  use su backend); nunca a git, a un chat ni a un log. En la base queda solo su hash argon2id.
- Si el `client_id` ya existe, falla (`Ya existe un cliente con ese --client-id`): no pisa nada.

Los cinco scopes son los del contrato v2 que usa un partner: leer, bloquear inventario, reservar y
postventa, cancelar y gestionar webhooks. `flights:ops` (operaciones de aeropuerto) y
`flights:admin` (administración del acuerdo) no son suyos.

## 2. Pedir el token

```bash
curl -s -u "booking-prototipo:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  https://<identity>/oauth2/token
```

`POST /oauth2/token`, `application/x-www-form-urlencoded`, con `Authorization: Basic` (el
`client_id` y el secreto codificados en el formulario, RFC 6749 §2.3.1). También se acepta
`client_id` y `client_secret` en el cuerpo, pero no los dos métodos a la vez.

- **Por el gateway**: `POST /api/v2/oauth2/token`, con el mismo formulario y la misma cabecera. El
  gateway lo manda a este servicio como pública con límite estricto. **Nota:** el gateway de `main`
  expone hoy `/oauth2/token` (su `docs/RUTAS.md`); el prefijo `/api/v2` es el de la ruta del
  contrato v2 y hay que confirmar que el gateway lo publique antes de entregárselo a Booking.
- **Sin `scope`**, recibe sus cinco scopes. Con `scope`, un subconjunto
  (`scope=flights:read flights:book`). Pedir `events:publish`, `flights:admin` o `flights:ops`
  responde `400 invalid_scope`: no se le da un subconjunto en silencio.
- Respuesta: `{ "access_token": "...", "token_type": "Bearer", "expires_in": 900, "scope": "..." }`.
  Sin `refresh_token`: cuando vence, se pide otro.

## 3. Qué trae el token

JWT RS256 (`typ: at+jwt`), verificable con `/.well-known/jwks.json`:

| Claim | Valor |
| --- | --- |
| `iss` / `aud` | `JWT_ISSUER` / `quinde-vuelos-api` |
| `sub` | el uuid del cliente (`cliente_oauth.id`) |
| `client_id` | `booking-prototipo` |
| `scope` | `flights:read flights:hold flights:book flights:cancel flights:webhooks` (o el subconjunto pedido) |
| `exp` | **15 minutos** después de `iat` |

**`client_id` es lo que distingue a un partner.** Un token de persona nunca lo lleva; uno de cliente
máquina a máquina siempre. Así el core lo reconoce como partner y confía en el `X-User-Id` que Booking
reenvía. Por la misma razón, el token de un cliente **no entra** a las rutas de este servicio que son
de personas (`/identity/v1/auth/me`, `/identity/v1/admin/users`): responde 401.

Booking debería guardar el token y reutilizarlo hasta unos 60 segundos antes de que venza, y no pedir
uno por llamada: `/oauth2/token` tiene un límite de 20 peticiones por minuto e IP y 10 por minuto
por `client_id` (un 429 trae `Retry-After`).

## 4. Rotar el secreto

El `client_id` no cambia, así que Booking solo cambia su variable de entorno.

```bash
npm run cliente:rotar-secreto -- --client-id booking-prototipo
# en la imagen: node dist/cli/rotar-secreto-cliente.js --client-id booking-prototipo
```

Imprime el secreto nuevo una sola vez. Qué pasa:

- **El secreto anterior deja de servir en el acto.** No hay un periodo de gracia: entre la rotación y
  el despliegue del secreto nuevo en Booking, su próximo `POST /oauth2/token` responde 401
  `invalid_client`. Por eso: ten el secreto nuevo listo para pegarlo en el gestor de secretos de
  Booking en el mismo momento, y rota en una hora de poco tráfico.
- **Los tokens ya emitidos siguen valiendo** hasta que vencen (15 minutos): las llamadas en curso no
  se cortan.
- El `sub`, el `client_id` y los scopes no cambian. La rotación deja el evento
  `CLIENTE_SECRETO_ROTADO` en `auditoria_seguridad`, con el cliente y sin el secreto.
- Un cliente desconocido o dado de baja no se rota (`--client-id no es un cliente activo`).

Cuándo: cada 90 días, cuando alguien con acceso al secreto deja el equipo, y de inmediato si se
filtra. Si se filtra, además hay que revisar `auditoria_seguridad` (`TOKEN_CLIENTE`) de ese cliente.
Si hace falta cortar el acceso de Booking del todo, se da de baja el cliente:
`UPDATE identidad.cliente_oauth SET activo = false WHERE codigo = 'booking-prototipo';`
(sus tokens vigentes valen hasta 15 minutos más).
