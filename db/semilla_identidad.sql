-- =============================================================================
--  QUINDE · IDENTITY
--  Datos semilla: roles y administrador inicial
-- -----------------------------------------------------------------------------
--  Requiere esquema_identidad.sql ya cargado. Se carga con db/reset.sh, que
--  define dos variables de psql antes de este archivo:
--
--    correo_admin  correo del administrador (SEED_ADMIN_EMAIL)
--    hash_admin    hash argon2id de SEED_ADMIN_PASSWORD (db/hash-contrasena.js)
--
--  La contraseña nunca está en git. Si SEED_ADMIN_PASSWORD no está definida,
--  reset.sh no define hash_admin y el administrador no se crea: solo los roles.
--  Los códigos de rol deben coincidir con ROLES de src/modules/auth/scopes.ts.
-- =============================================================================

BEGIN;

SET search_path TO identidad;

INSERT INTO rol (codigo, descripcion) VALUES
    ('cliente',       'Cliente que busca, retiene, compra y gestiona sus reservas. Rol del registro público.'),
    ('administrador', 'Administra el catálogo del core (rutas /admin). Tiene todos los scopes.');

\if :{?hash_admin}
    INSERT INTO usuario (correo, hash_contrasena) VALUES (:'correo_admin', :'hash_admin');

    INSERT INTO usuario_rol (usuario_id, rol_id)
    SELECT u.id, r.id
      FROM usuario u CROSS JOIN rol r
     WHERE u.correo = :'correo_admin' AND r.codigo = 'administrador';

    \echo 'Administrador inicial creado:' :'correo_admin'
\else
    \echo 'SEED_ADMIN_PASSWORD no está definida: no se crea el administrador inicial.'
\endif

COMMIT;
