# src/observabilidad

El estándar de observabilidad de Quinde (`docs/OBSERVABILIDAD.md` del repo `gateway_vuelos`)
aplicado a identity. Cuatro archivos son **copia tal cual** de `src/observabilidad/` del gateway
y no se editan aquí: un cambio se hace allá primero.

| Archivo | Qué hace |
| --- | --- |
| `traceparent.ts`, `atributos.ts`, `trazas.ts`, `metricas.ts` | Copia del gateway: W3C Trace Context estricto, lista cerrada de atributos, el SDK de trazas (siempre arranca; exportador OTLP opcional) y las métricas comunes en un `Registry` propio |
| `express.ts` | El equivalente de `fastify.ts` del gateway: el span `SERVER` por petición (nombre `METHOD /plantilla`), `X-Trace-Id` y las métricas del servidor. Dos middlewares: el primero tras el request id y otro después del parser del cuerpo, que reabre el contexto del span |
| `observacion.ts` | Dónde se guarda el span de la petición, para reabrir su contexto desde `finish` o el filtro de errores (líneas de log con `traceId`) |
| `observabilidad.service.ts` | Los spans `INTERNAL` (`auth.login`, `auth.refresh`, `oauth2.token`) y las métricas propias: `identity_logins_total{result}` y `identity_tokens_issued_total{type}` |
| `observabilidad.module.ts` | Crea `Trazas` y `Metricas` desde el entorno, abre `/metrics` en `METRICS_PORT` y cierra todo al apagar |

Las métricas propias tienen una lista cerrada de etiquetas (`result`: `success`, `invalid_credentials`,
`inactive_account`; `type`: `user_login`, `user_refresh`, `client_credentials`). Nunca un correo, un
id de usuario o de cliente, un `client_id` ni una IP en una etiqueta, un atributo o un log.

Bajo Jest, el exportador OTLP carga su transporte con `import()`: `test/utils/transformar-jose.js`
lo deja en `require` (igual que en el gateway).
