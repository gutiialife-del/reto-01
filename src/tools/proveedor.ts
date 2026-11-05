// Herramientas del agente "Registro como Proveedor". Cada export se publica como proveedor_<export>.
// Son la única fuente de valores que el agente puede afirmar: el modelo nunca escribe datos propios.
import path from "node:path"
import { z } from "zod/v4"
import { ToolError, defineTool, guard, ok, fail } from "../core/tool"
import { ahora, copy, exists, fechaReferencia, readJson, readJsonOrNull, rel, writeJson, writeText } from "../core/util"
import {
  type Campo,
  type EstadoSoporte,
  type LecturaCaso,
  type Mapeo,
  type Reglas,
  type Soporte,
  type Valor,
  cargarMaestroYGlosario,
  cargarReglas,
  evaluarSoportes,
  mapear,
  mapeoDelCaso,
  rutas,
  validarCaso,
} from "../lib/dominio"
import { crearXlsx } from "../lib/xlsx"
import { crearPdf } from "../lib/pdf"

const casoArg = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, p. ej. 'ec-corp-andina'")

export const leer_solicitud = defineTool({
  description:
    "Lee el correo del cliente y su plantilla, y devuelve país, cliente, formato de salida, campos solicitados, soportes exigidos y campos ambiguos.",
  args: { caso: casoArg },
  async execute(args, ctx) {
    return guard(async () => {
      const { lectura, mapeo } = await mapeoDelCaso(ctx.directory, args.caso)
      const ambiguos = mapeo.requiere_confirmacion
        .filter((r) => r.motivo.startsWith("etiqueta ambigua") || r.motivo.startsWith("identificador extranjero"))
        .map((r) => ({ etiqueta: r.etiqueta, estado: "requiere_confirmacion", propuesta: r.motivo }))
      const s = lectura.solicitud
      return ok({
        caso: args.caso,
        cliente: s.cliente,
        pais: s.pais,
        formato: lectura.formato,
        correo: { de: s.de, asunto: s.asunto, fecha: s.fecha, adjuntos: s.adjuntos },
        campos: lectura.campos.map((c) => c.etiqueta),
        detalle_campos: lectura.campos,
        soportes: lectura.soportes,
        campos_ambiguos: ambiguos,
        advertencias: lectura.advertencias,
        resumen: `${s.cliente} (${s.pais}) · formato ${lectura.formato} · ${lectura.campos.length} campos · ${lectura.soportes.length} soportes${lectura.advertencias.length ? ` · ${lectura.advertencias.length} advertencia(s)` : ""}`,
      })
    })
  },
})

export const mapear_campos = defineTool({
  description:
    "Cruza los campos solicitados con el repositorio maestro y el glosario; cada campo queda lleno (con ruta), faltante o requiere_confirmacion. Nunca inventa valores.",
  args: {
    caso: casoArg,
    campos: z.array(z.string()).describe("Etiquetas de campo devueltas por proveedor_leer_solicitud (data.campos)"),
  },
  async execute(args, ctx) {
    return guard(async () => {
      const { lectura, mapeo: completo } = await mapeoDelCaso(ctx.directory, args.caso)
      const pedidos = new Set(args.campos)
      const desconocidos = args.campos.filter((e) => !lectura.campos.some((c) => c.etiqueta === e))
      const mapeo: Mapeo = {
        llenos: completo.llenos.filter((x) => pedidos.has(x.etiqueta)),
        faltantes: completo.faltantes.filter((x) => pedidos.has(x.etiqueta)),
        requiere_confirmacion: completo.requiere_confirmacion.filter((x) => pedidos.has(x.etiqueta)),
      }
      // Etiquetas que no están en la plantilla también se mapean (p. ej. si el usuario las pide en el chat).
      if (desconocidos.length) {
        const extra = await mapeoExtra(ctx.directory, lectura.solicitud.pais, desconocidos)
        mapeo.llenos.push(...extra.llenos)
        mapeo.faltantes.push(...extra.faltantes)
        mapeo.requiere_confirmacion.push(...extra.requiere_confirmacion)
      }
      const salida = rutas(ctx.directory).out(args.caso)
      await writeJson(path.join(salida, "mapeo.json"), { caso: args.caso, generado: ahora(), ...mapeo })
      await writeText(path.join(salida, "faltantes.md"), reporteFaltantes(args.caso, lectura, mapeo))
      return ok({
        caso: args.caso,
        ...mapeo,
        reporte_faltantes: rel(path.join(salida, "faltantes.md")),
        resumen: `${mapeo.llenos.length} llenos · ${mapeo.faltantes.length} faltantes · ${mapeo.requiere_confirmacion.length} requieren confirmación`,
      })
    })
  },
})

