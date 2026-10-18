# Contexto de frontend de MidatoPay

Esta referencia describe el checkout observado al crear la skill. Confirmar los archivos y scripts en el branch actual: las versiones por pais y las instrucciones operativas pueden evolucionar independientemente.

## Ubicacion e instrucciones

- La raiz operativa contiene `package.json`, `src/` y `netlify/functions/`. En el workspace original esta dentro de `solanahackcba/`; ejecutar Git y npm desde esa raiz.
- Leer `AGENTS.md` si existe. Si esta disponible `.agents/skills/midatopay-dev-release/SKILL.md`, aplicar su procedimiento para desarrollo y publicacion segun el alcance, sin duplicarlo aqui.
- Si falta alguno de esos archivos, continuar con las instrucciones disponibles, scripts actuales y esta referencia. No cambiar de branch ni copiar instrucciones desde otra rama automaticamente.
- No leer ni imprimir `.env` para orientarse. Usar ejemplos de configuracion cuando hagan falta y nunca incorporar credenciales a capturas o commits.

## Mapa del frontend

| Area | Punto de entrada observado | Consideracion |
| --- | --- | --- |
| Aplicacion | `src/main.jsx` | React/Vite y Privy; comprobar el arranque con sesion incompleta |
| Argentina | `src/App.jsx` | Pantallas y estado concentrados; estilos inline y reglas en `index.html` |
| Colombia | `src/platform/PlatformApp.jsx` | Interfaz propia con `src/platform/platform.css` y componentes de plataforma |
| Seleccion por despliegue | `src/platform/DeploymentApp.jsx` | En Colombia consulta `/app-config`; Argentina puede conservar la entrada anterior segun el branch |
| Capacidades por pais | `src/platform/countries.js` | Disponible en el trabajo de Colombia; no asumir que ya existe en main |
| Componentes argentinos | `src/TransferApproval.jsx`, `src/TransferReceipt.jsx`, `src/BusinessProfile.jsx` | Revisar usos y contratos antes de extraer una abstraccion compartida |

No imponer el frontend colombiano a Argentina ni asumir equivalencia entre proveedores. Compartir componentes de presentacion cuando su comportamiento coincida; conservar moneda, etiquetas, servicios y estados propios de cada pais. No convertir una correccion puntual en una unificacion completa.

## Limites que afectan una correccion

- Conservar la seleccion de wallet principal y sus resolvers existentes; no elegir otra wallet para evitar un fallo visual o un dato nulo.
- Al tocar React o autenticacion, contemplar usuario nulo, sesion restaurandose y wallet pendiente. Los hooks y efectos requieren evidencia de navegador para sus recorridos completos.
- Leer `SOLANA-RULES.md` y `docs/USDC_TRANSFERS.md` si el cambio afecta dinero, importes, firmas o redes. Preservar importes, destinatarios, estados y autorizaciones; no firmar ni mover fondos reales como prueba automatica.
- No cambiar contratos backend, capabilities o configuracion de entornos para que una pantalla de prueba parezca funcionar.
- El manual de marca y el trabajo con UX/UI se incorporaran posteriormente. No declarar los colores o tipografias actuales como sistema de diseno aprobado.

## Verificaciones proporcionales

Consultar primero `package.json` y los tests presentes; los comandos siguientes son candidatos, no una secuencia obligatoria para cada ajuste.

| Cambio | Comprobacion |
| --- | --- |
| Solo instrucciones o Markdown | Frontmatter, enlaces relativos y diff; no requiere build ni suite financiera |
| React o arranque | Prueba afectada, `node --test test/app-startup.test.js` si existe y `npm run build` |
| Interfaz Colombia | Pruebas pertinentes de `test/platform-ui.test.js` si estan presentes; build de Colombia solo con configuracion de prueba valida |
| Flujos con efectos o callbacks | Navegador ademas de pruebas de render estatico |
| Functions o logica financiera | Procedimiento del repositorio y checks correspondientes al cambio, no solo capturas |

El proyecto tiene pruebas con `node:test`; no asumir que usa Vitest, que existe un script de lint o que Playwright esta instalado. `npm run dev` sirve Vite; APIs de Netlify necesitan el entorno local apropiado. Comprobar los scripts `dev:full` o `dev:colombia` presentes antes de iniciarlos, sin ejecutar migraciones para una tarea de UI.

Usar fixture de usuario, saldos, operaciones y reloj reproducibles para capturas. Mantener el indicador sandbox cuando corresponda. Si no puede reproducirse un estado con las herramientas y accesos disponibles, describirlo como pendiente.

## Trabajo entre branches

Respetar archivos modificados y sin seguimiento de otros trabajos. Stagear solo rutas propias cuando se pida un commit. Las instrucciones de esta skill pueden viajar en un commit documental aislado; su existencia no significa que Colombia o sus endpoints ya esten integrados en main. Coordinar cambios en archivos compartidos con el desarrollador y verificar el resultado de cada integracion.
