# Pruebas de seguridad

```bash
bun test tests/security
```

Sin red, sin dependencias y sin certificados: cada prueba le da al plugin un `fetch` de mentira que
responde por ruta. Si una pide una dirección que no está en la tabla, recibe un 404 y falla.

| Archivo | Qué comprueba | Hallazgo |
|---|---|---|
| `destino.test.ts` | Que una dirección elegida por el contenido del sitio no llegue a pedirse si es interna —el `<iframe>` **y** el espejo que ese `<iframe>` publica, que son dos guardas distintas—, que un cuerpo de 9 MiB se corte, que el plugin declare su tope en cada petición y que la base interna configurada a mano siga funcionando | H-02, H-04 |
| `redaccion.test.ts` | Que la clave de TMDB no aparezca en el mensaje de un 401 ni de un corte de red, sin perder el diagnóstico | H-01 |
| `sin-fetch-global.test.ts` | Que ningún plugin llame al `fetch` global **y** que los seis lean la capacidad del motor: la línea base está en cero y cualquier llamada nueva la deja en rojo | H-02 |
| `conformidad.test.ts` | Que los seis sigan cumpliendo el contrato del SDK. Se salta si `@nn-anime/provider-sdk` no está —este repositorio no lo trae, el motor sí— y con él es la misma comprobación que hace la aplicación al cargar | — |

## Cómo interceptan la red

`apoyo.ts` construye la **capacidad de red** de mentira y la pone en `CallOptions`. Ya no sustituye el
`fetch` global, porque no queda ninguna llamada a él. El doble es **neutral a propósito**: no bloquea
destinos internos, así que las pruebas que los descartan siguen midiendo la guarda del plugin y no la
del motor. La capacidad de verdad —la que resuelve el nombre y fija la dirección— se prueba en el
repositorio del motor.

## Tipos

`bunx tsc -p tsconfig.json` necesita el repositorio del motor **al lado** (`../nn-anime`), porque los
tipos de `CallOptions`, `Provider` y compañía vienen de `@nn-anime/provider-sdk`, y el `tsconfig.json`
de la raíz los mapea ahí. Sin ese checkout, `bun test` sigue funcionando (los `import type` se borran
al ejecutar) pero el typecheck no.
