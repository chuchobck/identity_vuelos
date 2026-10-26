-- =============================================================================
--  QUINDE · IDENTITY
--  Esquema "identidad": cuentas de personas, roles, tokens de refresco,
--  clientes OAuth 2.0 (máquina a máquina) y auditoría de seguridad.
-- -----------------------------------------------------------------------------
--  Parte de db/esquema_seguridad.sql del core (github.com/chuchobck/backend_vuelos)
--  con las mismas convenciones: nombres en español y snake_case, uuid en lo que
--  viaja en un token (el "sub" es usuario.id o cliente_oauth.id), bigint
--  IDENTITY en lo interno, instantes en timestamptz, "activo" para la
--  eliminación lógica. Nada se borra físicamente.
--
--  Puede vivir en una base propia o en la misma base del core (en otro
--  esquema): ninguna tabla de aquí apunta a las de vuelos ni al revés. Ver
--  docs/DEPLOY.md, "Base de datos".
--
--  Qué permisos (scopes) da cada rol NO está aquí: vive en el código
--  (src/modules/auth/scopes.ts). Los de cada cliente OAuth sí, porque cambian
--  por cliente sin desplegar.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS identidad;
SET search_path TO identidad;


-- =============================================================================
-- 1. TIPOS ENUMERADOS
-- =============================================================================

CREATE TYPE motivo_revocacion AS ENUM ('CIERRE_SESION', 'REUTILIZACION', 'USUARIO_INACTIVO');
COMMENT ON TYPE motivo_revocacion IS 'Por qué se revocó un token de refresco: CIERRE_SESION=logout, REUTILIZACION=llegó un token ya rotado (se revoca toda la familia), USUARIO_INACTIVO=la cuenta se desactivó.';

CREATE TYPE evento_seguridad AS ENUM (
    'REGISTRO',
    'LOGIN',
    'REFRESCO',
    'REUSO_REFRESCO',
    'LOGOUT',
    'ACCESO_CUENTA_INACTIVA',
    'TOKEN_CLIENTE',
    'CLIENTE_CREADO',
    'ADMINISTRADOR_CREADO',
    'ADMINISTRADOR_DADO_DE_BAJA',
    'CLIENTE_SECRETO_ROTADO'
);
COMMENT ON TYPE evento_seguridad IS 'Evento de auditoria_seguridad. REUSO_REFRESCO=llegó un refresh ya rotado y se revocó la familia; ACCESO_CUENTA_INACTIVA=un token válido de una cuenta desactivada; TOKEN_CLIENTE=POST /oauth2/token (client_credentials); ADMINISTRADOR_CREADO y ADMINISTRADOR_DADO_DE_BAJA=POST y DELETE de /admin/users (actor_id es quien lo hizo); CLIENTE_SECRETO_ROTADO=npm run cliente:rotar-secreto.';

CREATE TYPE resultado_seguridad AS ENUM ('EXITO', 'FALLO');


-- =============================================================================
-- 2. USUARIOS Y ROLES (como en el core)
-- =============================================================================

CREATE TABLE usuario (
    id               uuid         NOT NULL DEFAULT gen_random_uuid(),
    correo           text         NOT NULL,
    hash_contrasena  text         NOT NULL,
    activo           boolean      NOT NULL DEFAULT true,
    fecha_creacion   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_usuario PRIMARY KEY (id),
    CONSTRAINT uq_usuario_correo UNIQUE (correo),
    -- El correo se guarda ya normalizado: sin espacios en los bordes y en minúsculas.
    CONSTRAINT ck_usuario_correo CHECK (
            correo = lower(btrim(correo))
        AND char_length(correo) <= 254
        AND correo ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    ),
    -- Solo hashes argon2id en formato PHC: nunca una contraseña en texto plano. Los
    -- parámetros (m, t, p) pueden venir en cualquier orden: argon2 de Node escribe m,p,t.
    CONSTRAINT ck_usuario_hash_contrasena CHECK (hash_contrasena ~ '^\$argon2id\$v=19\$[a-z]=[0-9]+(,[a-z]=[0-9]+)*\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$')
);

