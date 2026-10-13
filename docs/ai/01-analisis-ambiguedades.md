# Análisis de inconsistencias, errores y ambigüedades del enunciado

> Prompt: *"busca inconsistencias, errores y ambiguedades en la definición de CHALLENGE.md"*
>
> Output de Claude, sin cambios de contenido. Las decisiones finales están en la tabla *Decisiones sobre ambigüedades del enunciado* del [README](../../README.md). Donde difieren, manda el README.

Cada punto trae una decisión sugerida para documentar en el README. Los más importantes van primero.

## 1. Inconsistencias y errores en el texto

| # | Dónde | Problema | Decisión sugerida |
|---|---|---|---|
| 1 | Tiempos → TTL | "si el beneficiario no confirmó **ni canceló**": el beneficiario no cancela, **rechaza**. | Leerlo como "ni rechazó". |
| 2 | Tiempos → TTL | "la operación **queda cancelada**", pero el estado final es `Expired`, no `CancelledBySender`. | El estado es `Expired`. "Cancelada" se toma en sentido coloquial. |
| 3 | Parte 2 | "Vencido" significa dos cosas: el estado on-chain `Expired` (ya se recuperaron los fondos) y el estado derivado "`Pending` con TTL pasado, recuperable". | Usar dos estados distintos en la API, por ejemplo `Expired` (final) y `ExpiredRecoverable` (derivado). |
| 4 | Puntos opcionales | El invariante "el balance del contrato por token siempre **iguala** la suma de escrows pendientes" es falso: cualquiera puede mandar tokens directo al contrato, y los tokens rebasing o fee-on-transfer lo rompen. | Probar `balance >= suma de pendientes`. |
| 5 | Requisitos vs. opcionales | Dice "cualquier ERC-20", pero el soporte de fee-on-transfer figura como opcional. Si no se maneja, el contrato recibe menos de `amount` y al liberar paga con fondos de otros escrows, o sea un robo entre escrows. Eso pesa en el 30 % de seguridad. | Como mínimo, medir la diferencia de balance y revertir si `recibido != amount`. Si no, registrar el monto recibido. |
| 6 | Requisitos | "ni siquiera el **owner**" supone que hay un owner, pero ninguna función lo necesita. | Contrato sin owner, sin pausa y sin upgrade. Es la forma más simple de cumplir "nadie puede mover fondos". |
| 7 | Nombres | Las acciones, los estados y los eventos no tienen nombres paralelos: Confirmar → `Released` → `EscrowReleased`, Cancelar → `CancelledBySender` → `EscrowCancelled`, Recuperar → `Expired` → `EscrowExpired`. | Respetar los nombres de eventos y estados del enunciado y documentar cómo se mapean a las funciones. |
| 8 | Entrega | Pide "repositorio Git (público o privado)" en un lado y "repo en **GitHub**" en otro. | GitHub. |
| 9 | Endpoints | `/escrows/:id` devuelve "**montos**" en plural, pero un escrow tiene un solo monto. | Devolver el monto pedido y el recibido, que solo difieren con fee-on-transfer. |

## 2. Ambigüedades en la lógica del contrato (pesan en "Corrección", 20 %)

10. **Qué pasa justo en el límite.** "Antes de creación + 2 h" y "pasadas las 2 horas" no dicen qué pasa cuando `block.timestamp == createdAt + 2h`. Los tests piden "justo antes y justo después", pero no "exactamente en".
    - Sugerencia: cancelar si `t < cancelDeadline`, confirmar o rechazar si `t < expiresAt`, recuperar si `t >= expiresAt`.
    - La tabla ya implica que confirmar y recuperar no se solapan a los 7 días, porque usa "antes" y "desde".
    - Testear también el segundo exacto.
11. **Qué guarda `cancelDeadline`.** Puede ser el último instante válido o el primero inválido. Esto cambia el `<` contra el `<=` y lo que muestra la API.
12. **Ventanas solapadas entre 0 y 2 h.** En ese tramo el enviador puede cancelar y el beneficiario puede confirmar o rechazar a la vez. Gana la primera transacción que se mina, así que hay front-running en ambos sentidos.
    - El enunciado no dice si las 2 h son un período de gracia donde el beneficiario no puede actuar.
    - Sugerencia: seguir la tabla al pie de la letra (el beneficiario puede actuar desde t = 0) y documentar la carrera.
13. **Cómo se genera el `id`.** Puede ser un contador, elegido por el que llama, o un hash.
    - Si lo elige el que llama, un atacante puede ocupar ese id antes (front-running).
    - Sugerencia: contador secuencial que empiece en 1, así el 0 o un struct vacío significa "no existe".
