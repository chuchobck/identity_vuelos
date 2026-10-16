# =============================================================================
#  Lo común de db/reset.sh y db/migrar.sh: leer DATABASE_URL (del entorno o de
#  ../.env), comprobar el esquema y dejar listo psql_id, que corre psql contra
#  esa base. Con psql en el PATH se conecta directo; si no, usa el psql del
#  contenedor de docker-compose.yml. La contraseña no aparece en los argumentos
#  de ningún proceso (va en PGPASSWORD). CONTENEDOR acepta el nombre o el id
#  (el de un servicio de GitHub Actions). Se carga con `source`; necesita DIR.
# =============================================================================

CONTENEDOR="${CONTENEDOR:-quinde_identity_db}"
ESQUEMA_ESPERADO="identidad"

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
PGPASSWORD="$(parte_url contrasena)"
export PGPASSWORD
if command -v psql >/dev/null 2>&1; then
    URL_PSQL="$(parte_url url_psql)"
    psql_id() { psql "$URL_PSQL" -v ON_ERROR_STOP=1 -q "$@"; }
elif [[ "$(docker inspect -f '{{.State.Running}}' "$CONTENEDOR" 2>/dev/null)" == true ]]; then
    USUARIO_BD="$(parte_url usuario)"
    BASE="$(parte_url base)"
    psql_id() { docker exec -i -e PGPASSWORD "$CONTENEDOR" psql -U "$USUARIO_BD" -d "$BASE" -v ON_ERROR_STOP=1 -q "$@"; }
else
    echo "No hay psql en el PATH ni está corriendo el contenedor $CONTENEDOR (docker compose up -d)." >&2
    exit 1
fi

esperar_postgres() {
    printf 'Esperando a PostgreSQL'
    for _ in $(seq 1 30); do
        if psql_id -c 'SELECT 1' >/dev/null 2>&1; then break; fi
        printf '.'; sleep 1
    done
    echo
    psql_id -c 'SELECT 1' >/dev/null || { echo "PostgreSQL no responde." >&2; exit 1; }
}

# Corre db/migraciones/*.sql en orden. Son idempotentes: en una base que ya las tiene
# (o que nació con el esquema actual) no cambian nada.
aplicar_migraciones() {
    local archivo
    for archivo in "$DIR"/migraciones/*.sql; do
        [[ -e "$archivo" ]] || continue
        echo "Migración $(basename "$archivo")..."
        psql_id < "$archivo"
    done
}