CREATE TABLE rol (
    id           bigint   GENERATED ALWAYS AS IDENTITY,
    codigo       text     NOT NULL,
    descripcion  text     NOT NULL,
    activo       boolean  NOT NULL DEFAULT true,
    CONSTRAINT pk_rol PRIMARY KEY (id),
    CONSTRAINT uq_rol_codigo UNIQUE (codigo),
    CONSTRAINT ck_rol_codigo CHECK (codigo ~ '^[a-z_]+$'),
    CONSTRAINT ck_rol_descripcion CHECK (btrim(descripcion) <> '')
);

CREATE TABLE usuario_rol (
    id                bigint       GENERATED ALWAYS AS IDENTITY,
    usuario_id        uuid         NOT NULL,
    rol_id            bigint       NOT NULL,
    activo            boolean      NOT NULL DEFAULT true,
    fecha_asignacion  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_usuario_rol PRIMARY KEY (id),
    CONSTRAINT uq_usuario_rol UNIQUE (usuario_id, rol_id),
    CONSTRAINT fk_usuario_rol_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_usuario_rol_rol FOREIGN KEY (rol_id) REFERENCES rol (id) ON DELETE RESTRICT
);


-- =============================================================================
-- 3. TOKENS DE REFRESCO (como en el core)
--     Rotación con detección de reutilización: cada uso crea un token nuevo en
--     la misma familia y marca el anterior con reemplazado_por_id. Si llega un
--     token que ya tiene reemplazo, alguien lo copió: se revoca toda la familia.
--     El token viaja una sola vez al cliente; aquí solo queda su SHA-256.
-- =============================================================================

CREATE TABLE token_refresco (
    id                  uuid               NOT NULL DEFAULT gen_random_uuid(),
    usuario_id          uuid               NOT NULL,
    id_familia          uuid               NOT NULL,
    hash_token          varchar(64)        NOT NULL,
    fecha_creacion      timestamptz        NOT NULL DEFAULT now(),
    fecha_expiracion    timestamptz        NOT NULL,
    fecha_revocacion    timestamptz,
    motivo_revocacion   motivo_revocacion,
    reemplazado_por_id  uuid,
    CONSTRAINT pk_token_refresco PRIMARY KEY (id),
    CONSTRAINT uq_token_refresco_hash UNIQUE (hash_token),
    CONSTRAINT fk_token_refresco_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    -- SET NULL y no RESTRICT: una purga futura de tokens vencidos borra primero los más
    -- viejos de la familia, que son los que apuntan a los nuevos.
    CONSTRAINT fk_token_refresco_reemplazo FOREIGN KEY (reemplazado_por_id) REFERENCES token_refresco (id) ON DELETE SET NULL,
    CONSTRAINT ck_token_refresco_hash CHECK (hash_token ~ '^[0-9a-f]{64}$'),
    -- El servicio pone las dos fechas con su Reloj (las pruebas lo adelantan).
    CONSTRAINT ck_token_refresco_vigencia CHECK (fecha_expiracion > fecha_creacion),
    CONSTRAINT ck_token_refresco_revocacion CHECK ((fecha_revocacion IS NULL) = (motivo_revocacion IS NULL)),
    CONSTRAINT ck_token_refresco_reemplazo CHECK (reemplazado_por_id <> id)
);


-- =============================================================================
-- 4. CLIENTES OAUTH 2.0 (grant client_credentials)
--     Un sistema que llama al core en nombre propio (una agencia, un proceso
--     batch). Se crean con `npm run cliente:crear`: no hay endpoint para eso.
--     El secreto se muestra una sola vez al crearlo; aquí solo queda su hash
--     argon2id. El "sub" de sus tokens es cliente_oauth.id (uuid) y el
--     "client_id" es cliente_oauth.codigo.
-- =============================================================================

