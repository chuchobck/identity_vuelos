#!/usr/bin/env bash
# =============================================================================
#  Aplica db/migraciones/*.sql a la base de DATABASE_URL (del entorno o de
#  ../.env). Es lo que se corre en una base que ya existe (la de Neon, por
#  ejemplo) al desplegar una versión nueva; una base nueva sale de db/reset.sh.
#
#  Uso:  ./db/migrar.sh
#
#  No borra nada: las migraciones solo agregan y son idempotentes (correrla dos
#  veces deja la base igual), así que no pide confirmación.
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db/comun.sh
source "$DIR/comun.sh"

esperar_postgres
aplicar_migraciones
echo "Listo."
