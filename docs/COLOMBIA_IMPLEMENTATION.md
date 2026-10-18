# Colombia: implementación y verificación

## Alcance y decisiones

Rama `colombia`, basada en `main`. Configuración por despliegue, servicios por capacidad y adaptadores por proveedor. Colombia usa OnePay sandbox, USDC Solana Devnet, un registro contable aislado y una cuenta OnePay común. Argentina conserva su frontend y backend anteriores cuando `APP_COUNTRY=AR`.

La división la coordina MidatoPay: porcentaje o monto fijo por comercio, default 100%, copia inmutable al crear el cobro. Se cobra 0,5% únicamente sobre la parte convertida, también al vender USDC. COP restante disponible para retiro. Costos del proveedor absorbidos por la plataforma en sandbox. Las conversiones menores de 0,01 USDC se conservan en COP sin comisión. Límites iniciales por cobro y retiro: 1.000–1.000.000 COP. Personas naturales como beneficiarios iniciales.

No se activan tarjetas ni pagos QR/bancarios generales por habilitar un proveedor que tenga otras capacidades. Los documentos son borradores identificados de sandbox; no habilitan producción. Los procesos autorizados siguen reconciliándose al pausar servicios o cambiar documentos.

## Contratos oficiales comprobados

- [QR Bre-B](https://docs.onepay.la/client/charges/bre-b): `POST /v1/charges/bre-b`, importe en COP, `external_id`, `expires_in`, header `x-idempotency`.
- [Creación de destino Bre-B](https://docs.onepay.la/client/accounts/create-breb.md): la versión Markdown completa documenta `subtype=KEY`, `account_number` como llave, `customer_id` y `external_id`. El ejemplo bancario del HTML estaba incompleto.
- [Dispersión](https://docs.onepay.la/client/cashouts/create.md): `method=BREB` (respuesta `BRE-B`), sin fallback a otra red; hasta 10.000.000 COP por dispersión; puede reintentar pendientes hasta tres horas. La aplicación conserva su límite menor de 1.000.000 COP.
- [Balance](https://docs.onepay.la/client/movimientos/balance.md): `{id,balance,balance_label}`, `balance` en COP mayores. No es el saldo individual del comercio.
- [Webhook](https://docs.onepay.la/guides/implementar-webhooks): token `x-webhook-token` y HMAC-SHA256 `Signature` sobre bytes crudos.
- [CriptoYa Colombia](https://docs.criptoya.com/colombia/): cotizaciones públicas cada minuto; `GET /api/usdc/cop/1` se consultó efectivamente y devuelve varios exchanges. Medianas de `totalAsk` y `totalBid`, datos hasta cinco minutos, caché 60 segundos, sin fallback de ARS ni tasa inventada.

## Preparación local

1. `npm run colombia:env` crea `.env.colombia` privado, conserva el existente si ya está creado, reutiliza únicamente la autenticación Privy y crea una tesorería de prueba independiente y un secreto de worker. No imprime valores privados.
2. Configurar OnePay `sk_test_`, secreto/token del webhook y PostgreSQL exclusivo con certificado TLS. La base no puede coincidir con la base argentina. Configurar un identificador de despliegue y cuenta estable.
3. `npm run colombia:migrate` aplica únicamente `20261018_country_platform.sql` en esa base aislada. No ejecutar migraciones financieras antiguas para esta plataforma.
4. Fondear la nueva tesorería exclusivamente con SOL Devnet y USDC Devnet y disponer de saldo COP simulado en OnePay.
5. Registrar el webhook HTTPS `/webhooks/onepay` en el ambiente de pruebas; escuchar cargos y dispersiones. Para una computadora local, seguir la [guía de ngrok y webhook por desarrollador](ONEPAY_WEBHOOK_LOCAL.md). El secreto no se imprime ni se incluye en el navegador.
6. `npm run colombia:check` es de solo lectura. Verifica configuración, balance OnePay, esquema, cotización y liquidez. No crea operaciones ni firma transacciones.
7. Habilitar `PLATFORM_ENABLED=true` y ejecutar `npm run dev:colombia`. Los servicios nuevos se mantienen deshabilitados en el ejemplo hasta completar la configuración.

Para compilar este entorno: `npm run build:colombia`. Tanto este comando como `dev:colombia` cargan `.env.colombia`; Vite no mezcla el `.env` del despliegue anterior. El control de variables privadas con prefijo `VITE_` sigue activo.

Con el servidor listo, `npm run dev:check:colombia` verifica HTML, MIME JavaScript, configuración CO/Devnet, autenticación y bloqueo de las rutas argentinas. En frío, Netlify tarda en cargar las 25 Functions; esperar a que termine esa carga antes del check. Netlify Dev no carga archivos dotenv adicionales: el comando anterior `dev:full` ahora carga `.env` explícitamente; para Argentina ese archivo debe declarar `APP_COUNTRY=AR`.

Despliegue: sitio Netlify de sandbox separado, mismas variables de `.env.colombia.example` en el contexto apropiado y Devnet consistente al compilar y ejecutar Functions. Nunca copiar `.env.production`. No se ha solicitado publicar ni modificar producción.

## APIs y persistencia

`GET /app-config` entrega país, servicios, documentos y `contextId` sin secretos. `/platform/*` requiere Bearer Privy. Las escrituras requieren `X-Platform-Context` vigente y las creaciones financieras `Idempotency-Key` UUID v4.

- `/me`, `/settings`, `/acceptances`, `/rates`, `/quotes`.
- `/charges`, `/conversions/buy`, `/conversions/sell`, `/withdrawals`, `/transfers`.
- `/operations`, `/operations/:id`, `/operations/:id/submit`, `/operations/:id/cancel`.
- `/customer`, `/destinations`, `/banks`, `/breb-key`.
- `/contacts` y `/contacts/remove`: agenda privada por propietario y contexto. `/me` devuelve sus contactos. Actualizar requiere el ID del contacto; un alias repetido devuelve conflicto y no sobrescribe otro contacto.
- `/reconcile`: sincronización autenticada de ingresos USDC finalizados. También hay una tarea programada cada 15 minutos con paginación y checkpoint persistente.
- `/attempts/close` permite abandonar un intento bajo el mismo bloqueo de creación: una petición tardía no puede crear dinero después de ese cierre.
- `/reports`: administración por IDs Privy configurados, CSV desde el cliente.

Operaciones y pasos hijos guardan país, moneda, ambiente, red, proveedor, referencia, regla y cotización. Libro de doble entrada: lotes balanceados atómicos y protegidos contra UPDATE/DELETE en PostgreSQL. Saldo individual calculado desde movimientos; reservas serializadas por contexto. Los retiros y ventas comprueban liquidez externa además del saldo del comercio. Los wires Solana se guardan completos antes de transmitir; una firma ambigua conserva reservas.

## Agenda y capacidades por país

Un contacto admite wallet Solana, cuentas bancarias o ambas. Los datos bancarios son opcionales: banco, titular, tipo y número de cuenta; país y moneda pertenecen al despliegue. Se permiten hasta cinco cuentas por contacto, preservando ceros iniciales y rechazando cuentas repetidas. La lista muestra números enmascarados; la edición permite revisar el número completo al propietario.

`features.bankContacts` se calcula en el servidor a partir del esquema bancario del país y sus capacidades bancarias habilitadas. El backend verifica la misma condición. Si la capacidad se deshabilita, los datos guardados se conservan y no se borran al editar una wallet. Los contactos exclusivamente bancarios no aparecen en envíos ni comandos de voz USDC. Guardar una cuenta no crea beneficiarios ni destinos de retiro en OnePay.

El catálogo `src/platform/countries.js` define país, moneda, idioma, zona horaria, esquema de cuentas y servicios disponibles. La interfaz consulta esas capacidades y usa sus textos monetarios y documentos. Para incorporar un país se agregan su configuración y documentos legales; los proveedores nuevos se registran en `netlify/functions/lib/platform/providers.js`, implementan los contratos normalizados y sus verificaciones. Una integración nueva necesita sus pruebas de contrato y habilitación explícita: agregar un país no habilita automáticamente todos sus servicios.

Las identidades de beneficiarios se guardan por contexto, usuario y proveedor en `platform_provider_customers`, cada una con su propia clave de idempotencia y cuerpo de solicitud. La primera integración es OnePay Colombia para personas naturales; un adaptador nuevo implementa su registro y validación sin compartir IDs con otro proveedor. La migración conserva las identidades y claves preparadas por la versión inicial de Colombia.

Cada destino fija su proveedor. Si cambia la integración del servicio, ese destino deja de estar disponible para retiros nuevos y la pantalla permite registrar uno con el servicio actual. Los retiros ya aceptados conservan proveedor, cliente, cuenta e importe y se siguen conciliando con su adaptador original. La liquidez se comprueba en el proveedor elegido para el retiro. Los eventos de webhook también fijan proveedor: IDs externos coincidentes no seleccionan operaciones de otra integración. Una entidad jurídica, tarjetas o pagos bancarios a terceros requieren su integración específica.

Las rampas tienen su registro independiente, `RAMP_FACTORIES` en `netlify/functions/lib/platform/ramps.js`. Compra y venta seleccionan `onRamp.provider` y `offRamp.provider` por separado; `offRamp.fiatProvider` identifica la contraparte del saldo COP. La conversión automática copia la rampa al crear el cobro y transmite esa selección al paso hijo. Cambiar la configuración no cambia una operación ya preparada.

El contrato implementado es `prefunded_solana`: `liquidity` informa dueño, USDC y SOL; `sellDestination` fija el receptor de la venta; `prepareBuy` devuelve wire completo, firma y vencimiento sin transmitir. El worker persiste esos bytes antes de enviarlos y verifica la prueba finalizada. Las reservas se agregan por dirección de tesorería: adaptadores con wallets distintas se independizan y adaptadores que comparten wallet comparten también sus reservas. Una rampa inexistente o con otro protocolo se rechaza antes de reservar fondos; no se reemplaza por la tesorería. Un proveedor con liquidación exclusivamente por API necesita implementar y verificar su protocolo de conciliación antes de habilitarlo.

## Validación pendiente de servicios externos

El procedimiento de ejecución y los criterios de aprobación están en [COLOMBIA_SANDBOX_UAT.md](COLOMBIA_SANDBOX_UAT.md).

El checkout no tenía credenciales OnePay ni una base de datos Colombia. La validación autenticada del sandbox requiere esos accesos, saldo simulado y fondeo Devnet; no se sustituye por respuestas falsas en producción. Las pruebas automáticas usan PostgreSQL PGlite, fixtures bancarios y RPC simulado sin firmar con claves existentes.

El preflight de solo lectura comprobó país/Devnet y cotización pública CriptoYa. Reportó pendientes: clave `sk_test_`, webhook, PostgreSQL aislado y verificación de liquidez Devnet. La migración está preparada y probada localmente; no se aplicó a una base remota.

La herramienta de navegador no pudo inicializarse y la revisión automática bloqueó el inicio alternativo de Chrome sin proporcionar un motivo adicional. La revisión visual, el login real y la firma con Privy en navegador quedan pendientes. Los renders automáticos verifican arranque nulo/restauración, comprobantes, agenda y visibilidad por capacidades; no sustituyen esa prueba interactiva.

## Decisiones para revisar al retomar

- Agenda: wallet, banco o ambos; hasta cinco cuentas por contacto; solo datos del país activo; cuentas de terceros en agenda separadas de los destinos propios de retiro.
- Beneficiarios iniciales: personas naturales colombianas; llaves Bre-B activas y del mismo titular. No habilitar pagos a terceros a partir de la agenda.
- Límites de sandbox: cobros/retiros de 1.000 a 1.000.000 COP, conversiones desde 0,01 USDC. Una venta pequeña puede acumular COP sin alcanzar todavía el mínimo de retiro.
- Conservación de fondos: respuestas ambiguas mantienen reservas y reintentan la identidad original; las reversiones posteriores al pago requieren conciliación.
- Un despliegue por país y ambiente, con base Colombia aislada. Los borradores legales se identifican y versionan como sandbox.

## Estado de trabajo

Desarrollo local implementado en `colombia`, con conexión autenticada al sandbox externo pendiente. Incluye backend, libro contable, adaptadores OnePay/CriptoYa, webhooks, reservas, reintentos, sincronización de ingresos, pantallas, actividad, comprobantes y agenda bancaria opcional. Los retiros muestran el destino enmascarado y comisión de retiro cero; la tarifa de conversión se muestra únicamente en operaciones que convierten.

Verificaciones del 18 de octubre de 2026:

| Comprobación | Resultado |
| --- | --- |
| Suite completa con `VITE_SOLANA_CLUSTER=devnet` | 188 aprobados |
| Suite completa con `VITE_SOLANA_CLUSTER=mainnet-beta` | 188 aprobados; Colombia sigue forzada a Devnet |
| Casos de plataforma, libro y UI, incluidas rampas y separación de proveedores | 41 aprobados, incluidos en los casos de plataforma de la suite |
| `npm run build:colombia` | Aprobado; advertencias de tamaño de chunks de dependencias |
| `npm run functions:check` | 25 Functions empaquetadas; rutas protegidas rechazan solicitudes anónimas |
| `npm run dev:check:colombia` | 8 verificaciones HTTP/MIME aprobadas |
| Valores privados configurados en el bundle del frontend | Ninguno de los tres valores privados presentes fue encontrado |
| `git diff --check` | Aprobado; `.env.colombia` permanece ignorado y sin seguimiento |

El arranque se comprobó mediante HTTP y los renders automáticos; no se comprobó una sesión Privy autenticada en navegador. La prueba real OnePay → webhook → conversión/entrega → retiro permanece pendiente de credenciales, PostgreSQL y liquidez de prueba. No se publicaron los cambios ni se aplicaron migraciones remotas.

Requisitos externos aún ausentes al cerrar la implementación: `ONEPAY_API_KEY`, `ONEPAY_WEBHOOK_SECRET`, `ONEPAY_WEBHOOK_TOKEN`, `PLATFORM_DATABASE_URL` y `PLATFORM_DATABASE_CA_CERT`. La plantilla pública de ngrok y la guía por desarrollador están preparadas; la copia privada todavía tiene el marcador de authtoken y no se inició un túnel ni se registró el webhook. `PLATFORM_ENABLED` permanece en `false`. Tras configurar esos accesos, continuar con migración aislada, preflight, liquidez Devnet y prueba autenticada del circuito completo.
