-- =============================================================================
--  QUINDE · IDENTITY
--  Migración 004 (fase I2, contrato v2 §6): X-Correlation-Id en la auditoría de seguridad
-- -----------------------------------------------------------------------------
--  Para una base con la migración 003. Una base nueva ya nace así
--  (db/esquema_identidad.sql): correrla ahí no cambia nada.
--
--  Idempotente. Solo agrega una columna (nula en las filas que ya existen), su CHECK y un
--  índice parcial. La tabla es de solo inserción, pero ADD COLUMN no toca filas: el trigger
--  no salta.
-- =============================================================================

BEGIN;

SET search_path TO identidad;

ALTER TABLE auditoria_seguridad ADD COLUMN IF NOT EXISTS id_correlacion text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_auditoria_seguridad_id_correlacion'
           AND conrelid = 'identidad.auditoria_seguridad'::regclass
    ) THEN
        ALTER TABLE auditoria_seguridad
            ADD CONSTRAINT ck_auditoria_seguridad_id_correlacion
            CHECK (id_correlacion ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$');
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_auditoria_seguridad_correlacion
    ON auditoria_seguridad (id_correlacion) WHERE id_correlacion IS NOT NULL;

COMMENT ON COLUMN auditoria_seguridad.id_correlacion IS 'X-Correlation-Id de la petición (contrato v2, §6): une este evento con los del mismo proceso de negocio en los demás servicios.';

COMMIT;