async function mapeoExtra(dir: string, pais: string, etiquetas: string[]): Promise<Mapeo> {
  const reglas = await cargarReglas(dir)
  const { maestro, glosario } = await cargarMaestroYGlosario(dir)
  return mapear(etiquetas.map((etiqueta) => ({ etiqueta })), pais, maestro, glosario, reglas)
}

const mapeoArg = z
  .object({
    llenos: z
      .array(z.object({ etiqueta: z.string(), ruta: z.string(), valor: z.union([z.string(), z.number(), z.boolean()]) }))
      .describe("data.llenos tal como lo devolvió proveedor_mapear_campos"),
    confirmados: z
      .array(z.string())
      .optional()
      .describe("Etiquetas de requiere_confirmacion que el usuario aceptó explícitamente en el chat"),
  })
  .describe("Resultado de proveedor_mapear_campos. Se verifica contra el maestro: un valor que no coincida se rechaza.")

export const generar_formulario = defineTool({
  description:
    "Genera el formulario lleno en el formato pedido por el cliente (xlsx celda a celda, pdf en el orden de la plantilla; portal → valores-portal.md) en out/<caso>/.",
  args: { caso: casoArg, mapeo: mapeoArg.optional() },
  async execute(args, ctx) {
    return guard(async () => {
      const { lectura, mapeo, reglas } = await mapeoDelCaso(ctx.directory, args.caso)
      if (args.mapeo) verificarContraMaestro(args.mapeo.llenos, mapeo)
      const confirmados = new Set(args.mapeo?.confirmados ?? [])
      const r = await escribirFormulario(ctx.directory, args.caso, lectura, mapeo, reglas, confirmados)
      return ok(r)
    })
  },
})

/** CA2 aplicado en código: el valor que propone el modelo debe ser idéntico al del maestro. */
function verificarContraMaestro(propuestos: Array<{ etiqueta: string; ruta: string; valor: Valor }>, verdad: Mapeo): void {
  for (const p of propuestos) {
    const real = verdad.llenos.find((l) => l.etiqueta === p.etiqueta)
    if (!real) {
      throw new ToolError(`"${p.etiqueta}" no está lleno según el maestro (es faltante o requiere confirmación); no puedo escribir un valor para ese campo`)
    }
    if (String(real.valor) !== String(p.valor) || real.ruta !== p.ruta) {
      throw new ToolError(`el valor propuesto para "${p.etiqueta}" no coincide con maestro.${real.ruta}; usa exactamente la salida de proveedor_mapear_campos`)
    }
  }
}

type FilaFormulario = { campo: Campo; valor: Valor | null; estado: "lleno" | "faltante" | "requiere_confirmacion" }

function filasFormulario(lectura: LecturaCaso, mapeo: Mapeo, confirmados: Set<string>): FilaFormulario[] {
  return lectura.campos.map((campo) => {
    const lleno = mapeo.llenos.find((l) => l.etiqueta === campo.etiqueta)
    if (lleno) return { campo, valor: lleno.valor, estado: "lleno" }
    const rc = mapeo.requiere_confirmacion.find((l) => l.etiqueta === campo.etiqueta)
    if (rc) {
      // RN1: el identificador extranjero se llena con el NIT y queda marcado. Otros, solo si el usuario confirmó.
      const escribir = rc.motivo.startsWith("identificador extranjero") || confirmados.has(campo.etiqueta)
      return { campo, valor: escribir ? rc.valor_propuesto : null, estado: confirmados.has(campo.etiqueta) ? "lleno" : "requiere_confirmacion" }
    }
    return { campo, valor: null, estado: "faltante" }
  })
}

