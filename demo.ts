// demo.ts — ejecuta las herramientas SIN modelo sobre todos los casos de fixtures/reto-01/casos/.
// Uso: bun install && bun run demo.ts        (FECHA_REFERENCIA=YYYY-MM-DD para cambiar la fecha)
import path from "node:path"
import { rm, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { registrarHerramientas } from "./src/core/registry"
import { runTool } from "./src/core/run"
import { listDirs, setRaiz } from "./src/core/util"
import { APP } from "./src/config"
import { leerXlsx } from "./src/lib/xlsx"
import { verificarModulo } from "./scripts/modulo"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
setRaiz(ROOT)
// Fecha fija por defecto (fecha del PRD) para que la demo sea determinista en cualquier día.
const HOY = process.env.FECHA_REFERENCIA || "2026-09-03"
const ctx = { directory: ROOT, sessionId: "demo" }
const tools = new Map(registrarHerramientas(APP.herramientas).map((t) => [t.nombre, t.tool]))

type Data = Record<string, unknown>
async function llamar(nombre: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Data; error?: string }> {
  const tool = tools.get(nombre)
  if (!tool) throw new Error(`herramienta no registrada: ${nombre}`)
  const run = await runTool(nombre, tool, args, ctx)
  return run.resultado.ok ? { ok: true, data: run.resultado.data as Data } : { ok: false, data: {}, error: run.resultado.error }
}

const linea = (s = "") => console.log(s)

async function procesar(caso: string): Promise<void> {
  linea(`\n━━━ ${caso} ${"━".repeat(Math.max(0, 60 - caso.length))}`)
  const sol = await llamar("proveedor_leer_solicitud", { caso })
  if (!sol.ok) return linea(`  ✖ ${sol.error}`)
  linea(`  Cliente: ${sol.data.cliente} (${sol.data.pais}) · formato: ${sol.data.formato} · ${(sol.data.campos as string[]).length} campos`)
  for (const a of sol.data.advertencias as string[]) linea(`  ⚠ ${a}`)

  const map = await llamar("proveedor_mapear_campos", { caso, campos: sol.data.campos })
  if (!map.ok) return linea(`  ✖ ${map.error}`)
  const llenos = map.data.llenos as Array<{ etiqueta: string; ruta: string; valor: unknown }>
  const faltantes = map.data.faltantes as Array<{ etiqueta: string }>
  const porConf = map.data.requiere_confirmacion as Array<{ etiqueta: string; motivo: string }>
  linea(`  Mapeo: ${llenos.length} llenos · ${faltantes.length} faltantes · ${porConf.length} por confirmar`)
  if (faltantes.length) linea(`    faltantes: ${faltantes.map((f) => f.etiqueta).join(", ")}`)
  for (const c of porConf) linea(`    por confirmar: ${c.etiqueta} → ${c.motivo}`)

  const form = await llamar("proveedor_generar_formulario", {
    caso,
    mapeo: { llenos: llenos.map((l) => ({ etiqueta: l.etiqueta, ruta: l.ruta, valor: l.valor })) },
  })
  if (!form.ok) linea(`  ✖ formulario: ${form.error}`)
  else {
    linea(`  Formulario: ${form.data.ruta}${form.data.aviso ? `  (${form.data.aviso})` : ""}`)
    if (form.data.formato === "xlsx") await verificarCeldas(caso, String(form.data.ruta), llenos)
  }

  const paq = await llamar("proveedor_armar_paquete", { caso, hoy: HOY })
  if (!paq.ok) return linea(`  ✖ paquete: ${paq.error}`)
  const checklist = paq.data.checklist as Array<{ soporte: string; estado: string }>
  linea(`  Soportes: ${checklist.map((c) => `${c.soporte}=${c.estado}`).join(" · ")}`)
  linea(`  listo_para_firma: ${paq.data.listo_para_firma ? "SÍ" : "NO"}${(paq.data.bloqueos as string[]).length ? `  ← ${(paq.data.bloqueos as string[]).join("; ")}` : ""}`)
  linea(`  Paquete: ${paq.data.ruta}`)
}

/** Lee el .xlsx generado y comprueba que cada valor lleno quedó en su hoja/celda exacta. */
async function verificarCeldas(caso: string, ruta: string, llenos: Array<{ etiqueta: string; valor: unknown }>): Promise<void> {
  const plantilla = JSON.parse(await readFile(path.join(ROOT, "fixtures/reto-01/casos", caso, "plantilla-celdas.json"), "utf8")) as Array<{
    hoja: string
    celda_etiqueta: string
    etiqueta: string
    celda_valor: string
  }>
  const hojas = await leerXlsx(new Uint8Array(await readFile(path.join(ROOT, ruta))))
  let errores = 0
  for (const p of plantilla) {
    if (hojas[p.hoja]?.[p.celda_etiqueta] !== p.etiqueta) errores++
    const l = llenos.find((x) => x.etiqueta === p.etiqueta)
    if (l && hojas[p.hoja]?.[p.celda_valor] !== String(l.valor)) errores++
  }
  linea(`  Verificación celda a celda del xlsx: ${errores === 0 ? "OK" : `${errores} diferencia(s)`}`)
}

async function main(): Promise<void> {
  await rm(path.join(ROOT, "out"), { recursive: true, force: true })
  linea(`Demo Reto 01 · Registro como proveedor · fecha de referencia ${HOY} · sin modelo de lenguaje`)
  const casos = await listDirs(path.join(ROOT, "fixtures/reto-01/casos"))
  for (const caso of casos) await procesar(caso)

  linea("\n━━━ Errores controlados (HU-5) ━━━")
  const inexistente = await llamar("proveedor_leer_solicitud", { caso: "no-existe" })
  linea(`  Caso inexistente → ok=${inexistente.ok}: ${inexistente.error}`)
  const traversal = await llamar("proveedor_leer_solicitud", { caso: "../../etc" })
  linea(`  Ruta maliciosa → ok=${traversal.ok}: ${traversal.error}`)
  const inventado = await llamar("proveedor_generar_formulario", {
    caso: "co-industrias-delta",
    mapeo: { llenos: [{ etiqueta: "NIT", ruta: "nit", valor: "999999999" }] },
  })
  linea(`  Valor inventado por el modelo → ok=${inventado.ok}: ${inventado.error}`)

  linea("\n━━━ Envío simulado (RN4) ━━━")
  const sinConf = await llamar("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: false })
  linea(`  Sin confirmación → ok=${sinConf.ok}: ${sinConf.error}`)
  const conConf = await llamar("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true })
  linea(`  Con confirmación explícita → ok=${conConf.ok}: ${conConf.ok ? conConf.data.ruta : conConf.error}`)

  const mod = await verificarModulo(ROOT)
  linea(`\nMódulo reutilizable (modulo/) sincronizado con la app: ${mod.ok ? "sí" : `NO → ${mod.diferencias.join(", ")} (ejecuta bun run modulo)`}`)
  linea("Logs: out/log.jsonl y out/<caso>/log.jsonl\n")
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e instanceof Error ? e.message : e)
  process.exitCode = 1
})
