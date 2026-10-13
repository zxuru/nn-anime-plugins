/**
 * Lo que comparten las pruebas de seguridad.
 *
 * Intercepta el `fetch` global, que es la puerta que tienen hoy los plugins para
 * salir a la red, y **además** adjunta el falso a `CallOptions`: cuando el
 * contrato traiga la capacidad inyectada, el plugin leerá de ahí y la
 * intercepción del global se podrá quitar sin tocar las pruebas.
 */
import type { CallOptions } from '@nn-anime/provider-sdk'

/** Un `fetch` de mentira que responde por ruta. Si devuelve `undefined`, es un 404. */
export type Enrutador = (url: URL) => Response | undefined

export interface Espia {
  /** Todas las direcciones que se llegaron a pedir, en orden. */
  readonly pedidas: readonly string[]
  readonly fetch: typeof fetch
  /** Devuelve el `fetch` de verdad al global. */
  restaurar(): void
}

/** Sustituye el `fetch` global por uno que no sale a la red. */
export function espiarFetch(enrutar: Enrutador): Espia {
  const pedidas: string[] = []
  const original = globalThis.fetch

  const falso = (async (entrada: unknown): Promise<Response> => {
    const url = new URL(typeof entrada === 'string' ? entrada : String(entrada))
    pedidas.push(url.href)

    return enrutar(url) ?? new Response('no está', { status: 404 })
  }) as typeof fetch

  globalThis.fetch = falso

  return {
    pedidas,
    fetch: falso,
    restaurar: () => {
      globalThis.fetch = original
    },
  }
}

/**
 * Opciones de llamada con el `fetch` de la prueba dentro.
 *
 * `fetch` todavía no está en el contrato —lo estará—, así que se adjunta con una
 * aserción en vez de esperar a que el SDK lo declare. El global sigue mandando
 * hoy; cuando no, esta es la mitad que queda.
 */
export function opcionesDePrueba(falso: typeof fetch, ms = 8000): CallOptions {
  return { signal: AbortSignal.timeout(ms), timeoutMs: ms, fetch: falso } as CallOptions
}
