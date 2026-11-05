// Escritor mínimo de .xlsx (OOXML) sobre JSZip: hojas con celdas de texto o número en
// direcciones exactas (p. ej. "C4"). Suficiente para reproducir la plantilla del cliente celda a celda.
import JSZip from "jszip"

export type Celda = { hoja: string; celda: string; valor: string | number; negrita?: boolean }

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function partirCelda(ref: string): { col: string; fila: number } {
  const m = ref.toUpperCase().match(/^([A-Z]{1,3})(\d{1,7})$/)
  if (!m || !m[1] || !m[2]) throw new Error(`referencia de celda inválida: ${ref}`)
  return { col: m[1], fila: Number(m[2]) }
}

function colNum(col: string): number {
  return [...col].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0)
}

function hojaXml(celdas: Celda[]): string {
  const filas = new Map<number, Array<Celda & { col: string }>>()
  for (const c of celdas) {
    const { col, fila } = partirCelda(c.celda)
    const lista = filas.get(fila) ?? []
    lista.push({ ...c, col })
    filas.set(fila, lista)
  }
  const cuerpo = [...filas.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, cs]) => {
      const xml = cs
        .sort((a, b) => colNum(a.col) - colNum(b.col))
        .map((c) => {
          const r = `${c.col}${n}`
          const s = c.negrita ? ' s="1"' : ""
          if (typeof c.valor === "number" && Number.isFinite(c.valor)) return `<c r="${r}"${s}><v>${c.valor}</v></c>`
          return `<c r="${r}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(c.valor))}</t></is></c>`
        })
        .join("")
      return `<row r="${n}">${xml}</row>`
    })
    .join("")
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols><col min="1" max="4" width="42" customWidth="1"/></cols>` +
    `<sheetData>${cuerpo}</sheetData></worksheet>`
  )
}

export async function crearXlsx(celdas: Celda[]): Promise<Uint8Array> {
  const hojas = [...new Set(celdas.map((c) => c.hoja))]
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `</Types>`,
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      hojas.map((h, i) => `<sheet name="${esc(h.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      `</sheets></workbook>`,
  )
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  )
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`,
  )
  hojas.forEach((h, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, hojaXml(celdas.filter((c) => c.hoja === h))))
  // Fecha fija en las entradas del zip para que dos ejecuciones produzcan el mismo archivo.
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", date: new Date("2026-01-01T00:00:00Z") } as JSZip.JSZipGeneratorOptions<"uint8array">)
}

/** Lee de vuelta las celdas de un .xlsx generado por crearXlsx (para verificación en demo.ts). */
export async function leerXlsx(bytes: Uint8Array): Promise<Record<string, Record<string, string>>> {
  const zip = await JSZip.loadAsync(bytes)
  const wb = (await zip.file("xl/workbook.xml")?.async("string")) ?? ""
  const nombres = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"))
  const out: Record<string, Record<string, string>> = {}
  for (let i = 0; i < nombres.length; i++) {
    const xml = (await zip.file(`xl/worksheets/sheet${i + 1}.xml`)?.async("string")) ?? ""
    const celdas: Record<string, string> = {}
    for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>/g)) {
      celdas[m[1] ?? ""] = (m[2] ?? m[3] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    }
    out[nombres[i] ?? `hoja${i + 1}`] = celdas
  }
  return out
}