-- true si el arreglo no repite valores (una subconsulta no se puede usar dentro de un CHECK).
CREATE FUNCTION fn_sin_repetidos(valores text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT cardinality(valores) = (SELECT count(DISTINCT valor) FROM unnest(valores) AS valor);
$$;

CREATE TABLE cliente_oauth (
    id                   uuid         NOT NULL DEFAULT gen_random_uuid(),
    codigo               text         NOT NULL,
    nombre               text         NOT NULL,
    hash_secreto         text         NOT NULL,
    scopes_permitidos    text[]       NOT NULL,
    activo               boolean      NOT NULL DEFAULT true,
    fecha_creacion       timestamptz  NOT NULL DEFAULT now(),
    fecha_actualizacion  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_cliente_oauth PRIMARY KEY (id),
    CONSTRAINT uq_cliente_oauth_codigo UNIQUE (codigo),
    -- Sin ":" (separa client_id y secreto en Authorization: Basic) ni mayúsculas.
    CONSTRAINT ck_cliente_oauth_codigo CHECK (codigo ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    CONSTRAINT ck_cliente_oauth_nombre CHECK (btrim(nombre) <> '' AND char_length(nombre) <= 100),
    CONSTRAINT ck_cliente_oauth_hash_secreto CHECK (hash_secreto ~ '^\$argon2id\$v=19\$[a-z]=[0-9]+(,[a-z]=[0-9]+)*\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'),
    -- Solo los scopes que existen (los 5 del contrato, flights:ops, flights:admin y
    -- events:publish), sin repetidos ni nulos. Que un cliente reciba flights:ops, flights:admin
    -- o events:publish además exige pedirlo en cada token (ver el servicio). La misma lista que
    -- SCOPES en src/modules/auth/scopes.ts; db/migraciones/001 y 002 la llevan a una base ya
    -- creada.
    CONSTRAINT ck_cliente_oauth_scopes CHECK (
            cardinality(scopes_permitidos) BETWEEN 1 AND 8
        AND array_position(scopes_permitidos, NULL) IS NULL
        AND scopes_permitidos <@ ARRAY['flights:read', 'flights:hold', 'flights:book', 'flights:cancel', 'flights:webhooks', 'flights:ops', 'flights:admin', 'events:publish']::text[]
        AND fn_sin_repetidos(scopes_permitidos)
    ),
    CONSTRAINT ck_cliente_oauth_fechas CHECK (fecha_actualizacion >= fecha_creacion)
);

CREATE FUNCTION fn_tocar_fecha_actualizacion() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.fecha_actualizacion := greatest(now(), NEW.fecha_creacion);
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_cliente_oauth_fecha_actualizacion
    BEFORE UPDATE ON cliente_oauth
    FOR EACH ROW EXECUTE FUNCTION fn_tocar_fecha_actualizacion();


-- =============================================================================
-- 5. AUDITORÍA DE SEGURIDAD
--     Una fila por evento (login correcto o fallido, refresh, reuso, logout,
--     token de cliente emitido o rechazado...). Nunca guarda contraseñas,
--     hashes, tokens, secretos ni claves, y en un fallo con un correo que no
--     existe solo guarda una versión parcial (an***@dominio.ec). Solo inserción.
-- =============================================================================

CREATE TABLE auditoria_seguridad (
    id              bigint               GENERATED ALWAYS AS IDENTITY,
    fecha_evento    timestamptz          NOT NULL DEFAULT now(),
    evento          evento_seguridad     NOT NULL,
    resultado       resultado_seguridad  NOT NULL,
    motivo          text,
    usuario_id      uuid,
    cliente_id      uuid,
    correo_parcial  text,
    direccion_ip    inet,
    id_peticion     text,
    -- Al final (y no junto a usuario_id) porque la migración 001 la agrega con ADD COLUMN: así una
    -- base migrada y una nueva quedan iguales.
    actor_id        uuid,
    -- Al final, por la misma razón que actor_id: la migración 004 la agrega con ADD COLUMN.
    id_correlacion  text,
    CONSTRAINT pk_auditoria_seguridad PRIMARY KEY (id),
    CONSTRAINT fk_auditoria_seguridad_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_auditoria_seguridad_cliente FOREIGN KEY (cliente_id) REFERENCES cliente_oauth (id) ON DELETE RESTRICT,
    CONSTRAINT fk_auditoria_seguridad_actor FOREIGN KEY (actor_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    -- Un motivo es un código corto (CONTRASENA_INVALIDA), nunca texto libre que pueda llevar datos.
    CONSTRAINT ck_auditoria_seguridad_motivo CHECK (motivo ~ '^[A-Z][A-Z_]{2,39}$'),
    CONSTRAINT ck_auditoria_seguridad_actor CHECK (usuario_id IS NULL OR cliente_id IS NULL),
    -- Nunca el correo completo: a lo sumo dos caracteres, "***" y el dominio.
    CONSTRAINT ck_auditoria_seguridad_correo CHECK (correo_parcial ~ '^[^@[:space:]]{0,2}\*\*\*@[^@[:space:]]+$'),
    -- El mismo formato que acepta el servicio para X-Request-Id.
    CONSTRAINT ck_auditoria_seguridad_id_peticion CHECK (id_peticion ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$'),
    -- El X-Correlation-Id del contrato v2 (§6): hasta 100 caracteres, con el formato que acepta el servicio.
    CONSTRAINT ck_auditoria_seguridad_id_correlacion CHECK (id_correlacion ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
);

-- El log solo crece: nadie edita ni borra filas de auditoría.
CREATE FUNCTION fn_auditoria_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'La tabla auditoria_seguridad es de solo inserción'
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER tg_auditoria_seguridad_inmutable
    BEFORE UPDATE OR DELETE ON auditoria_seguridad
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria_inmutable();

CREATE TRIGGER tg_auditoria_seguridad_sin_truncate
    BEFORE TRUNCATE ON auditoria_seguridad
    FOR EACH STATEMENT EXECUTE FUNCTION fn_auditoria_inmutable();


-- =============================================================================
-- 6. ÍNDICES
--     Las FK que ya son la primera columna de una PK o UNIQUE no se repiten.
-- =============================================================================

CREATE INDEX ix_usuario_rol_rol ON usuario_rol (rol_id);
CREATE INDEX ix_token_refresco_usuario ON token_refresco (usuario_id);
CREATE INDEX ix_token_refresco_familia ON token_refresco (id_familia);
CREATE INDEX ix_token_refresco_reemplazo ON token_refresco (reemplazado_por_id) WHERE reemplazado_por_id IS NOT NULL;
CREATE INDEX ix_token_refresco_fecha_expiracion ON token_refresco (fecha_expiracion);
CREATE INDEX ix_auditoria_seguridad_fecha ON auditoria_seguridad (fecha_evento);
CREATE INDEX ix_auditoria_seguridad_usuario ON auditoria_seguridad (usuario_id, fecha_evento) WHERE usuario_id IS NOT NULL;
CREATE INDEX ix_auditoria_seguridad_cliente ON auditoria_seguridad (cliente_id, fecha_evento) WHERE cliente_id IS NOT NULL;
CREATE INDEX ix_auditoria_seguridad_actor ON auditoria_seguridad (actor_id, fecha_evento) WHERE actor_id IS NOT NULL;
CREATE INDEX ix_auditoria_seguridad_correlacion ON auditoria_seguridad (id_correlacion) WHERE id_correlacion IS NOT NULL;


-- =============================================================================
-- 7. COMENTARIOS
-- =============================================================================

COMMENT ON SCHEMA identidad IS 'Quinde · Identity: cuentas, roles, tokens de refresco, clientes OAuth y auditoría de seguridad.';

COMMENT ON TABLE usuario             IS 'Cuenta de una persona. Su id es el "sub" de sus tokens y el id_propietario de retenciones, reservas y webhooks del core.';
COMMENT ON TABLE rol                 IS 'Rol de un usuario. Los scopes de cada rol están en el código (src/modules/auth/scopes.ts).';
COMMENT ON TABLE usuario_rol         IS 'Roles asignados a un usuario. Quitar un rol es activo = false.';
COMMENT ON TABLE token_refresco      IS 'Tokens de refresco emitidos, guardados solo como hash. Una familia nace en el login y crece con cada rotación.';
COMMENT ON TABLE cliente_oauth       IS 'Cliente OAuth 2.0 del grant client_credentials. Su id es el "sub" de sus tokens; codigo es el client_id.';
COMMENT ON TABLE auditoria_seguridad IS 'Eventos de seguridad (logins, refresh, reuso, logout, tokens de cliente). Solo inserción; sin contraseñas, tokens, secretos ni correos completos.';

COMMENT ON COLUMN usuario.correo IS 'Normalizado por el servicio (trim y minúsculas) antes de guardarse. Es el usuario del login.';
COMMENT ON COLUMN usuario.hash_contrasena IS 'Hash argon2id en formato PHC ($argon2id$v=19$m=...,p=...,t=...$sal$hash).';
COMMENT ON COLUMN usuario.activo IS 'false impide iniciar sesión y refrescar; los tokens de acceso ya emitidos vencen solos (15 minutos).';
COMMENT ON COLUMN token_refresco.id_familia IS 'Mismo valor para todos los tokens que nacen de un login. Reutilizar uno rotado revoca la familia completa.';
COMMENT ON COLUMN token_refresco.hash_token IS 'SHA-256 en hexadecimal del token (256 bits aleatorios). Un hash rápido alcanza: el token no se puede adivinar como una contraseña.';
COMMENT ON COLUMN token_refresco.fecha_revocacion IS 'Revocación explícita (logout, reutilización, usuario inactivo). Un token rotado no se revoca: se marca con reemplazado_por_id.';
COMMENT ON COLUMN token_refresco.reemplazado_por_id IS 'Token que lo reemplazó al rotar. Si llega un token con este campo lleno, fue reutilizado.';
COMMENT ON COLUMN cliente_oauth.codigo IS 'client_id de OAuth 2.0: minúsculas, dígitos, punto, guion y guion bajo; sin ":".';
COMMENT ON COLUMN cliente_oauth.hash_secreto IS 'Hash argon2id del secreto (256 bits aleatorios). El secreto se muestra una sola vez, al crear el cliente.';
COMMENT ON COLUMN cliente_oauth.scopes_permitidos IS 'Lo máximo que el cliente puede pedir. flights:admin además hay que pedirlo de forma explícita en cada token.';
COMMENT ON COLUMN auditoria_seguridad.motivo IS 'Código corto del resultado (CONTRASENA_INVALIDA, CLIENTE_INACTIVO, REUTILIZACION...). Nunca texto libre.';
COMMENT ON COLUMN auditoria_seguridad.correo_parcial IS 'Solo en un fallo con un correo que no tiene cuenta: dos caracteres, "***" y el dominio.';
COMMENT ON COLUMN auditoria_seguridad.id_peticion IS 'X-Request-Id de la petición, para cruzar con los logs.';
COMMENT ON COLUMN auditoria_seguridad.id_correlacion IS 'X-Correlation-Id de la petición (contrato v2, §6): une este evento con los del mismo proceso de negocio en los demás servicios.';
COMMENT ON COLUMN auditoria_seguridad.actor_id IS 'Quién hizo el cambio cuando no es la propia cuenta: el administrador (su sub) en un alta o una baja de /admin/users. usuario_id es la cuenta afectada.';

COMMIT;
