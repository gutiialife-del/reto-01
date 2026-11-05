---
name: registro-proveedor
description: "Conocimiento del proceso de registro de Periferia como proveedor ante clientes: estados de campo, reglas por país, soportes y bloqueos de firma."
---

<!-- Generado desde src/knowledge/ por scripts/modulo.ts. No editar a mano. -->

# Proceso: registro de Periferia como proveedor ante clientes

## Contexto
- Llegan entre 8 y 12 solicitudes al mes por correo, de clientes en Colombia, Ecuador, Perú, Panamá y Honduras.
- La información de Periferia vive en el repositorio maestro (`fixtures/reto-01/repositorio/maestro.json`) y los soportes en `repositorio/soportes/` con su `vigencia_hasta`.
- El formato de salida varía: plantilla Excel (celda a celda), formulario PDF (lista ordenada de campos) o portal web.
- El cierre es humano: firma del representante legal y envío al cliente.

## Estados de un campo
| Estado | Cuándo |
|---|---|
| `lleno` | El campo se resolvió en el glosario (exacto o normalizado, confianza ≥ 0.8) y el maestro tiene el dato. Se reporta la ruta (`maestro.<ruta>`). |
| `faltante` | No hay equivalente en el glosario o el maestro no tiene el dato. **Nunca se inventa.** No bloquea la firma, pero va en el checklist. |
| `requiere_confirmacion` | Mapeo con confianza < 0.8, etiqueta ambigua (p. ej. "Identificación tributaria") o regla de país. |

## Reglas de negocio
- **RN1 · Identificador tributario por país:** CO → NIT, EC → RUC, PE → RUC, PA → RUC, HN → RTN. Periferia solo tiene NIT colombiano: en países distintos de CO el campo se llena con el NIT y queda `requiere_confirmacion` con la nota "identificador extranjero".
- **RN2 · Datos bancarios:** se llenan solo si la plantilla los pide explícitamente. Nunca en el borrador de correo.
- **RN3 · Bloqueos de firma:** un soporte exigido **vencido** (vigencia anterior a la fecha de referencia) o **ausente** bloquea `listo_para_firma`. Un campo faltante no bloquea.
- **RN4 · Acciones externas:** ningún envío, firma ni carga a portal sin confirmación explícita del usuario en el turno inmediatamente anterior. En este sistema "enviar" solo escribe `out/<caso>/ENVIO-SIMULADO.md`.
- **RN5 · Trazabilidad:** cada herramienta deja registro en `out/<caso>/log.jsonl` y `out/log.jsonl`.

## Formatos
- **xlsx:** cada etiqueta y su valor se escriben en la hoja y celda exactas de `plantilla-celdas.json`.
- **pdf:** se genera un PDF con todos los campos de `plantilla-campos.json`, en orden, con etiqueta y valor; los faltantes aparecen como "[PENDIENTE]".
- **portal:** no se automatiza. Se responde "formato no soportado" y se genera `valores-portal.md` para copiar. Las credenciales las digita una persona.

## Soportes (tipos del repositorio)
`camara_comercio`, `rut`, `certificacion_bancaria`, `parafiscales`, `estados_financieros`, `certificado_iso_9001`. Si el cliente exige un tipo que no existe en el repositorio (p. ej. `certificado_cumplimiento_tributario`) queda **ausente** y hay que conseguirlo.

## Qué decir cuando un soporte bloquea
- Vencido → "hay que solicitar una versión actualizada de <soporte> (venció el <fecha>)".
- Ausente → "el repositorio no tiene <soporte>; hay que gestionarlo antes de enviar".
