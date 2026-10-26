-- =============================================================================
--  QUINDE · IDENTITY
--  Migración 003 (fase I2): evento CLIENTE_SECRETO_ROTADO
-- -----------------------------------------------------------------------------
--  Para una base con la migración 002. Una base nueva ya nace así
--  (db/esquema_identidad.sql): correrla ahí no cambia nada.
--
--  Idempotente. Solo agrega un valor al enum y actualiza su comentario; no toca filas.
--  `npm run cliente:rotar-secreto` deja este evento cuando cambia el secreto de un cliente
--  sin cambiar su client_id (el de Booking Prototipo, por ejemplo).
-- =============================================================================

BEGIN;

SET search_path TO identidad;

ALTER TYPE evento_seguridad ADD VALUE IF NOT EXISTS 'CLIENTE_SECRETO_ROTADO';

COMMENT ON TYPE evento_seguridad IS 'Evento de auditoria_seguridad. REUSO_REFRESCO=llegó un refresh ya rotado y se revocó la familia; ACCESO_CUENTA_INACTIVA=un token válido de una cuenta desactivada; TOKEN_CLIENTE=POST /oauth2/token (client_credentials); ADMINISTRADOR_CREADO y ADMINISTRADOR_DADO_DE_BAJA=POST y DELETE de /admin/users (actor_id es quien lo hizo); CLIENTE_SECRETO_ROTADO=npm run cliente:rotar-secreto.';

COMMIT;
