# Acceso protegido de MidatoPay

Trabajo en `jm-app-security`, worktree `../app-security`, desde `jm-cache-treasury`.
Privy verifica identidad y sesión; el desbloqueo de MidatoPay autoriza sus APIs privadas.
La app autenticada permanece desmontada hasta completar PIN o passkey. Las confirmaciones
y firmas de transferencias siguen en sus flujos actuales.

## Configuración y migración

1. Instalar con `npm ci` en este worktree.
2. Generar `SECURITY_PIN_PEPPER` con al menos 32 bytes aleatorios, mantenerlo en el
   gestor de secretos del servidor, nunca en variables `VITE_`. Su pérdida obliga a
   recuperar PIN mediante otro factor; cambiarlo requiere una estrategia de migración.
3. Configurar `SECURITY_RP_ID` y `SECURITY_ORIGINS` explícitamente. Desarrollo:
   `localhost` y `http://localhost:5173,http://localhost:8888`. Producción: dominio
   propio y orígenes HTTPS exactos, sin rutas. Usar bases, secretos y RP distintos por
   entorno; las credenciales de localhost no sirven en producción. No derivar el origen
   permitido de un header del cliente.
4. Con las variables privadas de PostgreSQL configuradas, ejecutar
   `node --env-file=.env scripts/migrate-security.js` en el entorno de prueba.
   La migración es idempotente y no toca fondos ni factores existentes de Privy.
5. `SECURITY_ENFORCED` exige desbloqueo por defecto. `false` es una excepción operativa
   explícita para preparar el servidor antes del rollout; no usarla para la validación
   de seguridad. El frontend de esta rama siempre muestra el desbloqueo.
6. Ejecutar `npm test`, `npm run build` y `npm run functions:check`. Validar los
   recorridos manuales siguientes en un despliegue de prueba antes de activar para todos.

No se ha aplicado esta migración a un servicio remoto ni configurado secretos reales.

## Contratos

`/security/status` acepta GET; las demás rutas aceptan POST. Todas requieren un token
Privy verificado con DID y `sessionId`. Las respuestas son `no-store`.

| Ruta | Función |
| --- | --- |
| `pin/enroll` | Alta inicial, cambio con grant fresco, o alta tras recuperación |
| `pin/verify` | Verifica PIN; `purpose: manage` emite un permiso de gestión |
| `passkey/register-options`, `passkey/register` | Registro con UV requerida |
| `passkey/options`, `passkey/verify` | Autenticación con UV requerida |
| `methods/remove` | Elimina un método con grant de gestión; conserva el último |
| `renew`, `lock` | Renueva o revoca el desbloqueo de esta sesión |
| `recovery/start`, `recovery/verify` | Recuperación cerrada hasta integrar OTP de servidor |

Las APIs privadas requieren además `X-App-Unlock`. Se almacena solo el SHA-256 de
una credencial aleatoria de 256 bits, ligada al DID y sesión Privy. Vence a los
90 segundos; se renueva cada 30 segundos en primer plano, con límite absoluto de
12 horas. La verificación nueva de un factor es necesaria para gestionar métodos:
`X-Security-Grant` dura cinco minutos, se consume una vez y no permite acceder a
APIs privadas. Cambiar factores revoca sesiones y desafíos anteriores de ese DID.

PIN es texto de cinco dígitos, conserva ceros y rechaza repeticiones y secuencias.
El verificador v1 registra sal y parámetros `scrypt N=32768,r=8,p=1`, salida de
32 bytes; la entrada usa HMAC-SHA256 con pepper privado. Cinco errores bloquean el
PIN por quince minutos. Una fila de usuario se bloquea con `FOR UPDATE` para
serializar intentos y modificaciones. Hay límite compartido de 100 POST por IP
cada quince minutos en PostgreSQL usando la IP del edge Netlify. Probar esta
cabecera en el despliegue de prueba; fuera de Netlify todos comparten el bucket
`local` salvo que el proxy confiable suministre su dirección verificada.

WebAuthn valida desafío, origen, RP, firma, contador y UV en servidor. Credenciales
y desafíos están asociados al DID; los desafíos también a la sesión Privy, vencen
a los cinco minutos y se consumen incluso ante una respuesta incorrecta. Las APIs
de seguridad no aceptan un ID de usuario enviado por el navegador.

