# Reto 01 — Agente «Registro como Proveedor»

> Proceso de selección Perxia 2.0 · Periferia IT Group. Planteamiento completo en [`SOLUCION.md`](SOLUCION.md).

Agente conversacional que lee la solicitud de registro como proveedor de un cliente, llena el formulario (Excel celda a celda, PDF o valores para portal) desde el repositorio maestro, arma el paquete de soportes con checklist y borrador de correo, y **pide confirmación explícita** antes de simular el envío. Nunca firma ni envía.

## Link de prueba

**URL:** ⚠️ PENDIENTE — completar con la URL pública después de desplegar (ver «Despliegue»).
**Clave de acceso:** ⚠️ PENDIENTE — si defines `ACCESS_KEY` en el servidor, escríbela aquí; si no, borra esta línea.

## Levantar en local (un comando)

Requisitos: [Bun](https://bun.sh) 1.1 o superior.

```bash
bun install
cp .env.example .env      # completa LLM_API_KEY (y LLM_MODEL si usas openai)
bun run dev               # front + backend en http://localhost:3000
```

Bun carga `.env` automáticamente. Sin clave puedes revisar la interfaz con el proveedor **simulado** (un guion fijo, no un modelo de lenguaje):

```bash
LLM_PROVIDER=simulado bun run dev
```

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `LLM_PROVIDER` | sí | `anthropic` (por defecto), `openai` (cualquier API compatible con OpenAI Chat Completions) o `simulado`. |
| `LLM_API_KEY` | sí, salvo `simulado` | Clave del proveedor. Solo vive en el backend: no llega al front, a la API, a los logs ni al repositorio. |
| `LLM_MODEL` | con `openai` | Modelo a usar. Con `anthropic`, vacío = `claude-sonnet-5-5`. |
| `LLM_BASE_URL` | no | Endpoint de un proveedor compatible con OpenAI distinto de OpenAI. |
| `MAX_ITERACIONES` | no | Tope de ciclos modelo → herramientas por turno (25). |
| `MAX_TOKENS_SESION` | no | Tope de tokens por sesión (500 000). Al alcanzarlo, la sesión deja de llamar al modelo. |
| `MAX_TOKENS_RESPUESTA` | no | Máximo de tokens por respuesta del modelo (4096). |
| `LLM_TIMEOUT_MS` | no | Timeout por llamada al proveedor (60 000 ms). |
| `ACCESS_KEY` | no | Si se define, la API y las descargas exigen esta clave (el front la pide una vez). |
| `FECHA_REFERENCIA` | no | Fecha fija `YYYY-MM-DD`; vacío = fecha actual en Colombia. |
| `PORT` | no | Puerto HTTP (3000). |

## Demo sin modelo (`demo.ts`)

```bash
bun install && bun run demo.ts
```

Llama directamente a las herramientas (sin modelo ni clave), limpia `out/` al inicio e imprime el resumen por caso, los errores controlados y si `modulo/` está sincronizado. La demo usa `FECHA_REFERENCIA=2026-09-03` por defecto (fecha del PRD) para que el resultado no cambie según el día; el servidor usa la fecha actual de Colombia salvo que definas `FECHA_REFERENCIA`. **Ojo:** con la fecha real (noviembre de 2026) la Cámara de Comercio del repositorio ya está vencida y ningún caso queda listo para firma, que es el comportamiento correcto.

Salidas: `out/<caso>/formulario.xlsx|pdf` o `valores-portal.md`, `out/<caso>/faltantes.md`, `out/<caso>/paquete/` (formulario, soportes, `checklist.md`, `borrador-correo.md`), `out/<caso>/ENVIO-SIMULADO.md`, `out/<caso>/log.jsonl` y `out/log.jsonl`.

## Prueba sugerida en el chat

1. Sesión nueva: `Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.`
2. Cuando el agente pida confirmación (recuadro amarillo): `envía`

## Herramientas

| Herramienta | Entrada | Salida (`data`) |
|---|---|---|
| `proveedor_leer_solicitud` | `{ caso }` | País, cliente, formato, campos, soportes y campos ambiguos |
| `proveedor_mapear_campos` | `{ caso, campos[] }` | `llenos[]` (con ruta del maestro), `faltantes[]`, `requiere_confirmacion[]` + `faltantes.md` |
| `proveedor_generar_formulario` | `{ caso, mapeo? }` | `{ ruta, formato }`; portal → «formato no soportado» + `valores-portal.md` |
| `proveedor_armar_paquete` | `{ caso, hoy? }` | `{ ruta, listo_para_firma, checklist, bloqueos }` |
| `proveedor_simular_envio` | `{ caso, confirmado }` | `{ ruta }` o `{ ok:false, error:"requiere confirmación explícita" }` |
| `agente_solicitar_confirmacion` | `{ accion, detalle }` | Marca formal de «confirmación pendiente» (ver SOLUCION.md §3) |

Todas devuelven un string JSON `{ ok: true, data }` o `{ ok: false, error }` y nunca lanzan excepciones. Los argumentos se validan con `zod` antes de ejecutar.

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, confirmacion, tokens, error }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (turnos, llamadas a herramientas, tokens, confirmación pendiente) |
| `GET` | `/api/health` | `{ ok, app, provider, model, herramientas, ejemplos }`, sin claves |
| `GET` | `/out/<ruta>` | Descarga de archivos generados en `out/` (no expone `out/sessions/`) |

