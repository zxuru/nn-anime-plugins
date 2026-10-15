# nn-anime-plugins

Proveedores de nn-anime que **no** viven en su repositorio. El repositorio de la aplicación publica el
contrato de plugin, el cargador y un proveedor de prueba con datos inventados; los scrapers de sitios
reales van aquí, separados a propósito.

> **Un plugin se ejecuta con tus permisos y sin sandbox.** El proceso que carga el plugin es el mismo
> que sirve la aplicación: un plugin hostil puede leer todo lo que puedas leer tú. Copia sólo lo que
> hayas leído. El detalle está en [SECURITY.md](https://github.com/zxuru/nn-anime/blob/main/SECURITY.md)
> del repositorio de la aplicación, y también en la pantalla de Ajustes.

## Qué hay

| Id | Sitio | Sirve (`media`) | Buscar | Sub | Dub | Tendencias | Feed | Episodios por página |
|---|---|---|---|---|---|---|---|---|
| `jkanime` | [jkanime.net](https://jkanime.net) | `anime` | sí | sí | no | sí | sí | sí |
| `animeav1` | [animeav1.com](https://animeav1.com) | `anime` | sí | sí | sí | sí | no | no |
| `pelisplushd` | [pelisplushd.bz](https://pelisplushd.bz) | `movies` | sí | sí | sí | no | no | no |
| `animex` | [animex.one](https://animex.one) | `anime` | sí | sí | sí | no | no | no |
| `cuevana3` | [cuevana3play.pro](https://cuevana3play.pro) | `movies` | sí | sí | no | no | no | no |
| `gnula` | [www2.gnula.one](https://www2.gnula.one) | `movies` | sí | sí | sí | no | no | no |

Los seis son adaptadores de lectura: piden las páginas del sitio, extraen lo que el contrato pide y
devuelven datos. Ninguno descarga, aloja ni redistribuye contenido, y ninguno guarda credenciales
—no hay ninguna que guardar.

Los seis declaran además `capabilities.media`, que es lo que nn-anime lee para saber **en qué mitad de
la aplicación** se busca en cada fuente: `anime` en `jkanime`, `animeav1` y `animex`, y `movies` en
`pelisplushd`, `cuevana3` y `gnula`. «Películas» es lo que **no** es anime —películas, series y
doramas, que van por el mismo camino—, no sólo el cine. El campo es opcional y ausente significa
`anime`, que es lo que eran los plugins de antes; aquí se escribe en los seis para que cada archivo
diga lo que sirve sin que haya que deducirlo, y para que la tabla de arriba y el código no puedan
decir cosas distintas.

Una fuente que sirviera las dos cosas declararía `both` y repartiría por el `kind` de cada título, que
es lo que distingue una película del resto. Ninguna de estas seis lo es: las tres de anime sirven
anime y las tres de películas sirven lo demás. En `cuevana3` eso tiene una consecuencia que conviene
saber: su catálogo es el de TMDB, así que el anime que TMDB tenga cae en la pestaña de películas,
porque esa fuente no distingue uno de otro.

`cuevana3` y `gnula` son los otros dos que sirven **películas**, y son sitios de español latino. Están
hechos de formas opuestas, y eso se nota en lo que cada uno puede prometer:

**`cuevana3` no tiene catálogo propio.** Es un escaparate de TMDB: su buscador, sus fichas y sus
episodios se pintan en el navegador pidiendo a `api.themoviedb.org` con una clave que el sitio publica
en su propio JavaScript, y la dirección de cada título es el identificador de TMDB disfrazado con una
sustitución de dígitos (`/pelicula/avatar-a11pp` es `76600`). El video tampoco lo sirve él: su página de
reproducción monta un `<iframe>` por cada uno de sus **seis servidores** ajenos. Así que este plugin
habla el mismo idioma que el sitio —pregunta a TMDB con esa misma clave, que **lee en tiempo de
ejecución** y no guarda— y luego va directo a los servidores, porque un reproductor dentro de otro no lo
abre `mpv`. De los seis, hoy se resuelven dos:

| Servidor del sitio | Qué es | Cómo se resuelve |
|---|---|---|
| 1. MoviesAPI | API JSON propia | Se le pide el manifiesto a su API; exige el `Referer` de MoviesAPI y una clave de reproductor que **también se lee en tiempo de ejecución** de su JavaScript. Es el que da **audio original con subtítulos en español** |
| 3. YapGrid | Elige entre sus motores, y el de fábrica es VixSrc | Tres peticiones a `vixsrc.to` —su API, su reproductor y el manifiesto con la firma que ese reproductor publica—. Da el **audio original** con pistas de subtítulos, sin español garantizado, así que es el respaldo |
| 2, 4, 5, 6 | VidCore, VidFast, VidSrc, EmbedMaster | **No se resuelven**, y está medido por qué. VidCore y VidFast no tienen una ruta de API que devuelva las fuentes: la lista es el cuerpo de un `POST` con un token que emite el servidor, y la descifra un **intérprete de bytecode** que vive dentro de su propia página. VidSrc **sí** se resolvió de punta a punta —su cadena termina en un manifiesto que contesta 200— pero el último paso es instanciar un **WebAssembly del propio sitio** para descifrar la lista, y este plugin no ejecuta código ajeno; queda documentado en el código, no implementado. EmbedMaster tiene un reto de Cloudflare que **no valida nada** (un `POST` con el campo vacío devuelve el reproductor entero), pero sus fuentes las descifra un paquete de 30 KB de cripto ofuscada. El plugin declara los seis y dice de cada uno por qué no lo usa, en vez de ofrecer un botón que no lleva a ninguna parte |

Que un título no esté «encodificado» en MoviesAPI es lo normal y no es un fallo del plugin: el servidor
lo dice con esas palabras y se prueba el siguiente. Por eso `dub` está en `false`: lo que estos
servidores entregan es audio original con subtítulos, no doblaje.

**`gnula` es un WordPress de los de antes**, y por eso es el más simple de los seis: la búsqueda es un
`?s=`, la ficha llega pintada en el HTML y no hay ni una API. Sólo publica películas —sus series viven en
otro dominio suyo— y **etiqueta el audio de cada reproductor**: la página agrupa sus `<iframe>` por
opción y cada grupo lleva delante su `opción 1, Latino, HD`, `opción 2, Castellano, HD` u `opción 3,
Subtitulado, HD`. Eso es exactamente lo que el contrato llama `mode`, así que aquí no hay nada que
adivinar: quien pide doblaje recibe latino antes que castellano, y quien pide subtítulos recibe el grupo
subtitulado antes que nada.

Tres de sus reproductores se resuelven, y ninguno es lo que parece:

| Reproductor | Cómo se resuelve |
|---|---|
| **Uqload** | Su página trae el empaquetador `eval(function(p,a,c,k,e,d){…})`, que se interpreta igual que en `pelisplushd`, y de ahí sale el manifiesto. Tiene una manía que está escrita en el código: hay que pedirle la página **sin `Referer`**, porque con el del sitio que lo incrusta contesta «Video embed restricted for this domain» |
| **Voe** | `voe.sx` no reproduce: contesta una página mínima cuyo único contenido es un `window.location.href = '<espejo>'`, y el espejo cambia de dominio cada pocos días. En el espejo los datos van ofuscados —ROT13, marcas de dos caracteres que se borran, un base64 que hay que desplazar carácter a carácter y leer del revés— y el resultado trae el manifiesto. Todo eso se deshace con aritmética de cadenas: **no se ejecuta el cargador del sitio** |
| **Filemoon** | Su API no publica el enlace: devuelve una **caja cerrada** —un `iv`, un `payload` cifrado y treinta trozos de clave— y la clave sale sólo de **dos** de esos trozos, los que eligen la `version` y `31 − version`; los otros veintiocho son señuelos. Se abre con AES-GCM desde `node:crypto`, igual que `pelisplushd` descifra su AES-CBC. Suelta una entrada por calidad y el plugin se queda con la mejor |

Y uno de sus `<iframe>` no es un reproductor sino un **selector**: `links.cuevana.ac` publica una página
con un botón por servidor —y ahí aparecen Voe, Filemoon, Mixdrop—, así que el plugin lo abre y pone lo
que encuentre **en el sitio que le tocaba en la cola**, no al final, porque el orden de la página es el
que dice qué conviene intentar primero. Los enlaces de descarga que también salen ahí no se tocan: no son
streams.

Lo que no se resuelve está declarado con su motivo, para que el mensaje de un fallo distinga «no lo hemos
mirado» de «está bloqueado y por esto»: `streamz.ws`, `dood.*` y `vtube.to` **no aceptan conexiones**
desde esta máquina —resuelven por DNS, pero el TCP se queda en nada—; `mixdrop` pide un token de
reCAPTCHA v3 para revelar el enlace; `upstream.to` presenta un certificado propio y contesta un bloqueo de
DDoS-Guard; y `waaw.to` y `player.cuevana.ac`, que son el mismo motor, piden un clic de verdad
—`isTrusted`— sobre una imagen de captcha, que una petición no puede dar.

**Medido en vivo, el 13 de octubre de 2026**: los dos resuelven de punta a punta —búsqueda, ficha,
episodios y un manifiesto HLS que contesta 200 con sus variantes— contra títulos reales, con acentos y
con eñes. Lo que queda sin comprobar es lo que el código declara como no resoluble: los reproductores de
`gnula` que no son Uqload, Voe ni Filemoon, y los servidores 2, 4, 5 y 6 de `cuevana3`.

`pelisplushd` sirve **películas y series**: devuelve `kind: 'movie'` o `'tv'`, una
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

Las reglas que este repositorio se pone a sí mismo:

1. **Nada de credenciales.** Ni tokens, ni cookies fijas, ni claves de API. Si un sitio exige una
   sesión, se obtiene en tiempo de ejecución y no se persiste.
2. **Nada de datos de nadie.** Ni listas de usuarios, ni historiales, ni ficheros de la máquina de
   quien escribe el plugin.
3. **Nada de ejecutar código ajeno.** Ni `eval`, ni `new Function`, ni intérpretes de bytecode, ni
   WebAssembly del sitio. El empaquetador de Dean Edwards se interpreta; lo que exija ejecutarse se
   declara con su motivo y no se usa.
4. **Nada de salir a la red interna.** Una dirección que elige el contenido del sitio se pide sólo
   si es http(s) y no apunta a loopback, a una red privada, a un enlace local ni a la metadata de
   la nube.

## Seguridad

Estos archivos se ejecutan **dentro del proceso de nn-anime, sin sandbox y con los permisos de quien
los copia**: el aviso de arriba no es retórico. Éstas son las guardas que llevan los seis, para que
una revisión futura sepa qué no se puede quitar sin querer:

| Guarda | Dónde | Por qué |
|---|---|---|
| Redacción de credenciales | `sinCredenciales()`, en los cuatro que meten una dirección en un mensaje | El motor redacta **por nombre de clave**: una credencial dentro de una cadena sólo la ve quien la escribe |
| Destino del contenido | `destinoDeContenidoAceptable()`, en los cinco que siguen una dirección elegida por el sitio | Una página comprometida no puede hacer que el plugin pida tu router, tu `127.0.0.1` ni `169.254.169.254` |
| Tope de cuerpo | `cuerpo()`, en los seis: 8 MiB | `text()` materializa en memoria lo que conteste el sitio |
| Dificultad acotada | `DIFICULTAD_MAXIMA`, en `pelisplushd` | `'0'.repeat(difficulty)` sin tope reserva gigabytes |
| Rutas de referencia | `rutaDe()` | Un `..` no mueve la petición a otra ruta del sitio, y la del paginador lleva la sesión |
| Cabeceras reenviadas | Lista blanca, en `animex` | Las cabeceras con las que se pide el medio no las elige un tercero |

Dos límites que conviene saber, porque no se pueden cerrar desde un plugin:

- La comprobación de destino es **literal**. Un nombre que resuelva a una dirección interna la
  esquiva: resolver y fijar la dirección no está al alcance de un `fetch`. La guarda completa vive
  en el motor, que sí resuelve y mira **todas** las respuestas del DNS. Al añadir una petición a una
  dirección que elige el sitio, se usan las funciones que ya están.
- La **excepción de la base interna**: si apuntas la dirección del sitio a tu propia máquina
  (`NN_ANIME_PELISPLUS_URL`, `NN_ANIME_GNULA_URL`, `NN_ANIME_CUEVANA3_URL`), la guarda se relaja,
  porque entonces la red interna *es* el sitio. Es para trabajar contra un sitio falso local; con la
  base pública, no se relaja nunca.

### Integridad de lo que copias

`SHA256SUMS` lleva el hash de los seis archivos. Sirve para lo que sirve un hash guardado junto al
código: comprobar que lo instalado es lo que leíste, no para defenderte de un repositorio
comprometido —quien pueda escribir aquí reescribe los dos—. Se regenera y se comprueba con:

```bash
sh scripts/hashes.sh                              # reescribe SHA256SUMS
sh scripts/hashes.sh --verificar ~/.config/nn-anime/providers
```

Y al instalar desde la aplicación, fija un **commit** y no una rama: con una rama, el código que se
ejecuta puede cambiar sin que hagas nada.

### Si quieres aislarlos

Copiar sólo lo que hayas leído es la mitigación barata. La cara es sacar los plugins del proceso de
la aplicación —que es lo que hoy no se hace— y darles una capacidad de red acotada: un proceso
aparte, sin acceso directo a la red, que salga por un proxy con la comprobación de destinos del
motor, con tope de memoria y de tiempo por llamada. Un sandbox que sólo aísle el sistema de archivos
no cambia nada aquí, porque el riesgo de estos archivos no es el disco: es a dónde se les puede
mandar y cuánto se les puede hacer tragar.

## Aviso

Estos archivos automatizan la lectura de sitios de terceros. Los sitios cambian —y a veces lo
prohíben—: úsalos para lo que son, en tu equipo, y asume lo que digan sus términos de uso. El
repositorio de la aplicación no incluye ninguno de estos archivos, y esta separación es justo el
motivo.

## Licencia

MIT. Ver [LICENSE](LICENSE).
