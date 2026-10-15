#!/usr/bin/env bash
# =============================================================================
#  Reinicia el esquema "identidad": lo borra con todo lo que tiene, lo vuelve a
#  crear y carga la semilla. NUNCA borra la base: puede ser la misma del core,
#  con el esquema "vuelos" al lado.
#
#  Uso:  ./db/reset.sh                 (esquema + semilla)
#        ./db/reset.sh --solo-esquema
#
#  Conexión: DATABASE_URL (del entorno o de ../.env). Con psql en el PATH se
#  conecta directo; si no, usa el psql del contenedor de docker-compose.yml.
#  La contraseña no aparece en los argumentos de ningún proceso (va en PGPASSWORD).
#
#  Contra un host que no es local exige CONFIRMAR_RESET=si: borra cuentas reales.
#
#  Administrador inicial: si SEED_ADMIN_PASSWORD está definida (en el entorno o en
#  .env), se crea con el correo SEED_ADMIN_EMAIL (por defecto admin@quinde.example).
#  El hash argon2id lo calcula db/hash-contrasena.js, así que hace falta "npm ci" antes.
# =============================================================================
set -euo pipefail

CONTENEDOR="${CONTENEDOR:-quinde_identity_db}"
ESQUEMA_ESPERADO="identidad"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARGAR_SEED=true
[[ "${1:-}" == "--solo-esquema" ]] && CARGAR_SEED=false

# Valor de una variable en ../.env (sin comillas), para no pedir exportarla a mano.
leer_de_env() {
    local valor
    valor="$(grep -E "^$1=" "$DIR/../.env" 2>/dev/null | tail -n 1 | cut -d= -f2-)" || true
    valor="${valor%\"}"; valor="${valor#\"}"; valor="${valor%\'}"; valor="${valor#\'}"
    printf '%s' "$valor"
}

URL_BASE="${DATABASE_URL:-$(leer_de_env DATABASE_URL)}"
if [[ -z "$URL_BASE" ]]; then
    echo "Falta DATABASE_URL (en el entorno o en .env)." >&2
    exit 1
fi

# Una parte de la URL, leída con Node (la URL va por el entorno, no como argumento).
parte_url() {
    URL_ENTRADA="$URL_BASE" node -e '
        const u = new URL(process.env.URL_ENTRADA);
        const partes = {
            esquema: u.searchParams.get("schema") ?? "identidad",
            host: u.hostname.replace(/^\[|\]$/g, ""),
            usuario: decodeURIComponent(u.username),
            contrasena: decodeURIComponent(u.password),
            base: decodeURIComponent(u.pathname.replace(/^\//, "")),
            // psql no conoce ?schema=: se quita; sslmode y los demás se conservan
            url_psql: (() => { u.searchParams.delete("schema"); u.password = ""; return u.href; })(),
        };
        process.stdout.write(partes[process.argv[1]]);
    ' "$1"
}

ESQUEMA="$(parte_url esquema)"
HOST="$(parte_url host)"
if [[ "$ESQUEMA" != "$ESQUEMA_ESPERADO" ]]; then
    echo "DATABASE_URL apunta al esquema \"$ESQUEMA\"; los .sql crean \"$ESQUEMA_ESPERADO\"." >&2
    exit 1
fi
case "$HOST" in
    localhost|127.0.0.1|::1|postgres) ;;
    *)
        if [[ "${CONFIRMAR_RESET:-}" != "si" ]]; then
            echo "DATABASE_URL apunta a $HOST, que no es local: esto borra el esquema $ESQUEMA_ESPERADO" >&2
            echo "con todas sus cuentas. Si es lo que quieres, repite con CONFIRMAR_RESET=si." >&2
            exit 1
        fi
        ;;
esac

PGPASSWORD="$(parte_url contrasena)"
export PGPASSWORD
if command -v psql >/dev/null 2>&1; then
    URL_PSQL="$(parte_url url_psql)"
    psql_id() { psql "$URL_PSQL" -v ON_ERROR_STOP=1 -q "$@"; }
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTENEDOR"; then
    USUARIO_BD="$(parte_url usuario)"
    BASE="$(parte_url base)"
    psql_id() { docker exec -i -e PGPASSWORD "$CONTENEDOR" psql -U "$USUARIO_BD" -d "$BASE" -v ON_ERROR_STOP=1 -q "$@"; }
else
    echo "No hay psql en el PATH ni está corriendo el contenedor $CONTENEDOR (docker compose up -d)." >&2
    exit 1
fi

printf 'Esperando a PostgreSQL'
for _ in $(seq 1 30); do
    if psql_id -c 'SELECT 1' >/dev/null 2>&1; then break; fi
    printf '.'; sleep 1
done
echo
psql_id -c 'SELECT 1' >/dev/null || { echo "PostgreSQL no responde." >&2; exit 1; }

# --- 1. borrar y crear el esquema (solo el esquema) ---------------------------
echo "Borrando el esquema $ESQUEMA_ESPERADO..."
psql_id -c "DROP SCHEMA IF EXISTS $ESQUEMA_ESPERADO CASCADE"

echo "Cargando esquema_identidad.sql..."
psql_id < "$DIR/esquema_identidad.sql"

# --- 2. semilla -----------------------------------------------------------------
if [[ "$CARGAR_SEED" == true ]]; then
    # Las variables de psql (correo_admin, hash_admin) van por stdin, delante del archivo:
    # ni la contraseña ni su hash aparecen en los argumentos de un proceso.
    SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$(leer_de_env SEED_ADMIN_PASSWORD)}"
    SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-$(leer_de_env SEED_ADMIN_EMAIL)}"
    SEED_ADMIN_EMAIL="$(printf '%s' "${SEED_ADMIN_EMAIL:-admin@quinde.example}" | tr '[:upper:]' '[:lower:]')"
    variables=""
    if [[ -n "$SEED_ADMIN_PASSWORD" ]]; then
        if [[ ! "$SEED_ADMIN_EMAIL" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]+$ ]]; then
            echo "SEED_ADMIN_EMAIL no es un correo válido" >&2
            exit 1
        fi
        hash="$(SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" node "$DIR/hash-contrasena.js")"
        variables="\\set correo_admin '$SEED_ADMIN_EMAIL'"$'\n'"\\set hash_admin '$hash'"$'\n'
    fi
    echo "Cargando semilla_identidad.sql..."
    { printf '%s' "$variables"; cat "$DIR/semilla_identidad.sql"; } | psql_id
fi

# --- 3. verificación ----------------------------------------------------------
echo
echo "--- Tablas del esquema $ESQUEMA_ESPERADO ---"
psql_id -c "
SELECT table_name AS tabla
FROM information_schema.tables
WHERE table_schema = '$ESQUEMA_ESPERADO' AND table_type = 'BASE TABLE'
ORDER BY table_name;"
echo "Listo."