`sessionId`: 6–64 caracteres `[A-Za-z0-9_-]`. Con `ACCESS_KEY`, enviar el encabezado `x-access-key`.

```bash
curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo-sesion-1","message":"hola"}'
```

## Estructura

```
agent/prompt.md          comportamiento (system prompt)
src/knowledge/           conocimiento del proceso (.md) y reglas de negocio parametrizables (.json)
src/tools/proveedor.ts     ejecución: herramientas (cada export → proveedor_<export>)
src/tools/agente.ts      herramienta transversal agente_solicitar_confirmacion
src/lib/                 lógica de dominio usada por las herramientas
src/agent/               ciclo del agente y sesiones
src/llm/                 adaptador propio (adapter.ts) + anthropic.ts, openai.ts, simulado.ts
src/core/                contrato de herramientas, ejecución con log, utilidades
src/server.ts            API HTTP + archivos estáticos (node:http, sin framework)
web/                     front de chat (HTML + JS sin dependencias)
modulo/                  bonus: agente empaquetado (generado desde las mismas piezas)
fixtures/                entregados por Periferia (solo lectura)
demo.ts                  verificación sin modelo
```

Dependencias: `zod`, `jszip` (escribir .xlsx), `pdf-lib` (generar PDF). Sin framework web ni SDK de proveedores (ver SOLUCION.md, decisiones).

## Comprobaciones

```bash
bun run typecheck        # tsc --noEmit, modo estricto y sin any
bun run modulo:check     # verifica que modulo/ sea idéntico a la app
bun run modulo           # regenera modulo/ si cambiaste el prompt, el conocimiento o las herramientas
```

## Despliegue (Render, con Docker)

1. Sube este directorio a un repositorio de GitHub (sin `node_modules/`, `out/` ni `.env`; ya están en `.gitignore`).
2. En [Render](https://render.com): **New → Blueprint** y elige el repositorio (usa `render.yaml`), o **New → Web Service** con runtime Docker.
3. En *Environment*, define `LLM_API_KEY` (y `LLM_MODEL` / `ACCESS_KEY` si aplica).
4. Cuando el servicio esté *Live*, abre `https://<tu-servicio>.onrender.com/api/health` y copia la URL arriba, en «Link de prueba».

Notas: en el plan gratuito de Render el servicio se duerme tras un tiempo sin uso y el primer acceso tarda en despertar; abre el link unos minutos antes de la defensa. `out/` es efímero en ese entorno (se reinicia con cada despliegue). Cualquier otro proveedor que ejecute un `Dockerfile` (Railway, Fly.io, Azure Container Apps) sirve igual.

## Módulo reutilizable (bonus)

`modulo/agent.md` (frontmatter + system prompt), `modulo/tools/proveedor.ts` (re-export de las mismas herramientas, importables sin servidor) y `modulo/skill/*/SKILL.md` (conocimiento del proceso). Se generan con `bun run modulo` desde `agent/prompt.md`, `src/knowledge/` y `src/tools/`, y `demo.ts` / `bun run modulo:check` verifican que no diverjan.

