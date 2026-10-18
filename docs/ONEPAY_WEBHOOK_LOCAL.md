# OnePay sandbox: webhook por desarrollador

Cada desarrollador mantiene su copia privada de `.env.colombia`, su configuración local de ngrok y un webhook de OnePay apuntando a su computadora. La ruta de la aplicación es siempre `/webhooks/onepay`; el dominio público pertenece a cada instalación.

## Preparación inicial

Ejecutar los comandos desde la raíz del repositorio `solanahackcba/`.

1. Instalar el agente ngrok y obtener el **authtoken del agente** desde su dashboard. No es la API key de OnePay.
2. Crear la configuración privada a partir de la plantilla, si todavía no existe:

   ```powershell
   New-Item -ItemType Directory -Force .netlify | Out-Null
   if (-not (Test-Path .netlify/ngrok-colombia.yml)) {
     Copy-Item config/ngrok.colombia.example.yml .netlify/ngrok-colombia.yml
   }
   ```

3. Editar `.netlify/ngrok-colombia.yml` y reemplazar `REEMPLAZAR_CON_TU_NGROK_AUTHTOKEN` por el authtoken propio. La copia en `.netlify/` está ignorada por Git; la plantilla compartida queda sin credenciales.
4. Preparar `.env.colombia` con `npm run colombia:env` si falta. Este comando conserva el archivo existente. En cada instalación nueva, elegir un `PLATFORM_DEPLOYMENT_ID` propio, por ejemplo `colombia-sandbox-ana`, antes de crear operaciones y mantenerlo estable. Este identificador separa registros de distintos desarrolladores si utilizan la misma base de sandbox.

## Iniciar aplicación y túnel

Primera terminal:

```powershell
npm run dev:colombia
```

Esperar a que Netlify termine de cargar las Functions. La aplicación se abre en `http://localhost:8888`.

Segunda terminal:

```powershell
ngrok config check --config .netlify/ngrok-colombia.yml
ngrok start onepay-colombia --config .netlify/ngrok-colombia.yml
```

La configuración dirige el túnel al servidor completo de Netlify en el puerto **8888**. El valor `url: "https://"` utiliza el dominio de desarrollo asignado a la cuenta ngrok; también se puede escribir su URL HTTPS completa en ese campo.

## Registrar el destino en OnePay

En el ambiente de pruebas de OnePay, abrir **Desarrolladores → Webhooks** y registrar la URL HTTPS mostrada por ngrok agregando la ruta:

```text
https://DOMINIO-DE-ESTE-DESARROLLADOR/webhooks/onepay
```

Escuchar los eventos de cargos y dispersiones que necesita la integración: `charge.paid`, `charge.failed`, `cashout.created`, `cashout.processing`, `cashout.completed`, `cashout.cancelled` y `cashout.rejected`.

Guardar los valores reales de OnePay en el `.env.colombia` de esa computadora:

```dotenv
ONEPAY_API_KEY=CLAVE_DE_API_SK_TEST
ONEPAY_WEBHOOK_SECRET=SECRETO_GENERADO_PARA_ESTE_WEBHOOK
ONEPAY_WEBHOOK_TOKEN=TOKEN_GENERADO_PARA_ESTE_WEBHOOK
PAYMENTS_BASE_URL=http://localhost:8888
```

Reiniciar `npm run dev:colombia` después de editar las variables. `PAYMENTS_BASE_URL` sigue siendo local porque se usa para invocar al worker; la URL pública se configura en OnePay.

El endpoint valida el token y la firma HMAC antes de guardar el evento. Para responder correctamente también necesita la base de datos Colombia configurada y migrada. La configuración restante de OnePay, la base y la liquidez está en [COLOMBIA_IMPLEMENTATION.md](COLOMBIA_IMPLEMENTATION.md).

## Verificar

```powershell
npm run dev:check:colombia
npm run colombia:check
```

El primer comando comprueba rutas locales y rechazo de webhooks sin credenciales. El segundo verifica los requisitos del sandbox en modo de solo lectura. La prueba de entrega firmada se realiza desde el webhook registrado en OnePay y debe responder HTTP 200; los intentos pueden verse en el inspector local de ngrok `http://127.0.0.1:4040`.

El registro de OnePay y el dominio de desarrollo se reutilizan. La aplicación y el túnel deben permanecer encendidos durante las pruebas; si se elige otro dominio, actualizar el destino registrado en OnePay.

Referencias: [webhooks de OnePay](https://docs.onepay.la/guides/implementar-webhooks), [configuración v3 de ngrok](https://ngrok.com/docs/gateway/agent/config/v3) y [dominios de desarrollo](https://ngrok.com/docs/gateway/domains).