async function escribirFormulario(
  dir: string,
  caso: string,
  lectura: LecturaCaso,
  mapeo: Mapeo,
  reglas: Reglas,
  confirmados: Set<string>,
): Promise<Record<string, unknown>> {
  const salida = rutas(dir).out(caso)
  const filas = filasFormulario(lectura, mapeo, confirmados)
  const conteo = { llenos: filas.filter((f) => f.estado === "lleno").length, faltantes: filas.filter((f) => f.estado === "faltante").length, por_confirmar: filas.filter((f) => f.estado === "requiere_confirmacion").length }
  if (!lectura.campos.length) {
    throw new ToolError(`no puedo generar el formulario: la plantilla no tiene campos legibles (${lectura.advertencias.join("; ") || "sin detalle"})`)
  }
  if (lectura.formato === "xlsx") {
    const celdas = filas.flatMap((f) => {
      const hoja = f.campo.hoja ?? "Hoja1"
      const out: Array<{ hoja: string; celda: string; valor: string | number; negrita?: boolean }> = []
      if (f.campo.celda_etiqueta) out.push({ hoja, celda: f.campo.celda_etiqueta, valor: f.campo.etiqueta, negrita: true })
      if (f.campo.celda_valor) out.push({ hoja, celda: f.campo.celda_valor, valor: f.valor === null ? "" : typeof f.valor === "number" ? f.valor : String(f.valor) })
      return out
    })
    const archivo = path.join(salida, "formulario.xlsx")
    await writeText(archivo, await crearXlsx(celdas))
    return { ruta: rel(archivo), formato: "xlsx", ...conteo, resumen: `formulario.xlsx generado: ${conteo.llenos} llenos, ${conteo.por_confirmar} por confirmar, ${conteo.faltantes} faltantes` }
  }
  if (lectura.formato === "pdf") {
    const s = lectura.solicitud
    const bytes = await crearPdf({
      titulo: `Formulario de registro de proveedor - ${s.cliente}`,
      subtitulos: [`Proveedor: Periferia IT Group S.A.S.`, `Solicitud: ${s.asunto} (${s.fecha})`, `Campos marcados con * son obligatorios para el cliente.`],
      lineas: filas.map((f) => ({
        etiqueta: f.campo.etiqueta + (f.campo.obligatorio ? " *" : ""),
        valor: f.valor === null ? (f.estado === "faltante" ? "[PENDIENTE: dato no disponible en el maestro]" : "[PENDIENTE DE CONFIRMACIÓN]") : String(f.valor),
        ...(f.estado === "requiere_confirmacion" && f.valor !== null ? { marca: "(requiere confirmación)" } : {}),
      })),
      pie: ["Documento preparado por el agente de registro de proveedores. Requiere revisión y firma del representante legal.", "Firma del representante legal: ______________________________"],
    })
    const archivo = path.join(salida, "formulario.pdf")
    await writeText(archivo, bytes)
    return { ruta: rel(archivo), formato: "pdf", ...conteo, resumen: `formulario.pdf generado: ${conteo.llenos} llenos, ${conteo.por_confirmar} por confirmar, ${conteo.faltantes} faltantes` }
  }
  const archivo = path.join(salida, "valores-portal.md")
  await writeText(archivo, valoresPortal(lectura, filas, reglas))
  return {
    ruta: rel(archivo),
    formato: "portal",
    soportado: false,
    aviso: "formato no soportado: el portal web no se diligencia automáticamente. Generé valores-portal.md con los valores listos para copiar; el ingreso de credenciales y el clic en Enviar son humanos.",
    ...conteo,
    resumen: "formato no soportado (portal): se generó valores-portal.md para copiar manualmente",
  }
}

function valoresPortal(lectura: LecturaCaso, filas: FilaFormulario[], reglas: Reglas): string {
  const s = lectura.solicitud
  const url = s.cuerpo.match(/https?:\/\/\S+?(?=[\s.,;)]*(\s|$))/)?.[0] ?? "(no indicada en el correo)"
  return [
    `# Valores para el portal — ${s.cliente}`,
    "",
    `> **Formato no soportado para llenado automático.** Copia estos valores en el portal. Las credenciales las ingresa una persona; nunca se guardan aquí.`,
    "",
    `- Portal: ${url}`,
    `- Solicitud: ${s.asunto} (${s.fecha})`,
    "",
    "| # | Campo | Valor | Estado |",
    "|---|---|---|---|",
    ...filas.map((f, i) => `| ${i + 1} | ${f.campo.etiqueta} | ${f.valor === null ? "—" : String(f.valor)} | ${f.estado}${f.campo.obligatorio ? " · obligatorio" : ""} |`),
    "",
    `Datos bancarios incluidos solo porque el formulario del cliente los pide explícitamente (RN2). Campos sensibles: ${reglas.rutas_sensibles.join(", ")}.`,
    "",
  ].join("\n")
}