## Recuperación: publicación bloqueada

La versión instalada `@privy-io/server-auth@1.32.5` expone verificación de tokens y
consulta de usuarios, pero no un método de autenticación OTP de servidor. El
adaptador `netlify/functions/lib/securityRecovery.js` tiene `available:false` y
devuelve `recovery_unavailable`. La pantalla conserva los métodos registrados y
explica la indisponibilidad. No publicar recuperación automática hasta resolver
y validar esta integración con Privy.

El contrato futuro debe consultar email/teléfono ya verificado de ese DID, enviar
un código nuevo, enlazarlo al desafío y verificarlo en servidor. No puede recibir
un destino arbitrario ni aceptar callbacks del cliente o tokens renovados como
prueba. El permiso de recuperación solo permite registrar un factor nuevo. Al
completarlo se eliminan los factores previos y se revocan todos los desbloqueos.
Las pruebas usan un adaptador falso explícito; no habilitan OTP en producción.

## Ciclo de vida

`visibilitychange`, blur y pagehide cubren el contenido inmediatamente, descartan
la credencial en memoria y solicitan revocación. Al volver se pide verificación.
Si la red impide revocar, el permiso anterior vence como máximo en 90 segundos.
Las respuestas HTTP/RPC de una generación bloqueada se rechazan; las intenciones
de transferencia conservan el almacenamiento e idempotencia existentes.

Passkeys, permisos de cámara/micrófono y firma/exportación Privy tienen una
excepción limitada a la operación nativa, con máximo de dos minutos. La interfaz
privada sigue cubierta mientras falta foco. Navegadores no identifican de forma
fiable si una pérdida de foco proviene de otro tab o del diálogo nativo; probar
los recorridos reales por plataforma. Pagehide siempre bloquea. No ampliar esta
excepción a todo el flujo de pago.

Limpiar periódicamente sesiones revocadas/vencidas, desafíos vencidos y límites
vencidos de las tablas `app_security_*`, según la retención del entorno.

## Validación antes del rollout

Las pruebas automatizadas usan PostgreSQL embebido, PIN falsos y un autenticador
virtual con firmas reales; nunca mueven fondos. Cubren alta, identidad, lockout,
grants, revocación, límites, desafíos, firmas/origen/RP/UV y aislamiento de sesión.

Validar manualmente Android/Chrome, iPhone/Safari y escritorio: alta inicial y
usuario existente; PIN incorrecto/bloqueado; cancelación de passkey; gestión de
métodos; apertura, recarga, cambio de pestaña, cambio de app, retorno y bloqueo
sin red; diálogos de permisos y firmas sin bucles; restauración de una intención
pendiente sin duplicar envíos; cambio de usuario y expiración absoluta. Repetir
en PWA instalada al integrar `feat/installable-webapp`. La recuperación real queda
pendiente de su adaptador y la validación en un entorno de prueba es requisito
previo a activar la exigencia general.

