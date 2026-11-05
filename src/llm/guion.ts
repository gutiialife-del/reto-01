// Guion del proveedor SIMULADO (no es un LLM). Reproduce el flujo del prompt de ejemplo para probar
// el ciclo, la compuerta de confirmación y el front sin clave de API.
import type { EstadoTurno, Guion, PasoGuion } from "./simulado"
import type { ChatMessage } from "./adapter"

const llamar = (name: string, args: Record<string, unknown>): PasoGuion => ({ text: "", toolCalls: [{ id: "", name, args }] })
const decir = (text: string): PasoGuion => ({ text, toolCalls: [] })

function ultimoCaso(historial: ChatMessage[]): string | null {
  for (let i = historial.length - 1; i >= 0; i--) {
    const m = historial[i]
    if (m?.role === "assistant") for (const tc of m.toolCalls) if (typeof tc.args.caso === "string") return tc.args.caso
  }
  return null
}

type Data = Record<string, unknown>
const dato = (e: EstadoTurno, nombre: string): Data | null => {
  const r = [...e.resultados].reverse().find((x) => x.name === nombre)
  return r && r.ok ? (r.data as Data) : null
}

export const guion: Guion = (e) => {
  const texto = e.usuario.toLowerCase()
  const caso = e.usuario.match(/\b([a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)+)\b/)?.[1] ?? null
  const hechas = new Set(e.resultados.map((r) => r.name))
  const confirmaEnvio = /(env[ií]a|confirmo|procede|s[ií],)/.test(texto) && !caso

  if (confirmaEnvio) {
    const c = ultimoCaso(e.historial)
    if (!c) return decir("No tengo un caso en curso. Indícame cuál procesar.")
    if (!hechas.has("proveedor_simular_envio")) return llamar("proveedor_simular_envio", { caso: c, confirmado: true })
    const r = e.resultados.find((x) => x.name === "proveedor_simular_envio")
    if (!r?.ok) {
      if (!hechas.has("agente_solicitar_confirmacion")) return llamar("agente_solicitar_confirmacion", { accion: `simular envío de ${c}`, detalle: "El envío necesita tu confirmación explícita." })
      return decir(`No ejecuté el envío: la confirmación no era válida. ¿Confirmas que simule el envío del paquete de **${c}**?`)
    }
    const d = r.data as Data
    return decir(`Listo. Registré el envío simulado en \`${String(d.ruta)}\`. No se envió ningún correo real.`)
  }

  if (!caso) return decir('Indícame el caso a procesar, por ejemplo: *Procesa el caso "ec-corp-andina"*.')
  if (!hechas.has("proveedor_leer_solicitud")) return llamar("proveedor_leer_solicitud", { caso })
  const sol = dato(e, "proveedor_leer_solicitud")
  if (!sol) return decir(`No pude leer el caso "${caso}": ${JSON.stringify(e.resultados.at(-1)?.data ?? "error")}`)
  if (!hechas.has("proveedor_mapear_campos")) return llamar("proveedor_mapear_campos", { caso, campos: sol.campos })
  const map = dato(e, "proveedor_mapear_campos")
  if (!hechas.has("proveedor_generar_formulario")) {
    return llamar("proveedor_generar_formulario", { caso, mapeo: { llenos: ((map?.llenos as Data[]) ?? []).map((l) => ({ etiqueta: l.etiqueta, ruta: l.ruta, valor: l.valor })) } })
  }
  if (!hechas.has("proveedor_armar_paquete")) return llamar("proveedor_armar_paquete", { caso })
  const paq = dato(e, "proveedor_armar_paquete")
  if (!hechas.has("agente_solicitar_confirmacion")) {
    return llamar("agente_solicitar_confirmacion", { accion: `simular envío de ${caso}`, detalle: "Escribir ENVIO-SIMULADO.md con el paquete actual." })
  }
  const form = dato(e, "proveedor_generar_formulario")
  const falt = ((map?.faltantes as Data[]) ?? []).map((f) => String(f.etiqueta))
  const conf = ((map?.requiere_confirmacion as Data[]) ?? []).map((f) => `${String(f.etiqueta)} (${String(f.motivo)})`)
  const check = ((paq?.checklist as Data[]) ?? []).map((c) => `| ${String(c.soporte)} | ${String(c.estado)} | ${String(c.vigencia_hasta ?? "no aplica")} |`)
  return decir(
    [
      `**${String(sol.cliente)}** (${String(sol.pais)}) · formato ${String(sol.formato)} · **${paq?.listo_para_firma ? "LISTO para firma" : "NO listo para firma"}**`,
      "",
      `- Campos llenos: ${((map?.llenos as unknown[]) ?? []).length}`,
      `- Faltantes: ${falt.join(", ") || "ninguno"}`,
      `- Por confirmar: ${conf.join("; ") || "ninguno"}`,
      form?.aviso ? `- ${String(form.aviso)}` : `- Formulario: ${String(form?.ruta ?? "no generado")}`,
      "",
      "| Soporte | Estado | Vigencia |",
      "|---|---|---|",
      ...check,
      "",
      `Paquete: \`${String(paq?.ruta ?? "")}\``,
      "",
      "_Respuesta generada por el proveedor simulado (guion de pruebas, sin LLM)._",
      "",
      "¿Confirmas que simule el envío del paquete?",
    ].join("\n"),
  )
}
