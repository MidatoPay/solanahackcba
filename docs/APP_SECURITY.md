# Acceso protegido y recuperación por email

Implementación en `fix/app-security-recovery-mobile`, sobre `main` 97a6c00. Reintroduce
1734064 conservando PWA, instalación móvil, redirecciones y dependencias posteriores.
No se publicó en producción ni se ejecutaron migraciones remotas.

## Modelo de autorización

Privy verifica DID y sesión. Las APIs privadas exigen también un desbloqueo de
MidatoPay y la existencia de un factor y contacto de recuperación confirmado.
PIN: cinco dígitos, ceros iniciales permitidos, sin repeticiones ni secuencias;
scrypt con sal única y pepper independiente. Cinco fallos bloquean el PIN quince
minutos. WebAuthn verifica origen HTTPS, RP, desafío, firma, contador y UV en servidor.
Las autorizaciones financieras y la selección de wallet principal siguen vigentes.

El desbloqueo opaco vive solo en memoria del navegador; PostgreSQL guarda su SHA-256.
Se liga al DID y sesión Privy, dura 90 segundos y se renueva cada 30 segundos en primer
plano, sin superar doce horas. El cliente descuenta el tiempo de ida/vuelta de la
vigencia recibida. `manage` y `recover` duran cinco minutos, son de un uso y no abren
APIs privadas. `recover` solo sirve para registrar un factor nuevo. El registro
consume el permiso y reemplaza los factores, revoca sesiones y elimina desafíos en
una transacción; un fallo inesperado conserva los factores y el permiso anterior.
Preparar opciones de registro no consume el permiso: se revalida al terminar.

## Recuperación y contacto obligatorio

El alta confirma primero el email y después crea un factor. Quien ingresó por SMS
puede vincular email mediante `useLinkEmail` de Privy y luego confirmar el contacto
con un segundo OTP propio de MidatoPay. Las cuentas históricas deben verificar su
factor antes de configurar un contacto. Sin factor ni contacto histórico no hay bypass.

El servidor consulta `getUser(DID)` y selecciona la cuenta de email de Privy con
`firstVerifiedAt`, nunca un destinatario del navegador ni el email de presentación
OAuth. El contacto confirmado queda fijado. Cambiar Privy no lo cambia; para hacerlo
se verifica un factor vigente y se confirma el email actual de Privy. La versión del
contacto cambia y se revocan permisos/sesiones/desafíos anteriores.

OTP aleatorio uniforme de seis dígitos, cinco minutos, hasta cinco errores. Se almacena
solo HMAC-SHA256 con un pepper independiente, ligado a ID del desafío, DID, sesión,
propósito y versión del contacto. La comparación usa `timingSafeEqual`. Reenviar invalida
el anterior; acertar o llegar al quinto error lo consume. Estados: `pending`, `sent`,
`failed`, `consumed`. El envío HTTP a Resend se hace tras liberar el bloqueo del usuario,
con timeout de ocho segundos e idempotency key por desafío. Solo un envío aceptado
habilita la verificación. Un error o timeout no concede permisos ni modifica factores.

Todas las rutas `/security/*` exigen Privy. `status` usa GET, las restantes POST.
Respuestas y fetch del cliente usan `no-store`.

| Ruta | Resultado |
| --- | --- |
| `status` | Factores, bloqueo, `enforced`, `recoveryReady`, email enmascarado, `recoveryAvailable` |
| `pin/enroll`, `pin/verify` | Alta/cambio/recuperación; verificación del factor |
| `passkey/register-options`, `passkey/register` | Preparación y registro de factor |
| `passkey/options`, `passkey/verify` | Preparación y autenticación |
| `methods/remove` | Requiere `manage`; conserva al menos un factor |
| `renew`, `lock` | Renovación válida o revocación idempotente |
| `recovery-email/start`, `recovery-email/verify` | Confirmar/actualizar contacto |
| `recovery/start`, `recovery/verify` | OTP al contacto fijado; permiso `recover` |
| `telemetry/dialog` | Contador de cancelación/interrupción, sin datos del diálogo |

## Límites y métricas

Los contadores usan upserts atómicos en PostgreSQL, compartidos entre instancias.
Solo se confía en `x-nf-client-connection-ip` de Netlify; `X-Forwarded-For` no influye.
Un proxy local debe suministrar una IP confiable o todos comparten el bucket `local`.
Los rechazos devuelven 429 y `Retry-After`; la interfaz muestra segundos restantes.

| Presupuesto | Límite |
| --- | --- |
| Autenticación/gestión | 60 por DID y 1.000 por IP cada 15 minutos |
| Renovación | 10/minuto por credencial válida; se comprueba identidad y vigencia primero |
| Revocación | Sin consumo de los presupuestos anteriores |
| Envío OTP | 1/minuto, 5/hora por DID; 100/hora por IP |
| Verificación OTP | 5 errores por desafío; 10 solicitudes por DID cada 15 minutos |

Los eventos `security_metric` usan únicamente nombres enumerados: `renew_rejected`,
`recovery_sent`, `recovery_delivery_failed`, `recovery_verified`, `recovery_rejected`,
`dialog_cancelled`, `dialog_interrupted`. Agregar por nombre/ventana en los logs del
servidor, sin dimensiones de DID, email, IP, token ni código. La telemetría del
navegador es indicativa y también limitada; no se usa para autorizar operaciones.