14. **Leer un `id` inexistente.** No está definido si revierte o devuelve un struct vacío. Sugerencia: revertir con `EscrowNotFound`.
15. **Validaciones que faltan.** No pide validar `token != address(0)`, ni que el token sea un contrato. Con `SafeERC20` de OZ v5, una dirección sin código revierte, pero conviene validarlo explícitamente.
16. **Si los tiempos son `immutable`.** No exige que `cancelWindow < ttl`, ni que sean distintos de cero. Hay que validarlo en el constructor.
17. **"El escrow vence".** On-chain nada vence solo: el escrow sigue `Pending` hasta que el enviador llama a recuperar. Si nunca lo llama, los fondos quedan ahí. Eso es aceptable, pero conviene decirlo.
18. **Quién puede recuperar.** La tabla dice solo el enviador. Que cualquiera pudiera disparar la recuperación, siempre enviando los fondos al enviador, sería igual de seguro. Sugerencia: respetar la tabla.

## 3. Choques entre "cualquier ERC-20" y "sin forma de bloquear fondos"

19. **Tokens con blacklist o pausa (USDC, USDT).**
    - Si el enviador está en la blacklist, rechazar y recuperar revierten siempre, y los fondos quedan bloqueados para siempre.
    - Si el beneficiario está en la blacklist, no puede confirmar.
    - Con transferencias directas (push) esto no tiene solución. Con un patrón pull (acreditar y después `withdraw(to)`) se mitiga, pero se complica la API.
    - Sugerencia: push, y documentarlo como limitación aceptada o como mejora a futuro.
20. **Tokens con hooks (ERC-777) y reentrancy.** Se cubre con checks-effects-interactions más `nonReentrant`.
21. **Tokens rebasing.** Un monto fijo guardado se desfasa del balance real. Sugerencia: declararlos no soportados.
22. **Monto del evento con fee-on-transfer.** No está claro si `amount` en `EscrowCreated` es el pedido o el recibido.

## 4. Ambigüedades de la API y el indexador

23. **Con qué reloj se calcula el estado derivado.** No dice si `canCancel` y "vencido" se calculan con el reloj del servidor o con el timestamp de la cadena.
    - El script de demo avanza el tiempo del nodo (`evm_increaseTime`), así que con `Date.now()` la API mostraría estados equivocados.
    - Sugerencia: usar el timestamp del último bloque de la cadena.
24. **Confirmaciones contra reorgs en Anvil.** Con automine no se minan bloques si no hay transacciones, así que los últimos eventos nunca llegarían a N confirmaciones.
    - Sugerencia: N configurable (0 en local, alrededor de 12 en testnet).
    - Otra opción es indexar enseguida y guardar `blockHash` para detectar reorgs y retroceder.
25. **"Suscribirse" contra "retomar desde el último bloque".** Suscribirse sugiere WebSocket o `watchEvent`, pero para retomar sin perder eventos hace falta `getLogs` por rangos.
    - Sugerencia: polling con `getLogs` y un checkpoint que se guarda en la misma transacción de base de datos que las proyecciones.
26. **Clave de idempotencia.** Con un reorg, `(txHash, logIndex)` puede cambiar de bloque y de `logIndex`. Esto hay que definirlo junto con la estrategia de reorgs.
27. **Filtro `status=`.** No dice si filtra por el estado guardado o por el derivado del tiempo, ni cuáles son los valores válidos. Filtrar `ExpiredRecoverable` requiere comparar con `expiresAt` en la consulta.
28. **Formato de la respuesta.**
    - Paginación sin definir: offset o cursor, tamaño por defecto y máximo.
    - Los `uint256` (id, amount) superan `Number.MAX_SAFE_INTEGER`, así que conviene serializarlos como string.
    - Las direcciones en los filtros: decidir si se aceptan sin distinguir mayúsculas y se normalizan.
29. **`/health`.** "Estado del servicio" no está definido. Sugerencia: base de datos accesible, RPC accesible, último bloque indexado, head de la cadena y lag.
30. **Bloque inicial del indexador.** No se dice desde dónde empezar. Sugerencia: el bloque del deploy, configurable.

## 5. Entregables

31. **El script de flujo completo.** "Vencer" puede significar solo avanzar el tiempo, que muestra el estado derivado, o además llamar a recuperar.
    - Además, al avanzar el tiempo cambian todos los escrows a la vez, así que hace falta un escrow por camino y en un orden pensado.
    - Sugerencia: crear cada escrow justo antes de su acción, y hacer el de vencimiento al final con `increaseTime` y después recuperar.
32. **"Incluir outputs de prompts".** No dice qué, en qué formato ni dónde.
    - Sugerencia: una carpeta `docs/ai/` con los prompts relevantes y sus respuestas. Este análisis podría ser el primero.
