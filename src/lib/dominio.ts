// Lógica de negocio del registro como proveedor (funciones puras + lectura de fixtures).
// Las herramientas de src/tools/proveedor.ts solo orquestan estas funciones.
import path from "node:path"
import { ToolError } from "../core/tool"
import { listDirs, normalizar, readJson, safeId, similitud, exists } from "../core/util"

export type Formato = "xlsx" | "pdf" | "portal"
export type Solicitud = {
  id: string
  de: string
  para?: string
  asunto: string
  fecha: string
  pais: string
  cliente: string
  cuerpo: string
  formato: string
  adjuntos: string[]
}
export type CampoCelda = { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }
export type CampoPdf = { etiqueta: string; obligatorio: boolean }
export type Campo = { etiqueta: string; hoja?: string; celda_etiqueta?: string; celda_valor?: string; obligatorio?: boolean }
export type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null; pais_emisor: string; descripcion: string }
export type Valor = string | number | boolean

export type Reglas = {
  identificador_tributario_por_pais: Record<string, string>
  pais_del_maestro: string
  ruta_identificador_tributario: string
  etiquetas_ambiguas: string[]
  umbral_confianza: number
  umbral_sugerencia: number
  confianza_coincidencia_normalizada: number
  rutas_bancarias: string[]
  rutas_sensibles: string[]
  formatos_soportados: string[]
  formatos_solo_valores: string[]
  nombres_soporte: Record<string, string>
}

export type Lleno = { etiqueta: string; ruta: string; valor: Valor; confianza: number; fuente: string; sensible?: boolean }
export type Faltante = { etiqueta: string; motivo: string; obligatorio?: boolean }
export type PorConfirmar = { etiqueta: string; ruta: string | null; valor_propuesto: Valor | null; confianza: number; motivo: string }
export type Mapeo = { llenos: Lleno[]; faltantes: Faltante[]; requiere_confirmacion: PorConfirmar[] }

export const rutas = (dir: string) => {
  const base = path.join(dir, "fixtures", "reto-01")
  return {
    base,
    casos: path.join(base, "casos"),
    caso: (c: string) => path.join(base, "casos", c),
    maestro: path.join(base, "repositorio", "maestro.json"),
    soportes: path.join(base, "repositorio", "soportes"),
    glosario: path.join(base, "glosario-campos.json"),
    reglas: path.join(dir, "src", "knowledge", "reglas-proveedor.json"),
    out: (c: string) => path.join(dir, "out", c),
  }
}

export async function cargarReglas(dir: string): Promise<Reglas> {
  return readJson<Reglas>(rutas(dir).reglas, "las reglas de negocio")
}

export async function validarCaso(dir: string, caso: string): Promise<string> {
  safeId(caso, "caso")
  if (!(await exists(path.join(rutas(dir).caso(caso), "solicitud.json")))) {
    const disponibles = await listDirs(rutas(dir).casos)
    throw new ToolError(`el caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ") || "ninguno"}`)
  }
  return caso
}

export function formatoDe(s: Solicitud): Formato {
  if (s.formato === "xlsx" || s.formato === "pdf" || s.formato === "portal") return s.formato
  throw new ToolError(`formato no soportado: "${s.formato}". Formatos conocidos: xlsx, pdf, portal`)
}

export type LecturaCaso = {
  solicitud: Solicitud
  formato: Formato
  campos: Campo[]
  soportes: string[]
  advertencias: string[]
}

/** Lee solicitud, plantilla y soportes. Una plantilla corrupta no aborta: se reporta como advertencia. */
export async function leerCaso(dir: string, caso: string): Promise<LecturaCaso> {
  await validarCaso(dir, caso)
  const carpeta = rutas(dir).caso(caso)
  const solicitud = await readJson<Solicitud>(path.join(carpeta, "solicitud.json"), "la solicitud (solicitud.json)")
  const advertencias: string[] = []
  let formato: Formato
  try {
    formato = formatoDe(solicitud)
  } catch (e) {
    advertencias.push((e as Error).message)
    formato = "portal"
  }
  let campos: Campo[] = []
  const archivoPlantilla = formato === "xlsx" ? "plantilla-celdas.json" : "plantilla-campos.json"
  try {
    if (formato === "xlsx") {
      const celdas = await readJson<CampoCelda[]>(path.join(carpeta, archivoPlantilla), `la plantilla ${archivoPlantilla}`)
      if (!Array.isArray(celdas)) throw new ToolError(`la plantilla ${archivoPlantilla} no es una lista`)
      campos = celdas.map((c) => ({ etiqueta: c.etiqueta, hoja: c.hoja, celda_etiqueta: c.celda_etiqueta, celda_valor: c.celda_valor }))
    } else if (await exists(path.join(carpeta, archivoPlantilla))) {
      const lista = await readJson<CampoPdf[]>(path.join(carpeta, archivoPlantilla), `la plantilla ${archivoPlantilla}`)
      if (!Array.isArray(lista)) throw new ToolError(`la plantilla ${archivoPlantilla} no es una lista`)
      campos = lista.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
    } else {
      advertencias.push(`no hay ${archivoPlantilla}: no puedo listar los campos del ${formato}`)
    }
    const invalidos = campos.filter((c) => typeof c.etiqueta !== "string" || !c.etiqueta.trim())
    if (invalidos.length) throw new ToolError(`la plantilla tiene ${invalidos.length} campo(s) sin etiqueta`)
  } catch (e) {
    advertencias.push(`${(e as Error).message}. Continúo con los soportes; el formulario no se puede generar hasta corregir la plantilla.`)
    campos = []
  }
  let soportes: string[] = []
  try {
    soportes = await readJson<string[]>(path.join(carpeta, "soportes-exigidos.json"), "soportes-exigidos.json")
  } catch (e) {
    advertencias.push((e as Error).message)
  }
  return { solicitud, formato, campos, soportes, advertencias }
}

