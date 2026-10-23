# Evidencia de seguridad — 2026-10-22

Rama: `fix/app-security-recovery-mobile`, base `origin/main` 97a6c00 confirmada
mediante fetch. Implementación local y verificaciones automáticas completadas.
**Aceptación para producción pendiente de staging real y dispositivos físicos.**
No se desplegó, migró una base remota, configuró secretos remotos ni enviaron emails
reales. No se firmaron ni enviaron transacciones financieras.

## Resultado automático

Entorno: Windows, Node 24.19.0. Runtime de despliegue declarado: Node 22.

| Comprobación | Resultado observado |
| --- | --- |
| `npm test` | 227 pruebas, 227 aprobadas, 0 omitidas/fallidas |
| Ciclo de vida/React después del ajuste final de vigencia | 31 pruebas aprobadas |
| `npm run build` | Aprobado; conserva avisos de chunks >500 kB y opción obsoleta de Vite |
| `npm run functions:check` | 22 Functions empaquetadas; endpoints protegidos rechazan anónimos |
| `npm run deps:check` | Exit 0 con umbral high; 21 vulnerabilidades moderadas transitivas |
| `npm run test:security:baseline` | Las cuatro regresiones fallan por aserción contra 1734064 |
| `npm run test:security:browser` | Chrome 155.0.8059.86, headless, viewport 390×844, aprobado |
| Migración repetida sobre datos existentes | PGlite/PostgreSQL: dos aplicaciones, factores/contacto sin cambios |
| PWA, instalación y redirecciones | Incluidas en la suite completa; exclusión explícita de seguridad del cache |

El build final y la auditoría requirieron reejecución fuera del sandbox por permisos
en `dist/assets` y conectividad al registro npm. El resultado aprobado corresponde a
esas reejecuciones, no a los intentos que fallaron por entorno.

Los 21 hallazgos moderados incluyen cadenas transitivas de WalletConnect/query-string,
fast-copy, hono y stream-json. No se aplicó `npm audit fix --force` ni se degradó Privy.

## Qué cubren las regresiones

- `security-limits.test.js`: 4 y 20 sesiones comparten IP durante 60 heartbeats
  (30 minutos simulados); auth agotada no impide renovar/revocar; contadores concurrentes,
  sesión ajena, IP confiable y `Retry-After`.
- `security-recovery.test.js`: alta con email/SMS, contacto fijado y actualización
  autorizada, códigos erróneos/vencidos/reenviados/reutilizados, quinto error, DID/sesión/
  propósito/versión ajenos, destinatario manipulado, límites, error de entrega, consumo
  único de `recover`, expiración al registrar passkey, revocaciones y rollback SQL.
- `app-security.test.js`: PIN, bloqueo concurrente y firmas WebAuthn reales con
  variaciones inválidas de RP, origen, UV, handle y credencial.
- `security-focus.test.js`: ambos órdenes foco/respuesta, espera de dos segundos,
  página oculta, `pagehide`, identidad, vencimiento, límite nativo, cancelación y
  liberación de streams de cámara recibidos tarde.
- `security-react.test.js`: efectos reales de panel/gate, email obligatorio con
  factor histórico, enlace SMS→email, no montar efectos privados antes de completar,
  cambio de sesión Privy y autenticador invocado antes de trabajo async en cada toque.
- `security-service.test.js`: servicio configurado y piloto con coincidencia exacta
  de DID; la política predeterminada exige seguridad.

Chrome ejecutó React, el handler de seguridad y PostgreSQL efímero reales, con Privy,
autenticador y correo simulados. Probó email→PIN, diez desbloqueos, acceso privado
denegado sin credencial, recuperación OTP→nuevo PIN, dos cancelaciones/reintentos de
passkey sin recargar, `pagehide` y cambio de identidad. Sin errores JavaScript.
Esto no prueba autenticadores físicos, entrega de correo ni una sesión real de Privy.

Artefactos locales ignorados por Git: `.netlify/security-final-tests.log`,
`.netlify/security-final-lifecycle.log`, `.netlify/security-final-functions.log`,
`.netlify/security-browser-evidence.png` y `.netlify/security-regression-I38pPS/`.
Los logs de baseline muestran fallos por aserción, no fallos de importación.
La captura contiene únicamente datos/código de fixtures; no cuentas reales.

## Pendientes de staging HTTPS

Se solicitó URL/sitio de staging y DID de prueba; no están identificados para esta
ejecución. No hay `.env.staging` en este checkout. No se asumió que las credenciales
locales correspondieran a un entorno de prueba.

| Validación | Estado / evidencia que registrar |
| --- | --- |
| Sitio y base aislada, Node 22+, RP/orígenes HTTPS y dominios Privy | Pendiente: URL, deploy ID y configuración no secreta |
| Dominio remitente verificado, secretos distintos por entorno | Pendiente: verificación en Resend; nunca copiar secretos al reporte |
| Migración dos veces sobre factores existentes en staging | Pendiente: conteos/integridad y resultado; no exportar factores |
| Login real por email y SMS→vinculación de email | Pendiente: DID de prueba y resultado |
| Entrega real, recuperación completa, reenvío y límites | Pendiente: ID de mensaje de prueba y resultado sin OTP/email completo |
| IP del edge y métricas agregadas en hosting | Pendiente: conteos por nombre, sin PII |
| Piloto exacto por DID y cuenta fuera de piloto | Pendiente: verificar API y UI con seguridad exigida al piloto |
| Rollback manual del código conservando tablas y factores | Pendiente: artefacto anterior compatible y ensayo en staging |

## Matriz física obligatoria

Cada fila requiere: alta, diez desbloqueos, cancelación/reintento, recuperación real
por email, segundo plano, bloqueo de pantalla, pérdida/retorno de red, cámara,
micrófono y diálogos Privy. Usar fixtures o devnet para operaciones financieras.
Registrar modelo exacto, versión completa de SO/navegador, fecha, evaluador,
deploy ID, resultado por recorrido y referencia de evidencia sin datos sensibles.

| Equipo requerido | Superficie | Modelo / SO / navegador observado | Resultado |
| --- | --- | --- | --- |
| iPhone iOS 16 | Safari | No disponible | PENDIENTE |
| iPhone iOS 16 | PWA instalada | No disponible | PENDIENTE |
| iPhone iOS 17.0–17.3 | Safari | No disponible | PENDIENTE |
| iPhone iOS 17.0–17.3 | PWA instalada | No disponible | PENDIENTE |
| iPhone versión actual | Safari | No disponible | PENDIENTE |
| iPhone versión actual | PWA instalada | No disponible | PENDIENTE |
| Android 9 con Chrome compatible | Chrome | No disponible | PENDIENTE |
| Android 9 con Chrome compatible | PWA instalada | No disponible | PENDIENTE |
| Android actual | Chrome | No disponible | PENDIENTE |
| Android actual | PWA instalada | No disponible | PENDIENTE |

El viewport de Chrome y los eventos simulados no sustituyen estas filas. No ampliar
el piloto ni declarar apto para producción mientras falte una fila requerida o
falle la recuperación. SMS de recuperación, offline y WebViews quedan fuera de alcance.

Configuración y contratos: [APP_SECURITY.md](APP_SECURITY.md).
