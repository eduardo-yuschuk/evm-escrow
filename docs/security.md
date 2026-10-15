# Revisión de seguridad

Revisión de [`contracts/src/Escrow.sol`](../contracts/src/Escrow.sol) contra el checklist de la fase 12 del [ROADMAP](ai/ROADMAP.md) y los criterios de seguridad del enunciado: reentrancy, checks-effects-interactions, control de acceso, tokens no estándar y ninguna forma de bloquear o robar fondos. Cada punto cita su evidencia: el código, los tests o los invariantes.

**Resultado:** ningún hallazgo obliga a cambiar el contrato. La revisión encontró dos limitaciones nuevas, las dos causadas por el token y no por el contrato. Quedaron fijadas con tests y documentadas en [DESIGN](ai/DESIGN.md#limitaciones-conocidas). Ver [Hallazgos de esta revisión](#hallazgos-de-esta-revisión).

## Superficie

- **Funciones que cambian estado:** `createEscrow`, `cancel`, `confirm`, `reject` y `recoverExpired`, las cinco `external nonReentrant`.
- **Lectura:** `getEscrow`, `escrowCount`, `CANCEL_WINDOW` y `TTL`.
- **Llamadas externas:** solo al token de cada escrow: `balanceOf`, y `transferFrom` y `transfer` a través de `SafeERC20`.
- **Lo que no tiene:** owner, roles, proxy, `payable`, `receive`, `fallback`, `delegatecall`, `selfdestruct` ni assembly propio.
- **Compilador:** pragma fijo `0.8.37`, con aritmética chequeada.

## 1. Reentrancy y CEI

- **Resoluciones:** chequeos, estado final, evento y recién al final `safeTransfer`. Una reentrada durante el pago encuentra el escrow resuelto y revierte con `NotPending`, aun sin el guard.
- **`createEscrow` es la única excepción a CEI:** transfiere antes de escribir el escrow, para medir lo recibido. Sin guard, un token con hooks podría reentrar `createEscrow` durante el depósito y contar dos veces el mismo ingreso. `nonReentrant` lo impide.
- **Entre funciones:** el guard es uno solo para las cinco, así que tampoco se puede reentrar en otra función.
- **Reentrada de solo lectura:** durante un pago, `getEscrow` ya devuelve el estado final. Durante un depósito, el escrow nuevo todavía no existe y `escrowCount` no cambió. Ninguna lectura ve un estado intermedio.
- **Evidencia:**
  - `test_RevertWhen_SenderHookReentersCreateDuringDeposit`: el ataque de doble conteo con un contrato atacante, al estilo ERC-777. Sin el guard registraría 3 × `AMOUNT` por 2 × `AMOUNT` depositados.
  - `test_RevertWhen_TokenReentersDuringPayout`: reentrada durante el pago, en las cuatro resoluciones.
  - Mutaciones de la fase 2: sin el guard en `createEscrow`, el test falla; sin el guard en `confirm`, la reentrada igual falla por CEI.
- **Slither no ve estas llamadas,** porque `SafeERC20` las hace en assembly: el detalle está en [`slither.md`](slither.md#lo-que-slither-no-ve-reentrada-a-través-de-safeerc20).

## 2. Control de acceso por acción

| Acción | Quién | Chequeo | A quién paga |
| --- | --- | --- | --- |
| `createEscrow` | Cualquiera, con sus propios tokens | `safeTransferFrom(msg.sender, …)` | — |
| `cancel` | Sender | `msg.sender == sender`, si no `NotSender` | Sender |
| `confirm` | Beneficiary | `msg.sender == beneficiary`, si no `NotBeneficiary` | Beneficiary |
| `reject` | Beneficiary | `msg.sender == beneficiary`, si no `NotBeneficiary` | Sender |
| `recoverExpired` | Sender | `msg.sender == sender`, si no `NotSender` | Sender |

- **Nadie gasta el allowance de otro:** `createEscrow` no recibe un `from`, siempre toma de quien llama.
- **Destinos fijos:** cada resolución paga a una dirección guardada al crear, nunca a una que elija quien llama.
- **Orden de los chequeos:** existencia y estado, después quién llama y por último el tiempo. Un tercero recibe `NotSender` o `NotBeneficiary` en cualquier momento.
- **Evidencia:**
  - `test_RevertWhen_CancelIsNotCalledBySender` y los tres equivalentes, con el beneficiary, un tercero y el deployer
  - `testFuzz_RevertWhen_CallerIsNotTheParty`: cualquier dirección, cualquier acción y cualquier momento
  - el handler de invariantes, que llama desde actores al azar y compara el error exacto con su modelo

## 3. Tokens no estándar

| Token | Comportamiento | Evidencia |
| --- | --- | --- |
| Sin `bool` en `transfer` (USDT) | Funciona: `SafeERC20` acepta el retorno vacío | `test_NoReturnToken_SupportsFullLifecycle`; el handler usa uno |
| Devuelve `false` | Revierte con `SafeERC20FailedOperation` | `test_RevertWhen_TokenReturnsFalse` |
| Dirección sin código o `address(0)` | Revierte con `InvalidToken` antes de llamarla | `test_RevertWhen_TokenHasNoCode`, `test_RevertWhen_TokenIsZeroAddress` |
| Fee descontada del monto | Registra lo recibido, y cada escrow paga exactamente eso | `testFuzz_FeeToken_RecordsAndPaysOutAmountReceived`, `test_FeeToken_DoesNotDrainOtherEscrows`; el handler usa uno con fee del 1 % |
| Fee del 100 % | Revierte con `NothingReceived` | `test_RevertWhen_FeeTokenDeliversNothing` |
| Revierte con monto cero | Nunca pasa: `amount > 0` al crear y `received > 0` al pagar | Código |
| Con hooks (ERC-777) | `nonReentrant` y CEI | Ver [punto 1](#1-reentrancy-y-cei) |
| Blacklist del sender o del beneficiary (USDC, USDT) | **Limitación conocida:** con el sender bloqueado, los fondos quedan trabados hasta que el token lo desbloquee. Con el beneficiary bloqueado, igual puede rechazar | `test_KnownLimitation_BlacklistedSenderLocksFunds`, `test_KnownLimitation_BlacklistedBeneficiaryCanStillReject` |
| Blacklist del propio contrato | **Limitación nueva:** congela todos los escrows de ese token, hasta que el token lo desbloquee | `test_KnownLimitation_BlacklistedEscrowFreezesItsTokenEscrows` |
| Pausable | Como la blacklist del contrato: nada se mueve hasta que se reanude | Mismo test |
| Debita al que paga más que el monto (fee cobrada aparte) | **Limitación nueva:** cada pago saca de más y los últimos escrows del token quedan cortos | `test_KnownLimitation_FeeOnTopTokenUnderfundsLaterEscrows` |
| Rebasing | No soportado. El negativo tiene el mismo efecto que el caso anterior; el positivo deja un excedente trabado | Documentado |

**Aislamiento por token.** Un escrow solo paga en su propio token y nunca más que su `amount`. Un token malicioso, roto o con un admin que congela o quema saldos afecta solo a los escrows de ese token, nunca a los fondos de otros tokens del contrato. El riesgo de un token lo asume quien lo elige. Una whitelist lo acotaría, a cambio de un owner: está evaluada en la decisión 9 de [DESIGN](ai/DESIGN.md#decisiones-sobre-ambigüedades-del-enunciado).

## 4. Ninguna ruta para robar fondos

- **Los fondos salen solo por las cuatro resoluciones.** Cada una tiene efecto una sola vez, porque el estado queda final antes de transferir, y mueve exactamente el `amount` del escrow.
- **`amount` es lo que entró,** medido por diferencia de balance. Un escrow no puede pagar más de lo que aportó, ni siquiera con fee-on-transfer.
- **Ids secuenciales asignados por el contrato:** no hay ids elegidos por quien llama que se puedan ocupar o pisar.
- **Donaciones:** tokens enviados directo al contrato no se pagan nunca y quedan trabados. No hay `rescue`, porque necesitaría un owner que distinga una donación de un depósito.
- **Evidencia, en los invariantes con modelo de referencia** ([`EscrowInvariants.t.sol`](../contracts/test/invariant/EscrowInvariants.t.sol)):
  - `invariant_NeverPaysOutMoreThanDeposited`
  - `invariant_BalanceMatchesAccounting`: contabilidad exacta con donaciones, `balance == depositado − pagado + donado`
  - `invariant_HoldsEnoughForPendingEscrows`
  - `invariant_EveryEscrowMatchesModel`: un estado final no cambia nunca

## 5. Ninguna ruta para bloquear fondos

- **Un escrow pendiente siempre tiene salida.** Antes de `expiresAt`, el beneficiary puede confirmar o rechazar; desde `expiresAt`, el sender puede recuperar, sin límite de tiempo. Las ventanas no dejan huecos (decisión 1): `confirm` y `reject` valen hasta `expiresAt − 1` y `recoverExpired` desde `expiresAt`.
- **Nada administrativo:** no hay funciones que pausen, congelen o cambien parámetros.
- **Sin loops:** el gas de cada acción no depende de cuántos escrows haya.
- **Sin overflow en las resoluciones.** `createdAt + CANCEL_WINDOW` y `createdAt + TTL` ya se calculan al crear, para el evento. Si un `TTL` absurdo desbordara, revertiría la creación. Si la creación pasó, las mismas sumas no pueden desbordar después.
- **Una parte no puede trabar a la otra.**
  - Si el beneficiary no puede recibir (un hook que revierte, por ejemplo), puede rechazar, y si no hace nada, el sender recupera al vencer.
  - Si el que no puede recibir es el sender, el beneficiary igual puede confirmar.
  - En los dos casos, el único perjudicado es el que no puede recibir.
- **Un beneficiary que no puede actuar,** por ejemplo la dirección del propio contrato o un contrato sin esas llamadas, se resuelve con el TTL: el sender recupera los fondos. No se valida `beneficiary != address(this)`, porque es un caso más de beneficiary que nunca responde. Se verificó con un test descartable.
- **Excepciones:** las tres son del token y están en el [punto 3](#3-tokens-no-estándar): blacklist o pausa que alcanzan al sender o al contrato, y tokens que debitan de más.

## 6. Sin owner

- **No hay owner ni roles.** El deployer no conserva ningún privilegio después del constructor: los tests de acceso lo incluyen entre los que llaman.
- **Inmutable:** sin proxy, sin upgrade y sin `selfdestruct`. Las ventanas son `immutable` y el constructor exige `0 < cancelWindow < ttl` (`testFuzz_Constructor_AcceptsOnlyValidWindows`).
- Cumple "nadie más, ni siquiera el owner, puede mover fondos" sin depender de la buena fe de nadie.
- **Owner limitado a la creación** (pausar nuevos escrows y whitelist de tokens): evaluado y dejado como mejora, ver la decisión 9 de [DESIGN](ai/DESIGN.md#decisiones-sobre-ambigüedades-del-enunciado).

## 7. Timestamps en `uint64`

- **Truncamiento:** `uint64(block.timestamp)` recién truncaría después de 2⁶⁴ segundos, unos 584 mil millones de años. Es irrelevante en la práctica; el cast está anotado con su justificación.
- **Manipulación:** el productor del bloque puede mover `block.timestamp` unos segundos, lo que no importa con ventanas de horas y días. Los límites se testean al segundo.

## 8. Orden de transacciones

- **Carrera entre 0 y 2 h.** El sender puede cancelar y el beneficiary confirmar a la vez, y gana la primera transacción minada. El contrato garantiza que solo una tenga efecto, no cuál. Es la tabla del enunciado (decisión 3).
- **Nada más que adelantar:** no hay precios, oráculos, firmas ni `permit`.

## Hallazgos de esta revisión

| # | Hallazgo | Decisión | Evidencia |
| --- | --- | --- | --- |
| 1 | Si el token bloquea al propio contrato, todos los escrows de ese token quedan congelados | Aceptado como limitación: es el mismo caso que la blacklist del sender, a nivel de contrato | `test_KnownLimitation_BlacklistedEscrowFreezesItsTokenEscrows` |
| 2 | Un token que debita al que paga más que el monto (fee cobrada aparte, rebasing negativo, quema administrativa) hace que los últimos escrows de ese token queden cortos | Aceptado como limitación (ver abajo) | `test_KnownLimitation_FeeOnTopTokenUnderfundsLaterEscrows` |
| 3 | Un beneficiary que no puede actuar, incluida la dirección del propio contrato | Sin cambios: el TTL lo resuelve | Test descartable |

**Por qué el hallazgo 2 no se corrige en el contrato.** Medir el balance en cada pago y revertir si sale más de lo registrado cambiaría un escrow corto al final por un escrow trabado ahora, sin devolverle nada a nadie. Pagar el mínimo entre lo registrado y lo disponible solo movería la pérdida a otro escrow. La defensa real es no aceptar esos tokens, que es lo que haría la whitelist.
