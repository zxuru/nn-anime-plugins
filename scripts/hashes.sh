#!/bin/sh
#
# Hashes de los plugins, para comprobar que lo instalado es lo que se leyó.
#
#   sh scripts/hashes.sh                              # reescribe SHA256SUMS
#   sh scripts/hashes.sh --verificar [directorio]     # por defecto, providers/
#
# El hash se calcula sobre el contenido **sin CR**: `core.autocrlf` y un checkout
# en Windows reescriben los finales de línea, y eso cambiaría el hash de un
# archivo que nadie ha tocado. Con la normalización, el hash delata una edición de
# verdad y no una conversión de git.
#
# Esto no defiende de un repositorio comprometido —quien pueda escribir aquí
# reescribe el hash y el archivo—: sirve para lo otro, para saber si la copia que
# se está ejecutando es la que se revisó.

set -eu

raiz=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sumas="$raiz/SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  hash_de() { tr -d '\r' < "$1" | sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  # macOS trae shasum y no sha256sum.
  hash_de() { tr -d '\r' < "$1" | shasum -a 256 | cut -d' ' -f1; }
else
  echo "falta sha256sum o shasum en el PATH" >&2
  exit 1
fi

case "${1:-}" in
  --verificar)
    destino=${2:-"$raiz/providers"}
    if [ ! -f "$sumas" ]; then
      echo "no hay SHA256SUMS; genéralo primero con: sh scripts/hashes.sh" >&2
      exit 1
    fi

    cd "$destino"
    malos=0
    cuantos=0
    while IFS= read -r linea; do
      if [ -n "$linea" ]; then
        esperado=${linea%%  *}
        archivo=${linea#*  }
        cuantos=$((cuantos + 1))

        if [ ! -f "$archivo" ]; then
          echo "falta $archivo" >&2
          malos=$((malos + 1))
        else
          real=$(hash_de "$archivo")
          if [ "$real" != "$esperado" ]; then
            echo "no coincide: $archivo" >&2
            echo "  esperado $esperado" >&2
            echo "  real     $real" >&2
            malos=$((malos + 1))
          fi
        fi
      fi
    done < "$sumas"

    if [ "$malos" -ne 0 ]; then
      echo "$malos de $cuantos archivos no coinciden" >&2
      exit 1
    fi

    echo "los $cuantos archivos coinciden"
    ;;

  '')
    cd "$raiz/providers"
    : > "$sumas"
    for archivo in ./*.ts; do
      printf '%s  %s\n' "$(hash_de "$archivo")" "${archivo#./}" >> "$sumas"
    done
    echo "escrito $sumas"
    ;;

  *)
    echo "uso: sh scripts/hashes.sh [--verificar [directorio]]" >&2
    exit 2
    ;;
esac
