/**
 * La regla que hace posible el aislamiento: un plugin sale a la red por la
 * capacidad que le da el motor, no por el `fetch` global.
 *
 * Hoy los seis lo usan directamente, así que hay una **línea base** con las
 * llamadas que quedan. La prueba falla si aparece una nueva y avisa cuando baja,
 * que es lo que hará la migración a la capacidad inyectada hasta dejarla en cero.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIRECTORIO = join(import.meta.dir, '..', '..', 'providers')

/** Llamadas al `fetch` global que quedan, por archivo. */
const LINEA_BASE: Readonly<Record<string, number>> = {
  'animeav1.ts': 2,
  'animex.ts': 1,
  'cuevana3.ts': 1,
  'gnula.ts': 1,
  'jkanime.ts': 1,
  'pelisplushd.ts': 1,
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

  test('están exactamente los seis proveedores de la línea base', () => {
    const archivos = readdirSync(DIRECTORIO)
      .filter((uno) => uno.endsWith('.ts'))
      .sort()

    expect(archivos).toEqual(Object.keys(LINEA_BASE).sort())
  })
})
