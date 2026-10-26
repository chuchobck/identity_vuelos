-- =============================================================================
--  QUINDE · IDENTITY
--  Migración 001 (fase 4c): administración de usuarios y scope events:publish
-- -----------------------------------------------------------------------------
--  Para una base creada con el esquema de la fase 4a. Una base nueva ya nace
--  así (db/esquema_identidad.sql): correrla ahí no cambia nada.
--
--  Idempotente: se puede correr las veces que haga falta (db/migrar.sh la
--  corre en cada despliegue y CI la corre dos veces seguidas). No borra ni
--  cambia filas: solo agrega valores, una columna, un índice y amplía un CHECK.
-- =============================================================================

BEGIN;

SET search_path TO identidad;

-- 1. Eventos de POST y DELETE /identity/v1/admin/users. ADD VALUE IF NOT EXISTS
--    puede ir dentro de una transacción desde PostgreSQL 12 (el valor nuevo no
--    se usa en esta misma transacción).
ALTER TYPE evento_seguridad ADD VALUE IF NOT EXISTS 'ADMINISTRADOR_CREADO';
ALTER TYPE evento_seguridad ADD VALUE IF NOT EXISTS 'ADMINISTRADOR_DADO_DE_BAJA';
COMMENT ON TYPE evento_seguridad IS 'Evento de auditoria_seguridad. REUSO_REFRESCO=llegó un refresh ya rotado y se revocó la familia; ACCESO_CUENTA_INACTIVA=un token válido de una cuenta desactivada; TOKEN_CLIENTE=POST /oauth2/token (client_credentials); ADMINISTRADOR_CREADO y ADMINISTRADOR_DADO_DE_BAJA=POST y DELETE de /admin/users (actor_id es quien lo hizo).';

-- 2. Quién hizo el cambio: el sub del administrador (usuario_id es la cuenta afectada).
--    La tabla es de solo inserción, pero ADD COLUMN no toca filas: el trigger no salta.
ALTER TABLE auditoria_seguridad ADD COLUMN IF NOT EXISTS actor_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_auditoria_seguridad_actor'
           AND conrelid = 'identidad.auditoria_seguridad'::regclass
    ) THEN
        ALTER TABLE auditoria_seguridad
            ADD CONSTRAINT fk_auditoria_seguridad_actor
            FOREIGN KEY (actor_id) REFERENCES usuario (id) ON DELETE RESTRICT;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_auditoria_seguridad_actor
    ON auditoria_seguridad (actor_id, fecha_evento) WHERE actor_id IS NOT NULL;

COMMENT ON COLUMN auditoria_seguridad.actor_id IS 'Quién hizo el cambio cuando no es la propia cuenta: el administrador (su sub) en un alta o una baja de /admin/users. usuario_id es la cuenta afectada.';

-- 3. events:publish entre los scopes que un cliente puede tener permitidos. Se reemplaza el
--    CHECK entero, pero solo si el vigente todavía no lo admite: db/migrar.sh corre TODAS las
--    migraciones en cada despliegue, y una migración posterior (002) ya lo amplió. Sin esta
--    condición, volver a correr la 001 pondría de nuevo el CHECK viejo y fallaría con cualquier
--    cliente que tenga un scope más nuevo. Las filas existentes ya cumplen el CHECK nuevo, que
--    solo amplía la lista.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_cliente_oauth_scopes'
           AND conrelid = 'identidad.cliente_oauth'::regclass
           AND pg_get_constraintdef(oid) LIKE '%events:publish%'
    ) THEN
        ALTER TABLE cliente_oauth DROP CONSTRAINT IF EXISTS ck_cliente_oauth_scopes;
        ALTER TABLE cliente_oauth ADD CONSTRAINT ck_cliente_oauth_scopes CHECK (
                cardinality(scopes_permitidos) BETWEEN 1 AND 7
            AND array_position(scopes_permitidos, NULL) IS NULL
            AND scopes_permitidos <@ ARRAY['flights:read', 'flights:hold', 'flights:book', 'flights:cancel', 'flights:webhooks', 'flights:admin', 'events:publish']::text[]
            AND fn_sin_repetidos(scopes_permitidos)
        );
    END IF;
END;
$$;

COMMIT;
