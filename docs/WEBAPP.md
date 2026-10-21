# Instalación de MidatoPay

La app ofrece una tarjeta inferior en Android y iPhone desde la bienvenida, antes
del login. Se vuelve a ofrecer al regresar a la página (carga, foco o visibilidad)
si pasaron al menos 12 horas desde la última presentación. No hay temporizador
que abra avisos mientras el usuario sigue usando la página. “Ahora no” cierra la
tarjeta; la opción manual permanece disponible en Perfil.

El plazo se guarda por navegador y origen en `midatopay.install.lastShown` de
localStorage. No depende de la cuenta. Si el almacenamiento está bloqueado, el
plazo dura solo durante la sesión de la página. La tarjeta automática no se muestra
en computadoras ni en modo instalado. La detección de una app ya instalada desde
una pestaña normal tiene límites del navegador, especialmente en iPhone.

- Android: el botón abre el diálogo nativo solo cuando el navegador lo ofrece.
  Si no está disponible, muestra instrucciones para el menú del navegador.
- iPhone: abrir en Safari → Compartir → Agregar a inicio → Agregar; mantener
  “Abrir como app web” activado cuando aparezca.
- Navegadores integrados: abrir primero en Safari (iPhone) o Chrome (Android).

La instalación requiere HTTPS o localhost. Los íconos existentes se reutilizaron
del trabajo `feat/installable-webapp`. El manifest usa `/` como inicio y alcance.
Netlify sirve el manifest y el service worker con revalidación.

El worker se registra solo en producción y guarda únicamente `offline.html`.
No almacena HTML de la app, bundles, sesiones, saldos, RPC ni pagos. No fuerza
recargas al actualizarse. Sin red muestra una página para reconectarse y revisar
cualquier operación pendiente antes de repetirla.

## Verificación

```sh
node --test test/pwa.test.js test/install-reminder.test.js test/app-startup.test.js
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

Revisar Manifest y Service Workers en las herramientas del navegador. Probar en
Android Chrome y iPhone Safari mediante HTTPS: bienvenida sin sesión, instalación,
apertura desde el ícono y restauración de sesión. La sesión instalada puede ser
independiente del navegador. La preview de Vite no sustituye las Functions para
validar autenticación o pagos. No realizar operaciones financieras para esta prueba.
