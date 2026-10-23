# MidatoPay

Este directorio es la raíz del repositorio. Ejecutar Git y npm desde aquí.
Para desarrollo, leer `.agents/skills/frontend-assistant/SKILL.md` y su referencia
`references/midatopay.md`; conservar las autorizaciones financieras existentes.

## Publicación de main

`main` debe desplegarse automáticamente mediante la integración Git de Netlify.
Los commits y merges normales a `main` no deben incluir `[skip netlify]`, `[skip ci]`
ni otros marcadores que omitan ese despliegue. Usarlos únicamente si el usuario
solicita explícitamente omitir la publicación de ese cambio.

Antes de publicar cambios de seguridad, verificar la configuración de servidor,
las migraciones y los checks pertinentes. Nunca incorporar `.env`, claves, tokens
o códigos reales al repositorio ni a la salida de comandos.
