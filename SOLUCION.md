# SOLUCIÓN — Reto 01 · Agente «Registro como Proveedor»

## 1. Problema en una frase

Cada mes llegan 8–12 solicitudes de clientes para registrar a Periferia como proveedor y hoy alguien transcribe a mano, campo por campo, datos que ya existen en el repositorio maestro; le duele a la **analista administrativa** (retrabajo y riesgo de error en NIT y cuenta bancaria) y al negocio (registros lentos retrasan la facturación), y el conocimiento depende de una persona que ya no está.

## 2. Arquitectura

```
web/  (chat HTML + JS)  ── HTTP JSON ──▶  src/server.ts  (node:http: /api/chat, /api/sessions/:id, /api/health, /out/*)
  · historial                               └─ src/agent/loop.ts   ciclo · topes · compuerta de confirmación
  · cada llamada a herramienta                   ├─ system prompt = agent/prompt.md + src/knowledge/*.md
  · confirmación resaltada (⚠)                   ├─ src/llm/adapter.ts ──▶ anthropic.ts | openai.ts | simulado.ts
                                                 └─ src/core/run.ts (zod + log) ──▶ src/tools/proveedor.ts ──▶ src/lib/*
                                                                                         │                  │
                                                                              fixtures/ (solo lectura)   out/ (escritura)
sesiones: memoria + out/sessions/<id>.json · registro: out/log.jsonl
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, reglas inquebrantables, flujo estándar y formato de respuesta. |
| **Conocimiento** | `src/knowledge/*.md` y `src/knowledge/reglas-*.json` | El proceso de negocio en Markdown (se inyecta al system prompt) y los parámetros que leen las herramientas (umbrales, tablas por país, tolerancias). Cambiar una regla no toca el servidor. |
| **Ejecución** | `src/tools/proveedor.ts` (+ `src/lib/`) | Herramientas tipadas con `zod`, separadas del servidor e importables desde `demo.ts` y `modulo/`. |
| **Orquestación** | `src/agent/loop.ts` | Ciclo, topes, compuerta de confirmación, registro. No conoce el negocio. |
| **Proveedor** | `src/llm/` | Interfaz propia `LlmAdapter.enviar(mensajes, herramientas, opciones)` y una implementación por proveedor. |
| **Front** | `web/` | Chat sin dependencias: muestra cada herramienta (nombre, argumentos, resultado), resalta la confirmación pendiente y enlaza los archivos de `out/`. |

## 3. Ciclo del agente

Implementado en `src/agent/loop.ts` (`ejecutarTurno`):

1. Se agrega el mensaje del usuario al historial y se llama al modelo con el system prompt (prompt + conocimiento + fecha) y el esquema JSON de cada herramienta (generado desde `zod` con `z.toJSONSchema`).
2. Si el modelo pide herramientas, cada llamada pasa por `runTool` (`src/core/run.ts`): valida los argumentos con `zod` (si no cumplen, el error vuelve al modelo como `{ ok:false }`), ejecuta la herramienta dentro de `try/catch` y escribe `{ ts, sesion, herramienta, ok, resumen }` en `out/log.jsonl` (CA4). El resultado vuelve al modelo y se repite.
3. El turno termina cuando el modelo responde sin pedir herramientas.

**Topes (CA1 y costo).** `MAX_ITERACIONES` (25 por defecto) limita las vueltas modelo → herramientas por turno; si se alcanza, el agente responde con lo que tiene (últimas llamadas y su resultado) y lo que falta, sin otra llamada al modelo. `MAX_TOKENS_SESION` corta la sesión al superar el presupuesto, `MAX_TOKENS_RESPUESTA` limita cada respuesta y `LLM_TIMEOUT_MS` aborta una llamada colgada. `ACCESS_KEY` evita que un tercero gaste la clave desde el link público.

**Confirmación humana (CA3 / regla de "confirmación en el turno inmediatamente anterior").** No depende de que el modelo se porte bien; la hace cumplir el servidor:

- Para pedir confirmación, el agente llama `agente_solicitar_confirmacion({ accion, detalle })` y termina el turno con la pregunta. También queda pendiente, sin depender del modelo, cuando una herramienta lo declara en su resultado (`pendiente_confirmacion`: campos en revisión, OC con excepciones, paquete listo para enviar) o responde `requiere confirmación` / `requiere revisión`. La sesión guarda esa marca y el front pinta el mensaje en amarillo con botones **Confirmo / No confirmo**.
- En el turno siguiente, el servidor clasifica el mensaje del usuario (`esAfirmativo` / `esNegativo`). Solo si había una marca pendiente **y** el mensaje es afirmativo, ese turno queda habilitado para llamadas con `confirmado: true`; el modelo recibe una nota explícita indicando qué se confirmó.
- Cualquier llamada con `confirmado: true` en un turno no habilitado se bloquea **antes** de ejecutar la herramienta y vuelve al modelo como error. Una pregunta escrita sin la marca formal se resalta en el front, pero no habilita nada.

**Errores (CA5).** Un error de herramienta llega al modelo como `{ ok:false, error }` legible; un error del proveedor (clave inválida, 429, timeout) se traduce a un mensaje claro en el chat y la sesión sigue viva (se reintenta una vez ante 429/5xx).

En este reto la acción externa es `proveedor_simular_envio`: sin `confirmado: true` responde `requiere confirmación explícita`, y con `confirmado: true` en un turno no habilitado el servidor la bloquea antes de ejecutarla.

## 4. Elección del modelo

- **Proveedor y modelo usados en la prueba:** OpenAI, modelo `gpt-4.1-mini` (`LLM_PROVIDER=openai`, `LLM_MODEL=gpt-4.1-mini`). Lo elegí porque ya tenía créditos en la API de OpenAI, tiene buen soporte de llamadas a herramientas (incluidas varias en paralelo) y es barato por token. El código también trae un adaptador para Anthropic (Claude); cambiar de proveedor es cambiar dos variables de entorno, sin tocar el ciclo del agente. Para un modelo pequeño como este el diseño es clave: las reglas y los valores los calculan las herramientas, así que el modelo solo orquesta y explica.
- **Aviso:** la documentación de OpenAI marca `gpt-4.1-mini` como *deprecated* (al 2026-11-05). Funciona hoy, pero si OpenAI lo retira basta con cambiar `LLM_MODEL` por otro modelo de chat disponible en la cuenta.
- **Costo medido (no estimado).** Precio de `gpt-4.1-mini` según la página del modelo en OpenAI: USD 0,40 por millón de tokens de entrada y USD 1,60 por millón de salida. Tokens reales registrados por el servidor (`out/sessions/`) en mis pruebas del caso `ec-corp-andina`:

  | Sesión | Turnos | Tokens entrada | Tokens salida | Costo aprox. |
  |---|---|---|---|---|
  | Procesar el caso + 1 respuesta de confirmación (el envío no llegó a ejecutarse: aún faltaba la segunda corrección) | 2 | 33 838 | 874 | ≈ USD 0,015 |
  | Flujo completo hasta el envío simulado, con confirmaciones de más (primera prueba) | 5 | 76 402 | 1 851 | ≈ USD 0,034 |

  **Costo por caso procesado: entre ≈ USD 0,015 y ≈ USD 0,034**, según cuántas vueltas haga el agente. La mayor parte es entrada, porque cada vuelta reenvía el historial; por eso cada pregunta innecesaria encarece el caso. Con 8–12 solicitudes al mes, el costo del modelo quedaría por debajo de USD 0,50 mensuales (cálculo con las cifras anteriores; el precio puede cambiar).

## 5. Diseño del formato «portal web con usuario y contraseña» (no implementado)

**Hoy:** `proveedor_generar_formulario` responde «formato no soportado» y produce `out/<caso>/valores-portal.md`: tabla campo → valor → estado, lista para copiar, más la URL del portal tomada del correo.

**Estrategia propuesta (fase 2):** *copiloto en el navegador de la analista*, no un robot desatendido.

| Opción | Ventajas | Límites | Decisión |
|---|---|---|---|
| Navegador controlado por el agente (Playwright en servidor) | Automatiza todo el formulario | CAPTCHA, MFA, cambios de layout, las credenciales tendrían que vivir en el servidor | Descartada como modo principal |
| RPA tradicional | Maduro en empresas | Frágil ante cambios de HTML; mantenimiento por portal; costo de licencias | Descartada para 8–12 trámites/mes |
| **Extensión de navegador (copiloto)** | Corre en la sesión que la analista ya abrió; nunca ve la contraseña; respeta MFA y CAPTCHA | Requiere instalar la extensión; un mapeo campo → selector por portal | **Elegida** |

**Flujo:** 1) la analista inicia sesión en el portal (usuario, contraseña, MFA y CAPTCHA son humanos); 2) la extensión lee las etiquetas de la página y las envía al backend, que reutiliza `proveedor_mapear_campos`; 3) la extensión rellena solo los campos `lleno`, resalta en amarillo los `requiere_confirmacion` y en rojo los `faltante`; 4) los soportes se adjuntan desde el paquete con un clic de la analista; 5) **el clic en «Enviar» es humano**, y la extensión registra en `out/<caso>/log.jsonl` qué campos rellenó.

**Credenciales:** nunca en el repositorio, el prompt, los logs ni el backend. Las digita la persona en el portal o, si la empresa lo exige, salen de un gestor corporativo (p. ej. Bitwarden o 1Password Business) mediante el autocompletado del navegador; el agente no tiene forma de leerlas. El correo del cliente que trae credenciales llega al representante legal, no al agente.

**Límites asumidos:** si el portal cambia su HTML, la extensión cae al modo actual (valores para copiar); si hay CAPTCHA o MFA, los resuelve la persona.

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Las herramientas **recalculan** el mapeo desde el maestro y rechazan cualquier `valor` que el modelo devuelva distinto (CA2 en código, no solo en el prompt). | Confiar en el `mapeo` que pasa el modelo. | Un modelo puede "completar" un NIT o una cuenta. Con la verificación, un valor inventado nunca llega al formulario (`demo.ts` lo muestra). |
| 2 | **.xlsx escrito a mano sobre JSZip** (OOXML mínimo, celdas exactas). | `exceljs` o `xlsx` (SheetJS). | Solo hace falta escribir texto y números en celdas dadas; JSZip pesa poco y el resultado se verifica celda a celda en `demo.ts` y abre en Excel y openpyxl. Si se necesitara conservar estilos de la plantilla real del cliente, `exceljs` sería la opción. |
| 3 | **PDF generado** con `pdf-lib` (etiqueta y valor en el orden de la plantilla). | Rellenar un AcroForm. | El PRD lo permite y no recibimos el PDF original. En producción, si el cliente envía un AcroForm, se rellenan sus campos con la misma tabla de mapeo. |
| 4 | Confirmación como **compuerta del servidor** + herramienta `agente_solicitar_confirmacion`. | Detectar en el texto del modelo si "preguntó". | El texto es ambiguo; la marca formal deja auditable qué se confirmó y bloquea `confirmado: true` fuera de turno. |
| 5 | **Reglas de negocio en `src/knowledge/reglas-proveedor.json`** (identificador por país, umbrales, rutas bancarias). | Constantes en el código. | Cambiar una regla (p. ej. un país nuevo) no exige tocar el servidor ni las herramientas. |
| 6 | Sin framework web ni SDK del proveedor (`node:http` + `fetch`). | Express/Hono + SDK oficial. | Menos dependencias que justificar, el adaptador queda explícito y corre igual en Bun y Node. Costo: un poco más de código propio en el servidor. |

## 7. Supuestos

- **Fecha de referencia para vigencias:** la fecha actual (zona horaria de Colombia) salvo `FECHA_REFERENCIA` o el argumento `hoy`. La demo fija `2026-09-03` (fecha del PRD) para ser determinista; con la fecha real de noviembre de 2026 la Cámara de Comercio ya está vencida y ningún caso queda listo para firma, que es lo correcto.
- **Identificador tributario (RN1):** para EC, PE, PA y HN el campo se llena con el NIT colombiano y queda `requiere_confirmacion` («identificador extranjero»); no bloquea la firma (RN3 solo bloquea por soportes), pero aparece en el checklist.
- **Etiquetas con similitud entre 0.7 y 0.8** frente al glosario quedan `requiere_confirmacion`; por debajo de 0.7 son `faltante`. En los fixtures todas las etiquetas resolvieron por coincidencia exacta.
- **"País"** se llena con el código del maestro (`CO`), sin traducirlo a «Colombia», para no transformar datos que no vienen de una fuente.
- **Soportes:** el tipo exigido que no existe en el índice (p. ej. `certificado_cumplimiento_tributario`) es **ausente**; los placeholders `.txt` se copian tal cual al paquete.
- **Envío con paquete no listo:** `proveedor_simular_envio` lo permite tras confirmación explícita (el prompt de ejemplo lo pide sobre `ec-corp-andina`), pero `ENVIO-SIMULADO.md` y la respuesta registran las advertencias. En producción se recomendaría bloquearlo.
- `formato: portal` lee los campos de `plantilla-campos.json` cuando existe (caso `pa-logistica-istmo`).

## 8. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer la solicitud | Hecho | `proveedor_leer_solicitud`: país, cliente, formato, campos, soportes y `campos_ambiguos` con la propuesta por país. | Leer el correo real (Graph/IMAP) y los adjuntos binarios. |
| HU-2 Mapear al maestro | Hecho | Estados `lleno` (con ruta), `faltante`, `requiere_confirmacion`; sinónimos del glosario; `faltantes.md`. | Dueño del maestro y del glosario; ampliar sinónimos con el uso. |
| HU-3 Formulario | Hecho (P0 xlsx, P1 pdf, P2 portal como valores) | `formulario.xlsx` verificado celda a celda; `formulario.pdf`; `valores-portal.md` con «formato no soportado». | Escribir sobre la plantilla original del cliente (conservar estilos) y AcroForms. |
| HU-4 Paquete para firma | Hecho | `paquete/` con formulario, soportes, `checklist.md`, `borrador-correo.md` (sin datos bancarios); vencido o ausente bloquea; pregunta de confirmación; `ENVIO-SIMULADO.md`. | Firma electrónica y envío real con aprobación. |
| HU-5 Errores | Hecho | Caso inexistente, ruta maliciosa, valor inventado, plantilla corrupta (advertencia y continúa con soportes), proveedor LLM caído o timeout: mensajes claros. Ninguna herramienta lanza. | Alertas operativas (monitoreo) y reintentos con backoff. |
| Bonus módulo | Hecho | `modulo/` generado desde las mismas piezas; `demo.ts` y `bun run modulo:check` verifican que no diverja. | Publicarlo en el registro interno de la plataforma de agentes. |

## 9. Uso de IA

- **Asistente usado:** Claude (Anthropic), en una sesión agéntica, para leer los tres PRD y los fixtures, proponer la arquitectura, escribir el código TypeScript, el front, `demo.ts`, los scripts y esta documentación, y para probar todo (demos, `tsc --noEmit`, pruebas del chat de punta a punta con el proveedor simulado y capturas del front con Playwright).
- **Qué se descartó durante la construcción y por qué:**
  - *SDKs de los proveedores y un framework web (Express/Hono):* se prefirió `fetch` y `node:http` para que el adaptador fuera explícito, no hubiera dependencias que justificar y el mismo código corriera con Bun o con Node.
  - *Dejar que el modelo valide o calcule:* toda regla vive en herramientas deterministas; el modelo orquesta y explica. Por eso las herramientas recalculan desde los fixtures lo que el modelo les devuelve y rechazan valores alterados.
  - *Habilitar `confirmado: true` cuando el modelo "pregunta algo":* se descartó porque una pregunta cualquiera ("¿proceso otro caso?") seguida de "sí" habría autorizado acciones externas; solo la marca formal habilita.
  - *Exceljs para el Excel:* descartado por peso; JSZip + OOXML mínimo cubre el requisito (escribir en celdas exactas) y se verifica en la demo.
- **Lo que hice yo:** corrí las demos y los tres chats en mi computadora (Windows, Bun) con OpenAI `gpt-4.1-mini`, revisé los archivos generados (Excel, PDF, checklist, borrador de correo) y comparé los resultados con el PRD. Elegí OpenAI como proveedor porque ya tenía créditos.
- **Lo que detecté probando y se corrigió:** con `gpt-4.1-mini` el agente pedía confirmación por el RUC (que por la regla RN1 se llena solo con el NIT) e intentaba escribirlo a mano en `llenos`; la herramienta lo rechazaba, como debía, pero el flujo terminaba con varias confirmaciones. Le pedí a Claude corregirlo y la solución fue doble: el prompt prohíbe preguntar por esos campos y las respuestas de las herramientas indican qué hacer con cada campo (`accion`, `valor_escrito`). También vi que, si el modelo preguntaba en texto sin registrar la confirmación, el servidor bloqueaba mi "confirmo"; ahora la herramienta `proveedor_armar_paquete` deja registrada la confirmación del envío.

## 10. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| El modelo inventa o «corrige» un dato sensible (NIT, cuenta). | Las herramientas son la única fuente; `generar_formulario` rechaza valores que no coinciden con el maestro; el prompt lo prohíbe. |
| Envío o firma sin aprobación humana. | Compuerta de confirmación en el servidor; el envío real seguiría siendo una acción humana fuera del agente. |
| Maestro desactualizado (soportes vencidos, datos viejos). | Dueño del dato, alerta de vencimientos con anticipación y fecha de actualización por campo. |
| Plantillas reales más variadas (celdas combinadas, PDFs escaneados). | Mantener la tabla de mapeo por cliente; OCR para PDFs sin texto; revisión humana obligatoria antes de firmar. |
| Exposición de datos bancarios. | Solo si la plantilla los pide; nunca en el correo; `ACCESS_KEY` o SSO en el link; logs con resumen sin valores sensibles. |
| Costo del modelo por uso abusivo. | Topes de iteraciones y tokens por sesión, clave de acceso y límites de gasto en la consola del proveedor. |
| Datos del maestro enviados al proveedor del modelo. | Revisar con seguridad la política de retención del proveedor; solo viajan los datos del caso en curso. |

