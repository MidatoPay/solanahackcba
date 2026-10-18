# Asistente de frontend en Cursor, Codex y otros agentes

La skill `frontend-assistant` permite trabajar desde el chat del editor sobre el frontend existente: analizar pedidos o capturas, preparar correcciones y presentar verificaciones para revision del desarrollador. No es una aplicacion de chat nueva.

Esta entrega agrega instrucciones y contexto del proyecto. No instala Playwright, MCPs o un sistema de diseno, ni modifica pantallas. El manual de marca y el flujo con la disenadora UX/UI se trabajaran despues; no bloquean correcciones tecnicas que conserven los patrones existentes.

## Actualizar el branch de trabajo

Desde la raiz del repositorio y estando en tu branch habitual:

```sh
git status
git fetch origin
git merge origin/main
```

Antes del merge, guardar los cambios propios en un commit si estan listos. Si hay trabajo sin terminar, resolver como preservarlo antes de integrar; no usar reset ni stash automatico. Revisar cualquier conflicto y continuar segun el flujo habitual del equipo. El merge incorpora tambien los demas cambios pendientes de main, por lo que corresponde revisar y probar esa integracion.

Esta actualizacion contiene un paquete de Markdown y no requiere instalar dependencias. Si otros commits integrados cambian el lockfile, seguir la instalacion reproducible del proyecto para esos cambios.

## Abrir el asistente

### Cursor

Abrir la raiz del repositorio en una version compatible con Agent Skills. Iniciar un chat Agent y seleccionar `/frontend-assistant` si aparece. Cursor reconoce skills en `.agents/skills/`; si no aparece, usar el mensaje explicito de abajo. Para reutilizar la skill durante una sesion, Cursor tambien permite usarla como Custom Mode segun la version instalada.

### Codex

Abrir una sesion en la raiz del repositorio e invocar `$frontend-assistant` si esta descubierta. Si el cliente todavia no la muestra, iniciar una sesion nueva o usar el mensaje explicito.

### Cualquier agente que pueda leer el repositorio

Copiar este mensaje en un chat nuevo; las rutas son relativas a la raiz:

```text
Actua como asistente de frontend de este repositorio. Lee
.agents/skills/frontend-assistant/SKILL.md y su referencia
.agents/skills/frontend-assistant/references/midatopay.md.
Respeta las instrucciones vigentes y el modo actual del editor.
Revisa el branch, los cambios locales y la implementacion antes de editar.
Para cada pedido, prepara una correccion acotada y presenta lo verificado,
la evidencia visual disponible y cualquier limitacion para mi revision.

Mi pedido: [describir la correccion y el pais o pantalla; adjuntar captura si ayuda].
```

Usar el modo de ejecucion del editor para implementar; en modo plan el asistente preparara una propuesta. Las instrucciones no agregan permisos ni herramientas al harness. La lectura explicita del archivo es la alternativa portable si no existe descubrimiento automatico.

## Como pedir una correccion

Indicar pais, pantalla, problema y resultado esperado. Si hay captura, agregar el ancho o dispositivo y el estado de la pantalla cuando se conozcan. El asistente debera investigar detalles deducibles del codigo sin exigir un formulario completo.

Ejemplos:

- "Argentina, confirmacion de envio: la direccion larga desborda en movil. Corregi el layout manteniendo visible el importe y sin cambiar la operacion."
- "Colombia, inicio: esta captura muestra una tarjeta cortada a 390 px. Reproduci el estado y prepara la correccion con evidencia antes/despues si tenes navegador."
- "El perfil falla mientras carga el usuario. Revisa el estado nulo, agrega una regresion pertinente y verifica el arranque."

El resultado debe distinguir cambios implementados, checks realmente ejecutados y verificaciones pendientes. Un build aprobado no implica que se haya probado el login o un flujo financiero completo. Revisar el diff y la evidencia antes del merge.

## Mantenimiento y portabilidad

La fuente del procedimiento es [SKILL.md](../.agents/skills/frontend-assistant/SKILL.md); el mapa del producto esta en [la referencia MidatoPay](../.agents/skills/frontend-assistant/references/midatopay.md). Actualizar la referencia cuando cambien entradas, paises o scripts y conservar los detalles tecnicos en el codigo.

No duplicar la skill por editor ni copiar estas reglas dentro de multiples archivos de instrucciones. Para llevarla a otro harness sobre este repositorio, compartir la carpeta completa, conservar las rutas relativas e indicar que lea `SKILL.md`. Para otro producto, adaptar el contexto de MidatoPay y los enlaces de uso.

Los conectores de Figma, la automatizacion visual reproducible y el sistema de diseno seran ampliaciones posteriores. Las capturas actuales sirven para tareas concretas; no representan una aprobacion global de marca.

Referencia de compatibilidad: [Agent Skills en Cursor](https://cursor.com/docs/skills). Comprobar las capacidades de la version instalada; el mensaje explicito permite usar el paquete sin depender de menus especificos.
