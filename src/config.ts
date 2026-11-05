// Configuración de la aplicación: qué herramientas se publican y qué conocimiento recibe el agente.
// Comportamiento → agent/prompt.md · Conocimiento → src/knowledge/ · Ejecución → src/tools/.
import path from "node:path"
import { readText, fechaReferencia } from "./core/util"
import * as agente from "./tools/agente"
import * as proveedor from "./tools/proveedor"

export const APP = {
  nombre: "Registro como Proveedor",
  herramientas: { proveedor, agente } as Record<string, Record<string, unknown>>,
  conocimiento: ["src/knowledge/registro-proveedor.md"],
  ejemplos: [
    'Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.',
    'Procesa el caso "co-industrias-delta" y arma el paquete para firma.',
    'Procesa el caso "pa-logistica-istmo".',
  ],
}

export async function cargarSystemPrompt(root: string): Promise<string> {
  const prompt = (await readText(path.join(root, "agent", "prompt.md"))) ?? ""
  const partes = [prompt.trim()]
  for (const archivo of APP.conocimiento) {
    const texto = await readText(path.join(root, archivo))
    if (texto) partes.push(`\n\n---\n# Conocimiento del proceso (${archivo})\n\n${texto.trim()}`)
  }
  let fecha = ""
  try {
    fecha = fechaReferencia()
  } catch {
    fecha = "desconocida (FECHA_REFERENCIA inválida)"
  }
  partes.push(`\n\n---\nFecha de referencia de esta sesión: ${fecha}.`)
  return partes.join("")
}

/** Metadatos del módulo reutilizable (modulo/), generado por scripts/modulo.ts desde estas mismas piezas. */
export const MODULO = {
  descripcion: "Agente que llena formularios de registro como proveedor desde el repositorio maestro y arma el paquete para firma, sin firmar ni enviar.",
  skill: "registro-proveedor",
  descripcionSkill: "Conocimiento del proceso de registro de Periferia como proveedor ante clientes: estados de campo, reglas por país, soportes y bloqueos de firma.",
  conocimiento: APP.conocimiento,
  herramientas: ["proveedor", "agente"],
}
