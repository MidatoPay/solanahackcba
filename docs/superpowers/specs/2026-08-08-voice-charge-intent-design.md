# Intent de voz "cobrar" — diseño

## Contexto

`localParse`/`claudeParse` (`App.jsx`) sólo devuelven `intent: "send"` o
`"unknown"`. `Voice.analyze` descarta cualquier otro resultado. El diseño de
["Cobro P2P por QR"](2026-08-08-qr-charge-design.md) dejó explícitamente
fuera de alcance "voz para iniciar un cobro", registrándolo como hallazgo
pendiente. Este documento lo resuelve.

## Alcance

Agrega el comando de voz "cobrar 500 pesos" (y equivalentes en inglés,
"charge 500 pesos"): reconoce un nuevo intent `"charge"`, salta directamente
a la pantalla de "Cobrar" (`Charge`) con el monto en ARS precargado, y genera
el QR de cobro automáticamente — sin pantalla de confirmación intermedia,
porque generar un QR no mueve fondos (a diferencia de `"send"`, que sí
transfiere y por eso conserva su confirmación).

No incluye (fuera de alcance): monto mínimo especial para cobro por voz
(`Charge` ya no impone mínimo hoy); cambios al flujo `"send"` existente;
cancelar/editar el monto por voz una vez generado el QR (se usa el botón
"Cancelar" ya existente de `Charge`).

## 1. Parsing (`localParse` / `claudeParse`)

- Nuevo intent `"charge"`, evaluado antes que `"send"` en `localParse` para
  que "cobrar" no caiga en la regex de `send` (`pag` no matchea "cobrar", así
  que no hay colisión real, pero el orden de chequeo deja esto explícito).
- Regex de intención: `/(cobr)/` (es) y `/(charge|collect)/` (en).
- Monto: mismo extractor numérico que ya existe.
- Moneda: mismo detector `peso|ars` → `"ARS"`. Si no se aclara moneda, el
  default cambia según intent: `"send"` sigue defaulteando a `USDC` (sin
  cambios); `"charge"` defaultea a `"ARS"` — es la moneda nativa de la
  pantalla de Cobrar y lo más natural al decir "cobrar 500" sin aclarar.
- `recipient` no aplica a `"charge"`: siempre `null`, no se intenta extraer.
- `claudeParse`: el prompt/schema (en ambos idiomas) se actualiza para que
  `intent` acepte `"charge"` además de `"send"`/`"unknown"`, con la misma
  regla de default de moneda por intent, y `recipient: null` cuando
  `intent === "charge"`.

## 2. `Voice.analyze`

- El chequeo actual de "sin contactos" (`contacts.length === 0`) sólo bloquea
  cuando el intent resuelto es `"send"` — se mueve después de conocer el
  intent, en vez de aplicarse incondicionalmente antes del parseo.
- Rama nueva: si `result.intent === "charge"`:
  - Valida `amount > 0`; si no, mismo estado de error que hoy
    (`voice.noPaymentUnderstood`), con el mensaje actualizado para incluir
    también el ejemplo "cobrar 500 pesos" / "charge 500 pesos".
  - Si la moneda resuelta es `"USDC"`, convierte a ARS con `fxRate` (mismo
    cálculo que ya usa el flujo `send` a la inversa).
  - Llama al nuevo prop `onCharge(arsAmount)` y retorna. No pasa por
    `"confirm"`/`gas estimate`/`sendPayment` — eso es exclusivo de `"send"`.

## 3. `App.jsx` ↔ `Charge`

- Nuevo handler `handleVoiceCharge(ars)`: cierra el overlay de voz
  (`closeVoice()`), navega (`setTab("charge")`) y guarda
  `pendingCharge = { ars }` en un nuevo estado — mismo patrón que
  `pendingScan`/`scanRequest` que ya usa `Pay` para los links `?pay=`.
- `Voice` recibe el nuevo prop `onCharge={handleVoiceCharge}`.
- `Charge` recibe dos props nuevos: `chargeRequest` (el objeto
  `pendingCharge`) y `onChargeRequestConsumed`. Un `useEffect` sobre
  `chargeRequest`: precarga `arsInput` y dispara la generación del QR con ese
  monto, luego llama `onChargeRequestConsumed()` (que limpia
  `pendingCharge` en `App`, igual que `onScanRequestConsumed` limpia
  `pendingScan`).
- Refactor menor en `Charge`: `startWaiting` (hoy lee `ars` sólo del estado
  vía closure) pasa a `startWaitingFor(arsValue)`, y el botón de submit del
  formulario llama `startWaitingFor(ars)` con el valor derivado del input
  como hace hoy. Esto permite que el `useEffect` dispare el mismo camino de
  código con el monto que vino por voz, sin esperar al próximo render del
  estado.

## 4. i18n

- Actualiza `voice.noPaymentUnderstood` (en/es) para mencionar el nuevo
  comando de ejemplo junto al de enviar.
- No se agregan strings nuevos en el namespace `charge.*`: la pantalla de
  Cobrar se ve exactamente igual, sólo llega prellenada.

## Resumen de cambios por archivo

- `src/App.jsx`: `localParse`, `claudeParse`, `Voice` (prop `onCharge`,
  rama de intent `"charge"` en `analyze`, chequeo de contactos reubicado),
  `Charge` (props `chargeRequest`/`onChargeRequestConsumed`,
  `startWaitingFor`), `AppInner` (estado `pendingCharge`, handler
  `handleVoiceCharge`, wiring de los props nuevos).
- `src/i18n.jsx`: `voice.noPaymentUnderstood` en/es.
