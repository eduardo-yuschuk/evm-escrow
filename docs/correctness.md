# Revisión de correctitud

Cada regla del enunciado, con dónde está implementada y qué la prueba. El enunciado no está en el repo, así que cada regla se transcribe resumida. Las decisiones sobre sus ambigüedades están numeradas en [DESIGN](ai/DESIGN.md#decisiones-sobre-ambigüedades-del-enunciado).

**Resultado:** cada regla tiene implementación y al menos un test que falla si se rompe. Una diferencia deliberada desde la fase 13: los fondos se mueven en dos pasos. La resolución los asigna a quien corresponde y esa parte los retira con `withdraw` (decisión 15). Así, un token que cobra la comisión aparte no puede llevarse el respaldo de otros escrows.

Los tests del contrato están en [`contracts/test/`](../contracts/test/) y los de la API en [`api/test/`](../api/test/).

## Contrato: reglas por acción

Las ventanas se cuentan desde la creación. Cada límite se prueba un segundo antes, en el segundo exacto y un segundo después ([`EscrowTimeWindows.t.sol`](../contracts/test/EscrowTimeWindows.t.sol)), y además con tiempos al azar en [`EscrowFuzz.t.sol`](../contracts/test/EscrowFuzz.t.sol).

### Crear escrow

**Regla:** el enviador, siempre. Transfiere `amount` del token al contrato y el escrow queda `Pending`.

| Aspecto | Implementación | Tests |
| --- | --- | --- |
| Quién | Cualquier cuenta; `msg.sender` queda como sender | `test_Create_StoresPendingEscrow` |
| Cuándo | Sin restricción de tiempo | `testFuzz_Create_RecordsAmountAndDeadlines`, con timestamps al azar |
| Resultado | `safeTransferFrom(msg.sender, this, amount)`, estado `Pending` y evento `EscrowCreated`. Con tokens con fee se registra lo recibido (decisión 7) | `test_Create_LocksTokensInEscrow`, `test_Create_EmitsEscrowCreated`, `test_FeeToken_RecordsAmountReceived` |

### Cancelar

**Regla:** el enviador, antes de creación + 2 h. Los fondos vuelven al enviador y el estado pasa a `CancelledBySender`.

| Aspecto | Implementación | Tests |
| --- | --- | --- |
| Quién | `msg.sender != sender` → `NotSender` | `test_RevertWhen_CancelIsNotCalledBySender` |
| Cuándo | `block.timestamp >= createdAt + CANCEL_WINDOW` → `CancelWindowClosed` | `test_Cancel_SucceedsInCreationBlock`, `test_Cancel_SucceedsOneSecondBeforeCancelDeadline`, `test_RevertWhen_CancelAtCancelDeadline`, `test_RevertWhen_CancelOneSecondAfterCancelDeadline`, `test_RevertWhen_CancelAfterExpiration`, `testFuzz_Cancel_OnlyBeforeCancelDeadline` |
| Resultado | Estado `CancelledBySender` y evento `EscrowCancelled`. El saldo queda asignado al sender, que lo retira con `withdraw` | `test_Cancel_AssignsFundsToSender`, `test_Withdraw_PaysTheHolderOfEachFinalStatus` |

### Confirmar

**Regla:** el beneficiario, antes de creación + 7 días. Los fondos van al beneficiario y el estado pasa a `Released`.

| Aspecto | Implementación | Tests |
| --- | --- | --- |
| Quién | `msg.sender != beneficiary` → `NotBeneficiary` | `test_RevertWhen_ConfirmIsNotCalledByBeneficiary` |
| Cuándo | `block.timestamp >= createdAt + TTL` → `EscrowHasExpired`. Vale también dentro de las primeras 2 h (decisión 3) | `test_Confirm_SucceedsInCreationBlock`, `test_Confirm_SucceedsAfterCancelWindow`, `test_Confirm_SucceedsOneSecondBeforeExpiration`, `test_RevertWhen_ConfirmAtExpiration`, `test_RevertWhen_ConfirmOneSecondAfterExpiration`, `testFuzz_Confirm_OnlyBeforeExpiration` |
| Resultado | Estado `Released` y evento `EscrowReleased`. El saldo queda asignado al beneficiary, que lo retira con `withdraw` | `test_Confirm_AssignsFundsToBeneficiary`, `test_Withdraw_PaysTheHolderOfEachFinalStatus` |

### Rechazar

**Regla:** el beneficiario, antes de creación + 7 días. Los fondos vuelven al enviador y el estado pasa a `Rejected`.

| Aspecto | Implementación | Tests |
| --- | --- | --- |
| Quién | `msg.sender != beneficiary` → `NotBeneficiary` | `test_RevertWhen_RejectIsNotCalledByBeneficiary` |
| Cuándo | `block.timestamp >= createdAt + TTL` → `EscrowHasExpired` | `test_Reject_SucceedsInCreationBlock`, `test_Reject_SucceedsAfterCancelWindow`, `test_Reject_SucceedsOneSecondBeforeExpiration`, `test_RevertWhen_RejectAtExpiration`, `test_RevertWhen_RejectOneSecondAfterExpiration`, `testFuzz_Reject_OnlyBeforeExpiration` |
| Resultado | Estado `Rejected` y evento `EscrowRejected`. El saldo queda asignado al sender, que lo retira con `withdraw` | `test_Reject_AssignsFundsToSender`, `test_Withdraw_PaysTheHolderOfEachFinalStatus` |

### Recuperar por vencimiento

**Regla:** el enviador, desde creación + 7 días. Los fondos vuelven al enviador y el estado pasa a `Expired`.

| Aspecto | Implementación | Tests |
| --- | --- | --- |
| Quién | `msg.sender != sender` → `NotSender` | `test_RevertWhen_RecoverExpiredIsNotCalledBySender` |
| Cuándo | `block.timestamp < createdAt + TTL` → `NotExpiredYet`, sin límite posterior | `test_RevertWhen_RecoverInCreationBlock`, `test_RevertWhen_RecoverOneSecondBeforeExpiration`, `test_RecoverExpired_SucceedsAtExpiration`, `test_RecoverExpired_SucceedsOneSecondAfterExpiration`, `test_RecoverExpired_SucceedsLongAfterExpiration`, `testFuzz_RecoverExpired_OnlyFromExpiration` |
| Resultado | Estado `Expired` y evento `EscrowExpired`. El saldo queda asignado al sender, que lo retira con `withdraw` | `test_RecoverExpired_AssignsFundsToSender`, `test_Withdraw_PaysTheHolderOfEachFinalStatus` |

### Retirar

**No está en la tabla del enunciado:** es el segundo paso de "los fondos van" o "vuelven" (decisión 15). El titular de un escrow resuelto, el beneficiary si `Released` y el sender si no, retira su saldo, en una o más veces.

| Aspecto | Implementación | Tests |
| --- | --- | --- |
| Quién | `msg.sender !=` titular → `NotHolder` | `test_RevertWhen_WithdrawIsNotCalledByHolder`, `testFuzz_RevertWhen_CallerIsNotTheHolder` |
| Cuándo | Cualquier momento después de resolver; mientras `Pending` → `NotResolved` | `test_RevertWhen_WithdrawingFromPendingEscrow` |
| Cuánto | `0 < transferAmount <= amount − withdrawn`, si no `ZeroAmount` o `AmountExceedsBalance`. Lo que sale del contrato, comisión incluida, no puede superar el saldo (`ExcessiveDebit`), y el titular tiene que recibir al menos `minReceived` (`ReceivedBelowMinimum`) | `test_Withdraw_InSeveralParts`, `test_RevertWhen_WithdrawingMoreThanBalance`, `test_FeeOnTopToken_CannotConsumeOtherEscrowsBacking`, `test_RevertWhen_ReceivedBelowMinimum` |
| Resultado | Transfiere al titular, suma lo debitado a `withdrawn` y emite `EscrowWithdrawn`. El estado no cambia | `test_Withdraw_PaysTheHolderOfEachFinalStatus`, `testFuzz_Withdraw_PaysRecordedAmountToTheHolder` |

## Contrato: reglas generales

| Regla | Implementación | Tests |
| --- | --- | --- |
| Una vez resuelto, un escrow no puede volver a tocarse | `_loadPending`: cualquier estado distinto de `Pending` → `NotPending`. Solo se puede retirar el saldo, y retirar no cambia el estado | `test_RevertWhen_ActingOnResolvedEscrow` (4 estados finales × 4 acciones, antes y después de retirar), `invariant_EveryEscrowMatchesModel` |
| Una acción fuera de su ventana o de la parte equivocada revierte con un error claro, con custom errors | Un custom error por causa, con el id y el dato que falló (tabla en [DESIGN](ai/DESIGN.md#custom-errors)) | Cada test de revert compara el error exacto con sus argumentos; el handler de invariantes predice el error de cada llamada y lo compara byte a byte |
| Todo escrow termina en uno de cuatro estados finales, y solo `Released` entrega los fondos al beneficiario | El titular sale del estado: solo con `Released` es el beneficiary | `test_Withdraw_PaysTheHolderOfEachFinalStatus`, `testFuzz_Withdraw_PaysRecordedAmountToTheHolder`, `test_Resolve_DoesNotAffectOtherEscrows` |
| Ventana de 2 h y TTL de 7 días, constantes o `immutable` | `immutable`, fijadas en el constructor con `0 < cancelWindow < ttl` | `test_Constructor_SetsWindows`, `test_RevertWhen_CancelWindowIsZero`, `test_RevertWhen_CancelWindowEqualsTtl`, `test_RevertWhen_CancelWindowExceedsTtl`, `testFuzz_Constructor_AcceptsOnlyValidWindows` |
| Vencido el TTL, el enviador recupera y la operación queda cancelada | El estado es `Expired` (decisiones 4 y 5) | Ver *Recuperar por vencimiento* |

## Contrato: requisitos

| Requisito | Implementación | Tests |
| --- | --- | --- |
| El token se indica al crear cada escrow, cualquier ERC-20 | Parámetro `token` de `createEscrow` | `test_NoReturnToken_SupportsFullLifecycle`, y el handler, que alterna cuatro tokens |
| Funciona con tokens que no devuelven `bool` en `transfer` | `SafeERC20` | `test_NoReturnToken_SupportsFullLifecycle` |
| Monto mayor a cero | `ZeroAmount` | `test_RevertWhen_AmountIsZero` |
| Beneficiario distinto de `address(0)` y del enviador | `InvalidBeneficiary` | `test_RevertWhen_BeneficiaryIsZeroAddress`, `test_RevertWhen_BeneficiaryIsSender` |
| Nadie más, ni siquiera el owner, mueve fondos de un escrow | No hay owner. Los fondos solo salen por `withdraw`, hacia el titular (ver [seguridad](security.md#6-sin-owner)) | Los tests de acceso incluyen al deployer; `testFuzz_RevertWhen_CallerIsNotTheParty`, `testFuzz_RevertWhen_CallerIsNotTheHolder` |
| Un evento por cada cambio de estado, con datos para reconstruir el escrow sin leer el storage. Como mínimo `EscrowCreated(id, sender, beneficiary, token, amount, cancelDeadline, expiresAt)` y los cuatro de resolución | `EscrowCreated` con esa firma exacta y `EscrowCancelled`, `EscrowReleased`, `EscrowRejected` y `EscrowExpired` con el `id` (decisión 16). Cada retiro emite `EscrowWithdrawn` con lo debitado y lo recibido | `test_Create_EmitsEscrowCreated` y un `expectEmit` en cada resolución y en los retiros. Los tests de integración de la API reconstruyen cada escrow solo desde los logs y lo comparan con `getEscrow` |
| Una función de lectura que devuelva un escrow por `id` | `getEscrow`, que revierte con `EscrowNotFound` si no existe (decisión 11) | `test_Create_StoresPendingEscrow`, `test_Resolve_KeepsEscrowDataReadable`, `test_RevertWhen_GettingEscrowIdZero`, `test_RevertWhen_GettingEscrowNotCreatedYet` |
| Tests de cada transición, cada revert y los límites justo antes y justo después de las 2 h y de los 7 días | 99 tests: unitarios, fuzz e invariantes. 100 % de cobertura en `Escrow.sol` | Las tablas de arriba |

## API e indexador

| Requisito | Implementación | Tests |
| --- | --- | --- |
| Suscribirse a los eventos del contrato y persistirlos | Polling con `eth_getLogs` y checkpoint en Postgres (decisión 18) | `indexer.test.ts`: "projects the four paths and an escrow left Pending, as the contract has them" |
| Idempotente: el mismo evento dos veces no duplica ni corrompe | Clave `(tx_hash, log_index)` con `ON CONFLICT DO NOTHING`, y un proyector puro con guardas | `projector.test.ts`: "the same event twice is a no-op"; `indexer.test.ts`: "leaves the database identical when an indexed range is processed again" |
| Retomar desde el último bloque procesado sin perder eventos | Checkpoint en la misma transacción que los eventos | `indexer.test.ts`: "resumes after being killed, without losing or duplicating events" (SIGKILL real) y "a batch that fails midway" |
| Explicar cómo se tratan los reorgs | N confirmaciones: `CONFIRMATIONS` (decisión 19, y [Reorgs](ai/DESIGN.md#indexador) en DESIGN) | `indexer.test.ts`: "does not index the last CONFIRMATIONS blocks" |
| `GET /escrows/:id`: estado, montos, partes, deadlines y hash de cada transacción | `createdTx`, `resolvedTx` y el `txHash` de cada retiro; `amount`, `withdrawn`, `withdrawable` y lo debitado y recibido en cada retiro; más el estado efectivo y los flags | `http.test.ts`: "returns the escrow with its derived state"; `indexer.test.ts`: "projects what each withdrawal took from the escrow and what the holder got, apart" |
| `GET /escrows?sender=&beneficiary=&status=`: lista paginada con filtros | `limit`/`offset`, filtros combinables, vacío cuenta como ausente | `http.test.ts`: los tests de `GET /escrows` |
| `GET /health`: estado del servicio y último bloque indexado | DB, RPC, `lastIndexedBlock`, `chainHead` y `lag` | `http.test.ts`: los tests de `GET /health` y de dependencias caídas |
| Un `Pending` con el TTL vencido se informa como vencido y recuperable, aunque nadie haya llamado al contrato | `ExpiredRecoverable`, con el reloj de la cadena (decisiones 6 y 17) | `expiry.test.ts`: "turns a Pending escrow ExpiredRecoverable after evm_increaseTime, with no transaction" y "follows the deadlines to the second" |
| Indicar si el enviador todavía puede cancelar | `canCancel`, más `canConfirm`, `canReject` y `canRecover` | `http.test.ts`: "derives the actions a Pending escrow admits"; `view.test.ts` |

## Entregables

| Entregable | Dónde |
| --- | --- |
| Código del contrato y sus tests | [`contracts/`](../contracts/) |
| Código de la API y sus tests, al menos del procesamiento de eventos | [`api/`](../api/), con 142 tests: unitarios del proyector e integración contra Anvil y Postgres |
| Un comando o `docker-compose` que levante nodo, deploy, base de datos y API | `docker compose up --build` ([README](../README.md#levantar-el-stack)) |
| Un script con el flujo completo: crear, confirmar, rechazar, cancelar y vencer avanzando el tiempo del nodo | `docker compose run --rm demo`, con el retiro después de cada resolución ([README](../README.md#demo-de-punta-a-punta)) |
| README con cómo correrlo, decisiones de diseño, supuestos y qué se mejoraría | [README](../README.md#decisiones-de-diseño), con el desarrollo en [DESIGN](ai/DESIGN.md) |
| Ejemplos de `curl` para probar los endpoints | [README](../README.md#ejemplos-http) |
| Historial de commits que muestre el avance | `git log`: un commit por paso lógico |
| Outputs de prompts de IA | [`docs/ai/README.md`](ai/README.md) |
| Opcional: deploy en una testnet | Sepolia y Monad testnet, ver [README](../README.md#sepolia) |
