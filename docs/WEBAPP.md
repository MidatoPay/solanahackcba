# Instalación de MidatoPay

MidatoPay puede instalarse desde un origen HTTPS o desde `localhost`. El manifest
define una ventana independiente y los íconos de la aplicación. En **Perfil** se
muestra la opción de instalación cuando el navegador ofrece el diálogo nativo;
también hay instrucciones para instalar desde los menús del navegador.

- Android / Chrome / Edge: usar **Instalar app** o el menú del navegador.
- iPhone / iPad: abrir en Safari → **Compartir → Agregar a inicio**.
- macOS / Safari: **Archivo → Agregar al Dock**.

La sesión de una instalación puede ser independiente de la del navegador.
Comprobar login, restauración de sesión y permisos de cámara/micrófono en el
dispositivo antes de validar cobros reales.

## Ícono

Guardar el PNG cuadrado original en `assets/app-icon/icon.png` (ideal 1024×1024).
Luego ejecutar `npm run icons:generate`. Las salidas en `public/icons/` incluyen
192 px, 512 px, máscara Android, Apple Touch Icon de 180 px y favicon de 32 px.
Sin el original se utiliza provisionalmente `public/logo/logo.png`.

## Conexión y actualizaciones

El service worker se registra únicamente en builds de producción, incluida la
preview local. Guarda solo `offline.html`; no guarda HTML de la app, bundles,
sesiones, saldos, RPC ni respuestas o solicitudes de pagos. No hay operaciones
offline ni reenvíos en segundo plano. Ante una navegación sin red, muestra un
aviso para reconectarse y revisar el estado de cualquier operación pendiente.

Se respeta el ciclo normal de actualización del service worker, sin forzar
recargas durante una operación. Si cambia la página offline, aumentar la versión
de `CACHE` en `public/sw.js`. Netlify sirve el worker y el manifest con revalidación.

## Verificación local

```sh
npm run icons:generate
node --test test/pwa.test.js test/app-startup.test.js
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

Abrir `http://localhost:4173` en Chrome / Edge y revisar **Application → Manifest**
y **Service Workers**. Confirmar instalación en ventana independiente y la
pantalla informativa al recargar sin red. La preview de Vite sirve el frontend;
la validación de sesión y pagos necesita también las Functions del entorno.

Referencias: [requisitos de instalación](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
y [ciclo del service worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).
