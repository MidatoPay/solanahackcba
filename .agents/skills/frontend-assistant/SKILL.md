---
name: frontend-assistant
description: Corregir y verificar frontend existente a partir de pedidos, errores o capturas, preservando el trabajo local y las variantes del producto. Usar para implementar componentes, resolver fallos de interfaz y preparar cambios para revision; la definicion de marca y el diseno UX requieren referencias aprobadas.
---

# Asistente de frontend

Trabajar como colaborador del desarrollador en el chat del editor. Convertir pedidos concretos en cambios acotados y evidencia revisable. Estas instrucciones son Markdown portable; las herramientas, permisos y modos disponibles dependen del agente que las lea.

## Contexto al comenzar

- Leer las instrucciones vigentes del repositorio y comprobar raiz, branch, estado de Git y scripts actuales. No asumir que el directorio inicial es la raiz operativa.
- En MidatoPay, leer [el contexto del proyecto](references/midatopay.md). En otro proyecto, descubrir sus convenciones sin trasladar reglas financieras de MidatoPay.
- Identificar archivos afectados y cambios preexistentes. Si otro desarrollador cambia los mismos fragmentos durante la tarea, releerlos y adaptar la correccion; no sobrescribirlos con una version anterior.
- Las instrucciones del usuario y el modo del harness delimitan la tarea. En modo plan, preparar la propuesta sin implementar.

## Entender y corregir

1. Inspeccionar componentes, estilos, llamadas y pruebas relevantes antes de proponer una solucion. Distinguir hechos observados de hipotesis.
2. Determinar pantalla, variante de producto o pais y comportamiento esperado. Preguntar solamente cuando una ambiguedad cambie la implementacion; resolver detalles rutinarios con el codigo existente.
3. Si hay captura, identificar el estado y viewport que representa. Una imagen no define por si sola interacciones, pantallas pequenas ni estados omitidos. Conservar patrones existentes en lo no especificado.
4. Implementar el cambio minimo coherente, reutilizando componentes y estilos del proyecto. Evitar reformateos generales, migraciones de librerias y refactors ajenos al pedido.
5. Mantener separada la presentacion de la logica de negocio. Si la correccion exige cambiar autenticacion, contratos o comportamiento financiero, explicar el alcance y aplicar las verificaciones pertinentes; no ocultarlo como ajuste de CSS.

No inventar una identidad visual a partir de una captura aislada. Se pueden corregir defectos funcionales, overflow y accesibilidad siguiendo la interfaz existente; nuevas decisiones de marca o UX requieren una referencia aprobada.

## Verificar con lo disponible

- Elegir checks por el comportamiento modificado, usando los scripts realmente existentes. Para un fallo, preferir una regresion que ejercite el comportamiento y detecte la causa.
- Si hay navegador o Playwright disponible, reproducir el estado, revisar consola y comprobar interaccion y tamanos relevantes. Para un cambio visual, capturar antes/despues con los mismos datos y dimensiones cuando sea posible.
- Revisar teclado, foco, nombres accesibles, carga, vacio, error y deshabilitado en los elementos afectados. Una captura no prueba el comportamiento.
- Simular datos y servicios cuando corresponda. No ejecutar operaciones reales para generar evidencia visual.
- No afirmar que un build o render estatico demuestra login, callbacks, efectos de React o una operacion completa en navegador.
- Si falta navegador, acceso o referencia, informar el limite concreto y continuar con verificaciones independientes. No instalar dependencias ni configurar MCPs por el solo hecho de activar la skill.
- Si ya hay comparacion visual, conservar referencias aprobadas. Actualizar una referencia solo cuando el cambio esperado haya sido revisado, nunca para silenciar un fallo.

## Entrega al desarrollador

Comunicar brevemente: resultado y archivos principales, checks ejecutados y resultado, evidencia visual disponible y limitaciones pendientes. Separar implementado, verificado y propuesto.

Preparar el diff para revision humana. La invocacion de esta skill no autoriza por si sola commits, push, merge, despliegues o cambios en servicios externos; realizar esos pasos cuando la tarea del usuario los incluya.

Para iniciar otro chat, usar la [guia de uso](../../../docs/FRONTEND_ASSISTANT.md).
