/**
 * La conformidad la comprueba el SDK del motor, que vive en otro repositorio.
 *
 * Sin él —el caso del CI de este repositorio, que no trae el SDK— la prueba se
 * salta y lo dice. Con él, es exactamente la comprobación que hace la aplicación
 * al cargar un plugin, así que un cambio que rompa el contrato se ve aquí.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIRECTORIO = join(import.meta.dir, '..', '..', 'providers')

interface Informe {
  readonly ok: boolean
  readonly problems?: readonly unknown[]
}

type Inspeccionar = (proveedor: unknown) => Informe

let inspectConformance: Inspeccionar | undefined

try {
  const sdk = (await import('@nn-anime/provider-sdk')) as { inspectConformance?: Inspeccionar }
  inspectConformance = sdk.inspectConformance
} catch {
  inspectConformance = undefined
}

const archivos = readdirSync(DIRECTORIO)
  .filter((uno) => uno.endsWith('.ts'))
  .sort()

if (inspectConformance === undefined) {
  console.log(
    'sin @nn-anime/provider-sdk: se salta la conformidad (el SDK vive en el repositorio del motor)',
  )
}

const suite = inspectConformance === undefined ? describe.skip : describe

suite('los seis cumplen el contrato del SDK', () => {
  for (const archivo of archivos) {
    test(archivo, async () => {
      const modulo = (await import(`../../providers/${archivo}`)) as { default?: unknown }
      const informe = inspectConformance?.(modulo.default)

      if (informe?.ok !== true) {
        console.log(`  ${archivo}: ${JSON.stringify(informe?.problems ?? [])}`)
      }

      expect(informe?.ok).toBe(true)
    })
  }
})
