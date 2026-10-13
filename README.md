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
| `pelisplushd` | [pelisplushd.bz](https://pelisplushd.bz) | sí | sí | sí | no | no | no |
| `animex` | [animex.one](https://animex.one) | sí | sí | sí | no | no | no |

Los cuatro son adaptadores de lectura: piden las páginas del sitio, extraen lo que el contrato pide y
devuelven datos. Ninguno descarga, aloja ni redistribuye contenido, y ninguno guarda credenciales
—no hay ninguna que guardar.

`pelisplushd` es el único que sirve **películas y series**: devuelve `kind: 'movie'` o `'tv'`, una
película es un episodio con número 1 y una serie lista sus capítulos con la temporada y el capítulo en
el título. Su resolutor no ejecuta nada del sitio: interpreta el empaquetador
`eval(function(p,a,c,k,e,d){…})`, resuelve la prueba de trabajo con `node:crypto` y descifra el enlace
con AES-256-CBC, que es lo que hace `ani-cli-mx`. La dirección base se puede repuntar con
`NN_ANIME_PELISPLUS_URL`, porque estos dominios cambian de sufijo.

**El dominio, hoy, no existe.** Medido el 12 de octubre de 2026 desde esta máquina: pelisplushd.mx,
.bz y .to resuelven todos a 20.127.234.48 y no contestan por 443; .nu y .com están aparcados
(ParkLogic y HugeDomains), y .net redirige a alliance4creativity.com/watch-it-legally, que es la
página que dejan las retiradas de dominio. Por eso no carga en el navegador. El plugin sigue siendo
correcto —lo que le falta es una casa—: se le apunta cualquier dominio vivo de la misma familia con
NN_ANIME_PELISPLUS_URL, y cuando el dominio no contesta o redirige a otra parte lo dice con esas
palabras en vez de devolver una lista vacía.

**Pendiente de comprobar en vivo.** El plugin se ha medido de punta a punta contra un sitio falso
local —buscador, ficha, capítulos, embed con prueba de trabajo, espejo empaquetado—, pero **no**
contra un sitio vivo de esta familia: los selectores del buscador y de la lista de capítulos son los de `ani-cli-mx`
leídos de su código, y el sitio puede haber cambiado el marcado. Si devuelve cero fichas, lo dice con
ese mensaje en vez de fingir que no hay resultados.

`animex` es el único con **API de verdad**: el catálogo va por GraphQL (`graphql.animex.one`) y los
episodios, los servidores y los enlaces por REST (`pp.animex.one`), así que no hay HTML que parsear
en ninguna parte. Dos cosas que se midieron y están en el código: el host del manifiesto **ata el
token al `User-Agent` con el que se pidió** —la misma URL da 200 con el agente que la pidió y 403 con
cualquier otro, o sin ninguno—, así que la fuente declara el mismo agente que usa el plugin para
hablar con la API; y las pistas de subtítulos del JSON **no se devuelven**, porque su host contesta
403 «Website Access Blocked» desde Cloudflare a cualquier petición que salga de aquí.

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
