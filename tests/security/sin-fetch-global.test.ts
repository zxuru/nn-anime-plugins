/**
 * La regla que hace posible el aislamiento: un plugin sale a la red por la
 * capacidad que le da el motor, no por el `fetch` global.
 *
 * Los seis ya están migrados, así que la línea base es **cero**: cualquier
 * llamada nueva al `fetch` global deja esta prueba en rojo. No es una regla de
 * estilo: la capacidad es la que aplica la lista blanca de destinos, resuelve el
 * nombre una vez y fija la dirección, y salir por el global es saltarse las tres
 * cosas sin que nadie lo mire.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIRECTORIO = join(import.meta.dir, '..', '..', 'providers')

/** Llamadas al `fetch` global que quedan, por archivo. Cero, y se defiende. */
const LINEA_BASE: Readonly<Record<string, number>> = {
  'animeav1.ts': 0,
  'animex.ts': 0,
  'cuevana3.ts': 0,
  'gnula.ts': 0,
  'jkanime.ts': 0,
  'pelisplushd.ts': 0,
}

/** Un `fetch(` que no venga de una propiedad: `opciones.fetch(` no cuenta. */
const LLAMADA_GLOBAL = /(?<![.\w$])fetch\s*\(/g

function fuenteDe(archivo: string): string {
  return readFileSync(join(DIRECTORIO, archivo), 'utf8')
}

describe('ningún plugin llama al `fetch` global', () => {
  for (const [archivo, base] of Object.entries(LINEA_BASE)) {
    test(`${archivo} no añade llamadas a la línea base`, () => {
      const cuantas = [...fuenteDe(archivo).matchAll(LLAMADA_GLOBAL)].length

      expect(cuantas).toBeLessThanOrEqual(base)
      if (cuantas < base) {
        console.log(`  ${archivo}: baja de ${base} a ${cuantas}; actualiza la línea base`)
      }
    })
  }

  test('ningún plugin toca `globalThis.fetch`', () => {
    for (const archivo of readdirSync(DIRECTORIO).filter((uno) => uno.endsWith('.ts'))) {
      expect(fuenteDe(archivo)).not.toContain('globalThis.fetch')
    }
  })

  /**
   * La mitad positiva de la regla: no basta con no llamar al global, hay que
   * salir por la capacidad. Sin esta comprobación, un plugin que dejara de salir
   * a la red —o que volviera al global con una llamada que el patrón no ve—
   * pasaría la primera mitad sin que nadie lo notara.
   */
  test('los seis leen la capacidad del motor', () => {
    for (const archivo of Object.keys(LINEA_BASE)) {
      expect(/opciones\.fetch|options\.fetch/.test(fuenteDe(archivo))).toBe(true)
    }
  })

  test('están exactamente los seis proveedores de la línea base', () => {
    const archivos = readdirSync(DIRECTORIO)
      .filter((uno) => uno.endsWith('.ts'))
      .sort()

    expect(archivos).toEqual(Object.keys(LINEA_BASE).sort())
  })
})