function reporteFaltantes(caso: string, lectura: LecturaCaso, mapeo: Mapeo): string {
  return [
    `# Reporte de faltantes — ${caso}`,
    "",
    `Cliente: ${lectura.solicitud.cliente} (${lectura.solicitud.pais}) · formato ${lectura.formato}`,
    "",
    "## Campos faltantes (no existen en el maestro; no se inventan)",
    ...(mapeo.faltantes.length ? mapeo.faltantes.map((f) => `- **${f.etiqueta}**${f.obligatorio ? " (obligatorio)" : ""}: ${f.motivo}`) : ["- Ninguno"]),
    "",
    "## Campos que requieren confirmación",
    ...(mapeo.requiere_confirmacion.length
      ? mapeo.requiere_confirmacion.map((f) => `- **${f.etiqueta}**: propuesto \`${String(f.valor_propuesto)}\` (confianza ${f.confianza}) — ${f.motivo}`)
      : ["- Ninguno"]),
    ...(lectura.advertencias.length ? ["", "## Advertencias", ...lectura.advertencias.map((a) => `- ${a}`)] : []),
    "",
  ].join("\n")
}

export const armar_paquete = defineTool({
  description:
    "Arma out/<caso>/paquete/ con formulario, copias de soportes exigidos, checklist.md (presentes/ausentes/vencidos) y borrador-correo.md; indica si está listo_para_firma.",
  args: {
    caso: casoArg,
    hoy: z.string().optional().describe("Fecha de referencia YYYY-MM-DD para evaluar vencimientos; por defecto, la fecha actual"),
  },
  async execute(args, ctx) {
    return guard(async () => {
      const hoy = fechaReferencia(args.hoy)
      const { lectura, mapeo, reglas } = await mapeoDelCaso(ctx.directory, args.caso)
      const r = rutas(ctx.directory)
      const salida = r.out(args.caso)
      const paquete = path.join(salida, "paquete")
      const avisos: string[] = [...lectura.advertencias]

      let formulario: string | null = null
      try {
        const f = await escribirFormulario(ctx.directory, args.caso, lectura, mapeo, reglas, new Set())
        const origen = path.join(ctx.directory, String(f.ruta))
        const destino = path.join(paquete, path.basename(origen))
        await copy(origen, destino)
        formulario = rel(destino)
      } catch (e) {
        avisos.push(`formulario no incluido: ${(e as Error).message}`)
      }

      const indice = await readJson<Soporte[]>(path.join(r.soportes, "index.json"), "el índice de soportes")
      const estados = evaluarSoportes(lectura.soportes, indice, hoy, reglas)
      for (const e of estados) {
        if (e.archivo && e.estado !== "ausente") {
          const origen = path.join(r.soportes, e.archivo)
          if (await exists(origen)) await copy(origen, path.join(paquete, "soportes", e.archivo))
          else e.estado = "ausente"
        }
      }
      const bloqueos = estados.filter((e) => e.estado !== "presente").map((e) => `${e.nombre}: ${e.estado}${e.vigencia_hasta ? ` (vigencia ${e.vigencia_hasta})` : ""}`)
      const listo = bloqueos.length === 0 && formulario !== null
      if (formulario === null) bloqueos.push("formulario no generado")

      const checklist = path.join(paquete, "checklist.md")
      await writeText(checklist, textoChecklist(args.caso, lectura, mapeo, estados, hoy, listo, formulario, avisos))
      const borrador = path.join(paquete, "borrador-correo.md")
      await writeText(borrador, textoBorrador(lectura, estados, formulario))
      await writeJson(path.join(salida, "estado-paquete.json"), { caso: args.caso, hoy, listo_para_firma: listo, bloqueos, generado: ahora() })

      return ok({
        ruta: rel(paquete),
        listo_para_firma: listo,
        hoy,
        checklist: estados.map((e) => ({ soporte: e.tipo, estado: e.estado, vigencia_hasta: e.vigencia_hasta })),
        bloqueos,
        campos_faltantes: mapeo.faltantes.map((f) => f.etiqueta),
        campos_por_confirmar: mapeo.requiere_confirmacion.map((f) => ({ etiqueta: f.etiqueta, motivo: f.motivo })),
        archivos: { formulario, checklist: rel(checklist), borrador_correo: rel(borrador) },
        advertencias: avisos,
        resumen: `${listo ? "LISTO para firma" : "NO listo para firma"} · soportes: ${estados.filter((e) => e.estado === "presente").length}/${estados.length} presentes${bloqueos.length ? ` · bloqueos: ${bloqueos.join("; ")}` : ""}`,
      })
    })
  },
})

