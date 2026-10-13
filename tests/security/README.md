# Pruebas de seguridad

```bash
bun test tests/security
```

Sin red, sin dependencias y sin certificados: cada prueba le da al plugin un `fetch` de mentira que
responde por ruta. Si una pide una dirección que no está en la tabla, recibe un 404 y falla.

| Archivo | Qué comprueba | Hallazgo |
|---|---|---|
| `destino.test.ts` | Que una dirección elegida por el contenido del sitio no llegue a pedirse si es interna (loopback, metadata de nube, IPv4 mapeada en IPv6), que un cuerpo de 9 MiB se corte, y que la base interna configurada a mano siga funcionando | H-02, H-04 |
| `redaccion.test.ts` | Que la clave de TMDB no aparezca en el mensaje de un 401 ni de un corte de red, sin perder el diagnóstico | H-01 |
| `sin-fetch-global.test.ts` | Que ningún plugin añada llamadas al `fetch` global. Hay una línea base con las que quedan: la prueba falla si aparece una nueva y avisa cuando baja, que es lo que hará la migración a la capacidad inyectada hasta dejarla en cero | H-02 |
| `conformidad.test.ts` | Que los seis sigan cumpliendo el contrato del SDK. Se salta si `@nn-anime/provider-sdk` no está —este repositorio no lo trae, el motor sí— y con él es la misma comprobación que hace la aplicación al cargar | — |

## Cómo interceptan la red

`apoyo.ts` sustituye el `fetch` global y **además** adjunta el falso a `CallOptions`, porque hoy los
plugins usan el global y después usarán la capacidad inyectada. Las pruebas valen en los dos mundos;
cuando la migración esté hecha, se quita la intercepción del global y quedan igual.

## Tipos

`bunx tsc -p tsconfig.json` necesita el repositorio del motor **al lado** (`../nn-anime`), porque los
tipos de `CallOptions`, `Provider` y compañía vienen de `@nn-anime/provider-sdk`, y el `tsconfig.json`
de la raíz los mapea ahí. Sin ese checkout, `bun test` sigue funcionando (los `import type` se borran
al ejecutar) pero el typecheck no.
