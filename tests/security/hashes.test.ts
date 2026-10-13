/**
 * H-11: lo que se copia es lo que se revisó.
 *
 * `SHA256SUMS` se calcula sobre el contenido **sin CR**, porque `core.autocrlf`
 * reescribe los finales de línea en un checkout de Windows y el hash de un
 * archivo que nadie tocó cambiaría. Así el hash delata una edición de verdad.
 *
 * El mismo cálculo lo hace `scripts/hashes.sh`, que es lo que corre quien verifica
 * una copia instalada a mano; esta prueba es la que vigila el repositorio.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RAIZ = join(import.meta.dir, '..', '..')
const SUMAS = join(RAIZ, 'SHA256SUMS')

/** El hash canónico de un archivo: sin CR, y en hexadecimal minúsculo. */
function hashDe(ruta: string): string {
  const bytes = readFileSync(ruta)
  const limpios = Buffer.from(bytes.filter((byte) => byte !== 0x0d))

  return createHash('sha256').update(limpios).digest('hex')
}

const lineas = readFileSync(SUMAS, 'utf8')
  .split('\n')
  .map((linea) => linea.trimEnd())
  .filter((linea) => linea !== '')
  .map((linea) => {
    const corte = linea.indexOf('  ')
    return { esperado: linea.slice(0, corte), archivo: linea.slice(corte + 2) }
  })

describe('los hashes de los plugins', () => {
  test('el archivo tiene los seis y ningún nombre repetido', () => {
    expect(lineas).toHaveLength(6)
    expect(new Set(lineas.map((uno) => uno.archivo)).size).toBe(6)
  })

  for (const { esperado, archivo } of lineas) {
    test(`${archivo} es el que se revisó`, () => {
      expect(hashDe(join(RAIZ, 'providers', archivo))).toBe(esperado)
    })
  }
})
