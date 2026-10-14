/**
 * Lo que comparten las pruebas de seguridad.
 *
 * Construye la **capacidad de red** de mentira que un plugin recibe en
 * `CallOptions.fetch`, y ya no intercepta el `fetch` global: desde la migración
 * los seis salen por la capacidad, y `sin-fetch-global.test.ts` impide que vuelva
 * una llamada al global.
 *
 * La capacidad de verdad —la que aplica la lista blanca de destinos, resuelve el
 * nombre y fija la dirección— vive en el motor y se prueba allí. Aquí la de
 * mentira es **neutral a propósito**: no bloquea destinos internos, para que la
 * prueba que los descarta siga midiendo la guarda del plugin y no la del motor.
 */
import type { CallOptions, PluginFetch } from '@nn-anime/provider-sdk'

/** Una ruta de la tabla. Si el enrutador no la conoce, devuelve `undefined` y es un 404. */
export interface RespuestaFalsa {
  readonly body: string
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly setCookie?: readonly string[]
  readonly url?: string
}

export type Enrutador = (url: URL) => RespuestaFalsa | undefined

/** Una petición vista desde la prueba. */
export interface Peticion {
  readonly url: string
  /** El tope que el plugin pidió para esa respuesta, si pidió alguno. */
  readonly maxBytes: number | undefined
}

export interface Espia {
  /** Todas las direcciones que se llegaron a pedir, en orden. */
  readonly pedidas: readonly string[]
  /** Las peticiones enteras, con el tope que declaró el plugin en cada una. */
  readonly peticiones: readonly Peticion[]
  /** La capacidad que se le pasa al plugin en `CallOptions`. */
  readonly fetch: PluginFetch
}

/** Una capacidad de mentira que responde por ruta y no sale a la red. */
export function espiarFetch(enrutar: Enrutador): Espia {
  const pedidas: string[] = []
  const peticiones: Peticion[] = []

  const falso: PluginFetch = async (entrada, peticion) => {
    const url = new URL(entrada)
    pedidas.push(url.href)
    peticiones.push({ url: url.href, maxBytes: peticion?.maxBytes })

    const respuesta = enrutar(url)
    if (respuesta === undefined) {
      return { status: 404, url: url.href, headers: {}, setCookie: [], body: 'no está' }
    }

    return {
      status: respuesta.status ?? 200,
      url: respuesta.url ?? url.href,
      headers: respuesta.headers ?? {},
      setCookie: respuesta.setCookie ?? [],
      body: respuesta.body,
    }
  }

  return { pedidas, peticiones, fetch: falso }
}

/** Las opciones de la llamada, con la capacidad de la prueba dentro. */
export function opcionesDePrueba(red: PluginFetch, ms = 8000): CallOptions {
  return { signal: AbortSignal.timeout(ms), timeoutMs: ms, fetch: red }
}