Referencias: [SimpleWebAuthn servidor](https://simplewebauthn.dev/docs/packages/server),
[WebAuthn](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API),
[tokens Privy](https://docs.privy.io/authentication/user-authentication/access-tokens).

## Resultado de verificación local — 21/10/2026

- Suite completa: 180 pruebas, 178 pasan y 2 fallan en `test/charge-received.test.js`.
  Ambos fallos también se reproducen con ese archivo reconstruido desde `HEAD`;
  ni el test ni `src/ChargeSummary.jsx` se modificaron en esta rama. Sus expectativas
  sobre «Pago recibido» difieren del QR y estado «Procesando pago» de la base.
  La corrección pendiente del test se conserva exclusivamente en el checkout original.
- Después del ajuste final de aislamiento de diálogos nativos por sesión:
  29 pruebas enfocadas pasan, incluidas 17 de seguridad, arranque, cambio de usuario,
  transporte RPC real y cliente de tesorería.
- `npm run build`: pasa; conserva los avisos existentes de tamaño de chunks y
  configuración de optimización de dependencias.
- `npm run functions:check`: pasa; empaqueta 22 Functions y comprueba el rechazo
  de solicitudes no autenticadas, incluida la nueva Function `security`.
- `git diff --check`: pasa. El worktree de instalación permanece limpio y el
  checkout original conserva únicamente su modificación previa del test de cobros.

Los logs locales están en `.netlify/app-security-{tests,focused,build,functions,baseline}.log`
(ignorados por Git). No hay navegador conectado en esta sesión: no se validaron
interacciones reales con Privy, autenticadores físicos, Safari/Android ni PWA.
Quedan pendientes el adaptador OTP real, las pruebas en dispositivos y el despliegue
de prueba con migración y secretos, antes de publicar o activar en producción.

## Actualización: comprobaciones en Edge — 21/10/2026

Se conectó Edge y se ejecutó `node scripts/security-browser-fixture.js` en
`http://localhost:5187`. El fixture usa los componentes de producción, la Function
de seguridad y PostgreSQL efímero. La identidad Privy es falsa, no se carga `.env`
y no se conectan wallets, servicios de pago ni fondos. El adaptador WebAuthn del
fixture simula cancelación: esta prueba de interfaz no verifica hardware real.

| Recorrido | Resultado observado en Edge |
| --- | --- |
| Alta inicial y PIN con cero inicial | Pasa; API privada autorizada tras confirmar |
| Confirmación distinta, PIN secuencial | Pasa; no se habilita contenido privado |
| Teclado numérico, borrar y campo oculto | Pasa |
| Cinco errores de PIN | Pasa; PostgreSQL registra cinco intentos y bloqueo de quince minutos |
| Recuperación sin adaptador OTP | Pasa; se informa que está indisponible y permanece bloqueada |
| Recarga | Pasa; vuelve al desbloqueo; `keepalive` permite revocar la sesión en el servidor |
| Gestión de métodos y cambio de PIN | Pasa; pide verificación nueva, deshabilita eliminar el último método y rechaza el PIN anterior |
| Cambio de identidad | Pasa; el segundo usuario vuelve a configuración y la sesión anterior queda revocada |
| Red caída simulada y bloqueo local | Pasa; desaparece el contenido privado aunque falle la revocación |
| Revocación desde servidor | Pasa; la siguiente consulta privada vuelve a la pantalla de bloqueo |
| Cancelación de passkey simulada | Pasa; conserva la pantalla bloqueada |
| Tamaño móvil 390 × 844 y escritorio | Revisados los controles y estados |
| Cobro sin pagar / recibido / en revisión | QR y acciones coinciden con el componente actual |
| Cobro entregado | Animación de éxito y transición real al recibo tras tres segundos |

Se corrigieron tres problemas encontrados: el error de confirmación persistía al
iniciar un intento nuevo; la revocación podía cancelarse al descargar la página;
y, al cambiar de usuario, podía usar la nueva identidad para intentar revocar el
desbloqueo anterior. Ahora se limpia el error, se envía `keepalive` y se conserva
en memoria la identidad asociada al desbloqueo para revocarlo correctamente.

Los dos fallos anteriores de cobros eran expectativas de presentación antiguas.
Tras revisar los estados reales en Edge, se incorporó al worktree la corrección
pendiente de `test/charge-received.test.js` del checkout original, preservando ese
archivo original intacto. Se cubren también el QR sin pagar y la animación inicial
del cobro entregado. No se cambió `ChargeSummary.jsx` ni la lógica financiera.

Verificación actual: `npm test` **184/184**, build y `functions:check` correctos
(22 Functions empaquetadas). Los logs de esta
ejecución son `.netlify/app-security-edge-tests.log` y
`.netlify/app-security-edge-build.log`, además de
`.netlify/app-security-edge-functions.log`. Las capturas están en
`.netlify/edge-security-pin.png`, `.netlify/edge-charge-processing.png` y
`.netlify/edge-charge-delivered.png`. El fixture queda fuera del bundle de producto.
Se puede reconstruir solo su frontend con
`node scripts/security-browser-fixture.js --build-only`; recargar Edge después.
Reiniciar el servidor descarta su base de datos y las identidades de prueba.

La apertura de otra pestaña desde la extensión no produjo eventos reales de
`blur`/`visibilitychange` en la pestaña automatizada. Por eso no se declara validado
ese recorrido físico ni el cambio de aplicación; sus reglas siguen cubiertas por
las pruebas deterministas de ciclo de vida. Tampoco se validaron autenticadores
físicos, permisos/firma nativos reales, login real de Privy, Safari/iPhone, Android
o PWA instalada. Permanecen pendientes junto con OTP y el despliegue de prueba.