function textoChecklist(
  caso: string,
  lectura: LecturaCaso,
  mapeo: Mapeo,
  estados: EstadoSoporte[],
  hoy: string,
  listo: boolean,
  formulario: string | null,
  avisos: string[],
): string {
  const icono = { presente: "✅ presente", ausente: "❌ ausente", vencido: "⛔ vencido" }
  return [
    `# Checklist del paquete — ${caso}`,
    "",
    `- Cliente: ${lectura.solicitud.cliente} (${lectura.solicitud.pais})`,
    `- Fecha de referencia para vigencias: ${hoy}`,
    `- Formulario: ${formulario ?? "NO generado"}`,
    `- **Estado: ${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**`,
    "",
    "## Soportes exigidos",
    "| Soporte | Estado | Vigencia hasta |",
    "|---|---|---|",
    ...estados.map((e) => `| ${e.nombre} | ${icono[e.estado]} | ${e.vigencia_hasta ?? "no aplica"} |`),
    "",
    "## Campos faltantes (no bloquean, deben completarse a mano)",
    ...(mapeo.faltantes.length ? mapeo.faltantes.map((f) => `- [ ] ${f.etiqueta}${f.obligatorio ? " (obligatorio)" : ""}`) : ["- Ninguno"]),
    "",
    "## Campos por confirmar",
    ...(mapeo.requiere_confirmacion.length ? mapeo.requiere_confirmacion.map((f) => `- [ ] ${f.etiqueta}: ${f.motivo}`) : ["- Ninguno"]),
    ...(avisos.length ? ["", "## Advertencias", ...avisos.map((a) => `- ${a}`)] : []),
    "",
    "## Pasos humanos",
    "- [ ] Revisar el formulario y los campos por confirmar",
    "- [ ] Firma del representante legal",
    "- [ ] Aprobar el envío al cliente (el agente solo lo simula tras confirmación explícita)",
    "",
  ].join("\n")
}

function textoBorrador(lectura: LecturaCaso, estados: EstadoSoporte[], formulario: string | null): string {
  const s = lectura.solicitud
  const adjuntos = [
    ...(formulario ? [`Formulario diligenciado y firmado (${path.basename(formulario)})`] : []),
    ...estados.filter((e) => e.estado === "presente").map((e) => e.nombre),
  ]
  // RN2: el borrador nunca incluye datos bancarios.
  return [
    "> BORRADOR — no enviar hasta tener la firma del representante legal y la aprobación de la analista.",
    "",
    `**Para:** ${s.de}`,
    `**Asunto:** RE: ${s.asunto}`,
    "",
    "Buen día,",
    "",
    `En atención a su solicitud de registro de Periferia IT Group S.A.S. como proveedor de ${s.cliente}, adjuntamos:`,
    "",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Cordialmente,",
    "Área Administrativa — Periferia IT Group S.A.S.",
    "",
  ].join("\n")
}

export const simular_envio = defineTool({
  description:
    "Simula el envío del paquete al cliente escribiendo out/<caso>/ENVIO-SIMULADO.md; solo procede con confirmado=true tras confirmación explícita del usuario.",
  args: {
    caso: casoArg,
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje"),
  },
  async execute(args, ctx) {
    return guard(async () => {
      await validarCaso(ctx.directory, args.caso)
      if (!args.confirmado) return fail("requiere confirmación explícita")
      const salida = rutas(ctx.directory).out(args.caso)
      const estado = await readJsonOrNull<{ listo_para_firma: boolean; bloqueos: string[]; hoy: string }>(path.join(salida, "estado-paquete.json"))
      if (!estado) return fail("no hay paquete armado para este caso; ejecuta primero proveedor_armar_paquete")
      const archivo = path.join(salida, "ENVIO-SIMULADO.md")
      const contenido = [
        `# ENVÍO SIMULADO — ${args.caso}`,
        "",
        "> Simulación: no se envió ningún correo ni se cargó nada en sistemas externos.",
        "",
        `- Fecha y hora: ${ahora()}`,
        `- Confirmado por: usuario del chat (sesión ${ctx.sessionId})`,
        `- Paquete: ${rel(path.join(salida, "paquete"))}`,
        `- Estado al enviar: ${estado.listo_para_firma ? "listo para firma" : "NO listo para firma"}`,
        ...(estado.bloqueos.length ? ["- Advertencias al enviar:", ...estado.bloqueos.map((b) => `  - ${b}`)] : []),
        "",
        "Contenido del correo: ver `paquete/borrador-correo.md`.",
        "",
      ].join("\n")
      await writeText(archivo, contenido)
      return ok({
        ruta: rel(archivo),
        listo_para_firma: estado.listo_para_firma,
        advertencias: estado.bloqueos,
        resumen: `envío simulado registrado en ${rel(archivo)}${estado.listo_para_firma ? "" : " (con advertencias: paquete no listo)"}`,
      })
    })
  },
})