export function valorEnRuta(obj: unknown, ruta: string): Valor | null {
  let actual: unknown = obj
  for (const parte of ruta.split(".")) {
    if (!actual || typeof actual !== "object") return null
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (typeof actual === "string") return actual.trim() === "" ? null : actual
  if (typeof actual === "number" || typeof actual === "boolean") return actual
  return null
}

type Resolucion = { ruta: string; confianza: number; via: string } | null

/** Resuelve una etiqueta contra el glosario: exacta → normalizada → similitud de texto. */
export function resolverEtiqueta(etiqueta: string, glosario: Record<string, string>, reglas: Reglas): Resolucion {
  if (glosario[etiqueta]) return { ruta: glosario[etiqueta], confianza: 1, via: "glosario (exacta)" }
  const n = normalizar(etiqueta)
  for (const [k, v] of Object.entries(glosario)) {
    if (normalizar(k) === n) return { ruta: v, confianza: reglas.confianza_coincidencia_normalizada, via: `glosario (normalizada: "${k}")` }
  }
  let mejor: { k: string; v: string; s: number } | null = null
  for (const [k, v] of Object.entries(glosario)) {
    const s = similitud(etiqueta, k)
    if (!mejor || s > mejor.s) mejor = { k, v, s }
  }
  if (mejor && mejor.s >= reglas.umbral_sugerencia) {
    return { ruta: mejor.v, confianza: Math.round(mejor.s * 100) / 100, via: `similitud con "${mejor.k}"` }
  }
  return null
}

export function mapear(
  etiquetas: Array<{ etiqueta: string; obligatorio?: boolean }>,
  pais: string,
  maestro: unknown,
  glosario: Record<string, string>,
  reglas: Reglas,
): Mapeo {
  const m: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  const idPais = reglas.identificador_tributario_por_pais[pais] ?? "identificador tributario"
  for (const { etiqueta, obligatorio } of etiquetas) {
    const r = resolverEtiqueta(etiqueta, glosario, reglas)
    if (!r) {
      m.faltantes.push({ etiqueta, motivo: "no hay equivalente en el glosario ni en el maestro", ...(obligatorio !== undefined ? { obligatorio } : {}) })
      continue
    }
    const valor = valorEnRuta(maestro, r.ruta)
    if (valor === null) {
      m.faltantes.push({ etiqueta, motivo: `el maestro no tiene dato en "${r.ruta}"`, ...(obligatorio !== undefined ? { obligatorio } : {}) })
      continue
    }
    if (r.ruta === reglas.ruta_identificador_tributario) {
      if (reglas.etiquetas_ambiguas.some((a) => normalizar(a) === normalizar(etiqueta))) {
        m.requiere_confirmacion.push({ etiqueta, ruta: r.ruta, valor_propuesto: valor, confianza: 0.6, motivo: `etiqueta ambigua; en ${pais} el equivalente es ${idPais}` })
        continue
      }
      if (pais !== reglas.pais_del_maestro) {
        m.requiere_confirmacion.push({
          etiqueta,
          ruta: r.ruta,
          valor_propuesto: valor,
          confianza: 0.6,
          motivo: `identificador extranjero: el cliente (${pais}) pide ${idPais} y Periferia solo tiene NIT colombiano; se llena con el NIT`,
        })
        continue
      }
    }
    if (r.confianza < reglas.umbral_confianza) {
      m.requiere_confirmacion.push({ etiqueta, ruta: r.ruta, valor_propuesto: valor, confianza: r.confianza, motivo: `mapeo con confianza baja (${r.via})` })
      continue
    }
    m.llenos.push({
      etiqueta,
      ruta: r.ruta,
      valor,
      confianza: r.confianza,
      fuente: `maestro.${r.ruta} vía ${r.via}`,
      ...(reglas.rutas_sensibles.includes(r.ruta) || reglas.rutas_bancarias.includes(r.ruta) ? { sensible: true } : {}),
    })
  }
  return m
}

export async function cargarMaestroYGlosario(dir: string): Promise<{ maestro: unknown; glosario: Record<string, string> }> {
  const r = rutas(dir)
  const maestro = await readJson<unknown>(r.maestro, "el repositorio maestro")
  const glosario = await readJson<Record<string, string>>(r.glosario, "el glosario de campos")
  return { maestro, glosario }
}

export async function mapeoDelCaso(dir: string, caso: string): Promise<{ lectura: LecturaCaso; mapeo: Mapeo; reglas: Reglas }> {
  const lectura = await leerCaso(dir, caso)
  const reglas = await cargarReglas(dir)
  const { maestro, glosario } = await cargarMaestroYGlosario(dir)
  const mapeo = mapear(lectura.campos, lectura.solicitud.pais, maestro, glosario, reglas)
  return { lectura, mapeo, reglas }
}

export type EstadoSoporte = { tipo: string; nombre: string; estado: "presente" | "ausente" | "vencido"; archivo: string | null; vigencia_hasta: string | null }

export function evaluarSoportes(exigidos: string[], indice: Soporte[], hoy: string, reglas: Reglas): EstadoSoporte[] {
  return exigidos.map((tipo) => {
    const s = indice.find((x) => x.tipo === tipo)
    const nombre = reglas.nombres_soporte[tipo] ?? tipo
    if (!s) return { tipo, nombre, estado: "ausente", archivo: null, vigencia_hasta: null }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < hoy
    return { tipo, nombre, estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta }
  })
}
