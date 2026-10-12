# nn-anime-plugins

Proveedores de nn-anime que **no** viven en su repositorio. El repositorio de la aplicación publica el
contrato de plugin, el cargador y un proveedor de prueba con datos inventados; los scrapers de sitios
reales van aquí, separados a propósito.

> **Un plugin se ejecuta con tus permisos y sin sandbox.** El proceso que carga el plugin es el mismo
> que sirve la aplicación: un plugin hostil puede leer todo lo que puedas leer tú. Copia sólo lo que
> hayas leído. El detalle está en [SECURITY.md](https://github.com/zxuru/nn-anime/blob/main/SECURITY.md)
> del repositorio de la aplicación, y también en la pantalla de Ajustes.

## Qué hay

| Id | Sitio | Buscar | Sub | Dub | Tendencias | Feed | Episodios por página |
|---|---|---|---|---|---|---|---|
| `jkanime` | [jkanime.net](https://jkanime.net) | sí | sí | no | sí | sí | sí |
| `animeav1` | [animeav1.com](https://animeav1.com) | sí | sí | sí | sí | no | no |

Los dos son adaptadores de lectura: piden las páginas del sitio, extraen lo que el contrato pide y
devuelven datos. Ninguno descarga, aloja ni redistribuye contenido, y ninguno guarda credenciales
—no hay ninguna que guardar.

## Instalar

```bash
mkdir -p ~/.config/nn-anime/providers
cp providers/*.ts ~/.config/nn-anime/providers/
```

Se recargan al arrancar la aplicación. En **Ajustes → Proveedores** aparecen con su estado; si uno se
rechaza, ahí está el motivo.

Para trabajar sobre ellos, un enlace simbólico evita copiar en cada cambio:

```bash
ln -sf "$PWD/providers/jkanime.ts" ~/.config/nn-anime/providers/jkanime.ts
```

## Escribir uno

El contrato —qué campos tiene un proveedor, qué devuelve cada método y qué se considera conformidad—
está en la guía del repositorio de la aplicación: `docs/providers.md`. Hay una prueba de conformidad
que se puede correr contra un plugin antes de confiar en él.

Dos reglas que este repositorio se pone a sí mismo:

1. **Nada de credenciales.** Ni tokens, ni cookies fijas, ni claves de API. Si un sitio exige una
   sesión, se obtiene en tiempo de ejecución y no se persiste.
2. **Nada de datos de nadie.** Ni listas de usuarios, ni historiales, ni ficheros de la máquina de
   quien escribe el plugin.

## Aviso

Estos archivos automatizan la lectura de sitios de terceros. Los sitios cambian —y a veces lo
prohíben—: úsalos para lo que son, en tu equipo, y asume lo que digan sus términos de uso. El
repositorio de la aplicación no incluye ninguno de estos archivos, y esta separación es justo el
motivo.

## Licencia

MIT. Ver [LICENSE](LICENSE).
