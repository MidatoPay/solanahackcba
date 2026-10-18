# Prueba del circuito Colombia en sandbox

Este procedimiento completa la validación externa pendiente del desarrollo. Las pruebas automatizadas no sustituyen el login real, la entrega firmada del webhook ni la firma Privy en el navegador.

## Preparar la sesión

1. Completar la [configuración de Colombia](COLOMBIA_IMPLEMENTATION.md#preparación-local), aplicar la migración en PostgreSQL aislado y comprobar la liquidez de prueba. `npm run colombia:check` debe aprobar todos sus checks.
2. Preparar el [webhook por desarrollador](ONEPAY_WEBHOOK_LOCAL.md), mantener aplicación y túnel encendidos y registrar el destino HTTPS en OnePay sandbox.
3. Con `PLATFORM_ENABLED=true`, iniciar `npm run dev:colombia`, esperar la carga de Functions y ejecutar `npm run dev:check:colombia`.
4. Usar dos usuarios de prueba, A y B. Registrar sus wallets principales y comprobar Solana Devnet y el mint mostrado. Los beneficiarios y cuentas deben ser fixtures admitidos por OnePay sandbox.
5. Registrar por cada caso: usuario, referencia MidatoPay, referencia del proveedor, distribución/cotización, saldo antes/después, estados y firma Solana si corresponde. La cotización a comparar es la fijada en la operación, no una tasa de ejemplo ni una consulta posterior.

## Casos y criterios

| Caso | Acción | Resultado que permite aprobar |
| --- | --- | --- |
| Inicio y documentos | Ingresar como A, esperar la wallet y revisar términos, privacidad y servicios. Intentar una operación nueva antes de aceptar. | El inicio no falla durante la restauración. No se crea dinero antes de aceptar la versión vigente. País, red y borradores corresponden a Colombia sandbox. |
| Conversión total | Configurar 100% y crear un cobro de 10.000 COP. Pagar mediante el mecanismo oficial de simulación de OnePay. | Comisión de conversión: 50 COP; saldo retenido: cero. El comprobante distingue pago recibido de USDC entregados. La entrega finalizada coincide con los USDC fijados y tiene firma verificable en Devnet. |
| Conversión parcial | Configurar 30% y cobrar 10.000 COP. | A conserva 7.000 COP. Se convierten 3.000 COP con comisión de 15 COP y una sola entrega USDC. B no adquiere ese saldo ni ve la operación. |
| Importe fijo | Configurar 2.000 COP fijos y cobrar 1.000 COP. | Se convierten como máximo los 1.000 COP del cobro. La comisión es 5 COP y no se genera saldo negativo. |
| Conversión por debajo del mínimo | Configurar 0,01 COP fijos y cobrar 1.000 COP. | El importe a convertir no alcanza 0,01 USDC: A conserva los 1.000 COP, sin comisión ni entrega USDC. El comprobante explica el resultado. |
| Compra desde saldo | Con saldo COP suficiente, cotizar y comprar por 1.000 COP. | Se reservan 1.000 COP y la comisión fijada es 5 COP. La reserva se consume únicamente al finalizar la entrega. Recargar la página conserva la operación original. |
| Venta de USDC | Cotizar una venta de al menos 0,01 USDC desde la wallet de A. Revisar receptor, mint, red y pagador y firmar en Privy. | Los COP netos y la comisión coinciden con la cotización. No se acreditan COP antes de la recepción finalizada. Vender no inicia por sí solo un retiro. |
| Destinos propios | Registrar los fixtures de beneficiario, cuenta bancaria y llave Bre-B de A. | Cada destino queda listo con su proveedor. Una llave de otro titular se rechaza. Guardar una cuenta en la agenda no crea un destino de retiro. |
| Retiro completado | Retirar 1.000 COP a un destino propio listo; repetir también con el otro tipo de destino cuando el sandbox lo permita. | El disponible baja 1.000 COP, aparecen 1.000 COP reservados y la finalización consume esa reserva una sola vez. El comprobante muestra cuenta enmascarada y comisión de retiro cero. |
| Retiro rechazado | Provocar un rechazo mediante un fixture/mecanismo oficial de OnePay. | Un rechazo definitivo devuelve exactamente la reserva al disponible. Una venta anterior finalizada permanece finalizada. Una respuesta incierta continúa pendiente o en revisión; no habilita un pago sustituto. |
| Envío USDC y cuota | Enviar desde A a la wallet de B. Considerar la venta anterior como el primer envío patrocinado del día. Intentar un tercer submit de A. | Solo se entrega el importe aprobado a B. Actividad y Explorer coinciden. El tercer submit se rechaza por cuota; no transmite ni consume fondos. |
| Agenda | Guardar contactos con wallet, solo banco y ambos; editar y quitar cuentas. | Los datos bancarios son opcionales, mantienen ceros iniciales y se enmascaran en la lista. Los contactos solo bancarios no se ofrecen como receptores USDC. B no puede leer ni editar contactos de A. |
| Webhook duplicado y reconexión | Reenviar un evento desde OnePay y recargar durante el seguimiento de la operación. | Las entregas válidas se reciben con HTTP 200. Los eventos no duplican saldo, conversión ni retiro. La actividad recupera la misma referencia; un webhook recibido no equivale por sí solo a una entrega de USDC. |
| Documentos y pausa | Después de preparar una operación, pausar nuevas operaciones o actualizar los documentos de prueba. | Las nuevas operaciones se bloquean según la configuración. Las operaciones aceptadas siguen observándose y mantienen referencias, regla y cotización originales. Una pausa no transmite wires nuevos. |
| Reporte | Consultar/exportar como usuario administrador y probar el mismo acceso con B no administrador. | El reporte identifica COP, país, tipo y proveedor. La comisión registrada de conversión corresponde al paso finalizado y no se cuenta nuevamente en el cobro padre. El usuario no administrador recibe acceso denegado. |

Las compras y cobros no consumen la cuota de dos envíos patrocinados. Una venta firmada y una transferencia firmada sí completan los dos intentos diarios de A; una preparación sin submit puede cancelarse. La cuota se renueva a medianoche de Colombia, sin borrar ni modificar registros para repetir casos.

Cuando OnePay deje una operación pendiente, registrar ese estado y continuar su conciliación; no marcar el caso como aprobado hasta comprobar su resultado definitivo. Si el mecanismo de simulación no admite resolver el estado de un QR Bre-B, registrar la limitación de contrato y resolverla con OnePay antes de dar por validado ese caso.

## Evidencia de cierre

- Entrega real del webhook registrado, con autenticación HMAC y referencia conocida.
- Cobro y división de COP, conversión USDC finalizada y retiro con un resultado definitivo.
- Firma Privy en navegador, recepción de B y recuperación después de recargar.
- Saldos individuales coherentes, sin duplicados tras reenvíos, y reporte de comisiones.
- Revisión visual de las pantallas y de la agenda en escritorio y móvil.

Hasta reunir estas evidencias, el circuito externo permanece pendiente aunque el build y las pruebas automáticas hayan aprobado.
