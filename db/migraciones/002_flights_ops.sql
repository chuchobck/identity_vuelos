-- =============================================================================
--  QUINDE · IDENTITY
--  Migración 002 (fase I2, contrato v2): scope flights:ops
-- -----------------------------------------------------------------------------
--  Para una base con la migración 001. Una base nueva ya nace así
--  (db/esquema_identidad.sql): correrla ahí no cambia nada.
--
--  Idempotente (db/migrar.sh la corre en cada despliegue y CI dos veces seguidas).
--  No borra ni cambia filas: solo amplía el CHECK de los scopes que un cliente puede
--  tener permitidos. Las filas existentes ya cumplen el nuevo.
-- =============================================================================

BEGIN;

SET search_path TO identidad;

ALTER TABLE cliente_oauth DROP CONSTRAINT IF EXISTS ck_cliente_oauth_scopes;
ALTER TABLE cliente_oauth ADD CONSTRAINT ck_cliente_oauth_scopes CHECK (
        cardinality(scopes_permitidos) BETWEEN 1 AND 8
    AND array_position(scopes_permitidos, NULL) IS NULL
    AND scopes_permitidos <@ ARRAY['flights:read', 'flights:hold', 'flights:book', 'flights:cancel', 'flights:webhooks', 'flights:ops', 'flights:admin', 'events:publish']::text[]
    AND fn_sin_repetidos(scopes_permitidos)
);

COMMIT;