## Ciclo de vida e iOS 16+

La operación nativa recorre `open → waiting_focus → finished/cancelled`. Al resolver
visible sin foco, mantiene la cobertura y espera hasta dos segundos. Foco anterior
o posterior a la resolución produce el mismo resultado. Página oculta al terminar,
`pagehide`, cambio de identidad/sesión, expiración o timeout cancelan resultados tardíos.
La excepción nativa dura como máximo dos minutos y no alarga el desbloqueo. No se
repiten firmas ni envíos automáticamente. El mismo wrapper cubre passkeys, permisos
usados por la app y diálogos de Privy.

Si el panel ya está bloqueado, cambiar de ventana para leer el email conserva en
memoria el permiso temporal y el desafío de configuración/recuperación. No concede
acceso privado ni extiende sus vencimientos; el servidor vuelve a validar sesión,
propósito y permiso. `pagehide`, bloqueo explícito o cambio de identidad/sesión
siguen invalidando la operación. Las opciones WebAuthn se invalidan también al perder foco.

El panel prepara token y opciones WebAuthn antes del toque. El manejador llama al
autenticador antes de cualquier await o petición. Opciones solo en memoria, ligadas a
token de sesión y generación, se invalidan por uso, cancelación, bloqueo, cambio de
identidad o vencimiento. Se muestran preparación, cancelación, vencimiento e
incompatibilidad; PIN y recuperación siguen disponibles. No hay bypass por user-agent.
El service worker sigue almacenando únicamente `/offline.html`; sus pruebas excluyen
explícitamente `/security/*` y `/.netlify/functions/security/*`.

## Configuración, staging y piloto

En desarrollo, `npm run dev:full` inicia Vite en `http://localhost:8888` y Netlify
Functions en `9999`, con los proxies de API dirigidos a Functions. Se evita pasar los
módulos de Vite por la redirección SPA de Netlify Dev. El watcher excluye `.netlify`
para no observar ni bloquear los archivos generados de Functions en Windows.

1. Node 22 o posterior (build y Functions declarados en `netlify.toml`). Ejecutar `npm ci`.
2. Configurar por entorno, solo servidor: `SECURITY_PIN_PEPPER`,
   `SECURITY_RECOVERY_PEPPER` independientes y aleatorios (mínimo 32 bytes),
   `RESEND_API_KEY`, `SECURITY_RECOVERY_FROM` con dominio verificado en Resend.
   No usar `VITE_`. Mantener los valores en el gestor de secretos, fuera de Git/logs.
3. Configurar `SECURITY_RP_ID` sin esquema y `SECURITY_ORIGINS` con orígenes HTTPS
   exactos, sin rutas. Registrar staging también en los dominios de Privy.
   Usar bases, peppers, remitentes y RP separados. Solo localhost permite HTTP.
4. Con credenciales de staging, ejecutar `node --env-file=.env scripts/migrate-security.js`.
   Aplica 20261021 y 20261022 en orden. Las pruebas ejecutan la migración nueva dos
   veces sobre factores/contactos existentes y verifican igualdad de datos.
5. Verificar la configuración real de la IP del edge, Resend, Privy y runtime antes
   de habilitar al piloto. Disponibilidad en `status` solo prueba presencia de configuración;
   no demuestra que Resend haya verificado el dominio ni que entregue mensajes.
6. Para piloto: `SECURITY_ENFORCED=false` y `SECURITY_PILOT_USER_IDS` con DID exactos
   separados por coma. El servidor y el gate exigen seguridad a esos DID. Fuera del
   piloto se conserva el acceso Privy anterior. Ausencia de `SECURITY_ENFORCED` o `true`
   exige seguridad a todos. No ampliar mientras falte recuperación real o dispositivos.
7. Registrar el artefacto previo compatible para rollback manual del código. Conservar
   tablas, factores, contactos y configuración. No ejecutar migraciones destructivas,
   no desactivar globalmente seguridad como rollback automático.

## Verificación reproducible

- `npm test`: pruebas de SQL real con PGlite, firmas WebAuthn reales, reloj determinista
  y componentes React con efectos. Los proveedores de correo y Privy están simulados.
- `npm run build`, `npm run functions:check`, `npm run deps:check`.
- `npm run test:security:browser`: Chrome instalado, perfil temporal y viewport 390×844;
  inicia fixture local, prueba alta, diez desbloqueos, cancelación/reintento, `pagehide`
  e identidad. `SECURITY_TEST_BROWSER=msedge` permite usar Edge. No descarga navegadores.
- `npm run test:security:baseline`: copia aislada de 1734064 bajo `.netlify/`, conserva
  las pruebas y comprueba fallos por aserción para límites, foco, Safari y recuperación.
- `node scripts/security-browser-fixture.js`: revisión manual local en puerto 5187.
  Es un servidor de pruebas que no carga `.env`; muestra OTP de fixtures en su buzón
  local. Nunca publicar este servidor ni usarlo con cuentas reales.

Evidencia y matriz de aceptación: [APP_SECURITY_VALIDATION.md](APP_SECURITY_VALIDATION.md).

Referencias: [Resend HTTP](https://resend.com/docs/api-reference/emails/send-email),
[restricciones Safari](https://simplewebauthn.dev/docs/advanced/browser-quirks),
[Playwright con Chrome instalado](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-channel).
