# Revisión de seguridad

Revisión de [`contracts/src/Escrow.sol`](../contracts/src/Escrow.sol) contra el checklist de la fase 12 del [ROADMAP](ai/ROADMAP.md) y los criterios de seguridad del enunciado: reentrancy, checks-effects-interactions, control de acceso, tokens no estándar y ninguna forma de bloquear o robar fondos. Cada punto cita su evidencia: el código, los tests o los invariantes.

**Resultado:** la revisión de la fase 12 no obligó a cambiar el contrato: encontró dos limitaciones nuevas, causadas por el token, que quedaron fijadas con tests. Una revisión posterior mostró que una de ellas sí era un defecto del contrato: un token que cobra la comisión aparte se llevaba el respaldo de otros escrows. En la fase 13 se corrigió con retiros pull que miden lo que sale del contrato. Ver [Hallazgos](#hallazgos).

Esta revisión describe el contrato actual, con retiros.

## Superficie

- **Funciones que cambian estado:** `createEscrow`, `cancel`, `confirm`, `reject`, `recoverExpired` y `withdraw`, las seis `external nonReentrant`.
- **Lectura:** `getEscrow`, `escrowCount`, `CANCEL_WINDOW` y `TTL`.
- **Llamadas externas:** solo al token de cada escrow, y solo desde `createEscrow` y `withdraw`: `balanceOf`, y `transferFrom` y `transfer` a través de `SafeERC20`. Las resoluciones no llaman a nadie.
- **Lo que no tiene:** owner, roles, proxy, `payable`, `receive`, `fallback`, `delegatecall`, `selfdestruct` ni assembly propio.
- **Compilador:** pragma fijo `0.8.37`, con aritmética chequeada.

## 1. Reentrancy y CEI

- **Resoluciones:** chequeos, estado final y evento. No hacen llamadas externas.
- **`createEscrow` y `withdraw` son las excepciones a CEI:** escriben después de transferir, porque guardan lo que midieron.
  - Sin guard, un token con hooks podría reentrar `createEscrow` durante el depósito y contar dos veces el mismo ingreso.
  - En `withdraw`, una reentrada a mitad de la transferencia haría que la medición de afuera incluya la de adentro, y el escrow quedaría cargado de más.
  - `nonReentrant` impide las dos.
- **Entre funciones:** el guard es uno solo para las seis, así que mientras corre una llamada al token no se ejecuta nada del contrato, tampoco una resolución.
- **Reentrada de solo lectura:** durante un retiro, `getEscrow` todavía devuelve el `withdrawn` anterior, pero el guard impide actuar en base a él dentro del contrato. Durante un depósito, el escrow nuevo todavía no existe y `escrowCount` no cambió.
- **Evidencia:**
  - `test_RevertWhen_SenderHookReentersCreateDuringDeposit`: el ataque de doble conteo con un contrato atacante, al estilo ERC-777. Sin el guard registraría 3 × `AMOUNT` por 2 × `AMOUNT` depositados.
  - `test_RevertWhen_TokenReentersDuringWithdraw`: durante el retiro, en los cuatro estados finales, el token intenta retirar otra vez del mismo escrow o rechazar otro pendiente.
  - Mutaciones: sin el guard en `createEscrow` (fase 2), en `withdraw` o en `reject` (fase 13), los tests fallan.
- **Slither no ve estas llamadas,** porque `SafeERC20` las hace en assembly: el detalle está en [`slither.md`](slither.md#lo-que-slither-no-ve-reentrada-a-través-de-safeerc20).

## 2. Control de acceso por acción

| Acción | Quién | Chequeo | Titular del saldo |
| --- | --- | --- | --- |
| `createEscrow` | Cualquiera, con sus propios tokens | `safeTransferFrom(msg.sender, …)` | — |
| `cancel` | Sender | `msg.sender == sender`, si no `NotSender` | Sender |
| `confirm` | Beneficiary | `msg.sender == beneficiary`, si no `NotBeneficiary` | Beneficiary |
| `reject` | Beneficiary | `msg.sender == beneficiary`, si no `NotBeneficiary` | Sender |
| `recoverExpired` | Sender | `msg.sender == sender`, si no `NotSender` | Sender |
| `withdraw` | El titular | `msg.sender ==` titular, si no `NotHolder` | Le paga al titular |

- **Nadie gasta el allowance de otro:** `createEscrow` no recibe un `from`, siempre toma de quien llama.
- **Destinos fijos:** `withdraw` paga al titular, una dirección guardada al crear, nunca a una que elija quien llama.
- **Orden de los chequeos:** existencia y estado, después quién llama, y por último el tiempo o los montos. Un tercero recibe `NotSender`, `NotBeneficiary` o `NotHolder` en cualquier momento.
- **Evidencia:**
  - `test_RevertWhen_CancelIsNotCalledBySender` y los tres equivalentes, con el beneficiary, un tercero y el deployer
  - `test_RevertWhen_WithdrawIsNotCalledByHolder`, en los cuatro estados finales, y `testFuzz_RevertWhen_CallerIsNotTheHolder`
  - `testFuzz_RevertWhen_CallerIsNotTheParty`: cualquier dirección, cualquier acción y cualquier momento
  - el handler de invariantes, que llama desde actores al azar y compara el error exacto con su modelo

## 3. Tokens no estándar

| Token | Comportamiento | Evidencia |
| --- | --- | --- |
| Sin `bool` en `transfer` (USDT) | Funciona: `SafeERC20` acepta el retorno vacío | `test_NoReturnToken_SupportsFullLifecycle`; el handler usa uno |
| Devuelve `false` | Revierte con `SafeERC20FailedOperation` | `test_RevertWhen_TokenReturnsFalse` |
| Dirección sin código o `address(0)` | Revierte con `InvalidToken` antes de llamarla | `test_RevertWhen_TokenHasNoCode`, `test_RevertWhen_TokenIsZeroAddress` |
| Fee descontada del monto | Registra lo recibido, y los retiros sacan del contrato exactamente eso. `minReceived` acota la fee de salida, que el token puede cambiar | `testFuzz_FeeToken_RecordsAndPaysOutAmountReceived`, `test_FeeToken_DoesNotDrainOtherEscrows`, `test_FeeToken_MinReceivedProtectsTheHolder`; el handler usa uno con fee del 1 % |
| Fee del 100 % | Revierte con `NothingReceived` al crear. Al retirar, revierte si `minReceived > 0` | `test_RevertWhen_FeeTokenDeliversNothing` |
| Fee cobrada aparte, al que paga | Un retiro que sacaría del contrato más que el saldo del escrow revierte con `ExcessiveDebit`, aunque el contrato tenga el respaldo de otros escrows o donaciones. El titular pide menos y recibe menos que lo depositado | `test_FeeOnTopToken_CannotConsumeOtherEscrowsBacking`, `test_FeeOnTopToken_DonationsDoNotPayTheFee`, `testFuzz_FeeOnTopToken_WithdrawNeverTakesMoreThanBalance`; el handler usa uno con fee del 1 % |
| Revierte con monto cero | Nunca pasa: `amount > 0` al crear y `transferAmount > 0` al retirar | Código, `test_RevertWhen_WithdrawingZero` |
| Con hooks (ERC-777) | `nonReentrant` en las seis funciones | Ver [punto 1](#1-reentrancy-y-cei) |
| Blacklist del sender o del beneficiary (USDC, USDT) | **Limitación conocida:** el escrow se resuelve igual, pero el titular bloqueado no puede retirar hasta que el token lo desbloquee | `test_KnownLimitation_BlacklistedSenderLocksFunds`, `test_KnownLimitation_BlacklistedBeneficiaryCannotWithdraw` |
| Blacklist del propio contrato | **Limitación conocida:** no se puede crear ni retirar ningún escrow de ese token hasta que lo desbloquee | `test_KnownLimitation_BlacklistedEscrowFreezesItsTokenEscrows` |
| Pausable | Como la blacklist del contrato: nada se mueve hasta que se reanude | Mismo test |
| Rebasing | No soportado. El negativo, o una quema administrativa, baja el balance fuera de cualquier transferencia: ninguna medición lo ve y los últimos escrows del token quedan cortos. El positivo deja un excedente trabado | Documentado |

**Aislamiento por token.** Un escrow solo paga en su propio token y nunca saca del contrato más que su `amount`, comisiones incluidas. Un token malicioso, roto o con un admin que congela o quema saldos afecta solo a los escrows de ese token, nunca a los fondos de otros tokens del contrato. El riesgo de un token lo asume quien lo elige. Una whitelist lo acotaría, a cambio de un owner: está evaluada en la decisión 9 de [DESIGN](ai/DESIGN.md#decisiones-sobre-ambigüedades-del-enunciado).

## 4. Ninguna ruta para robar fondos

- **Los fondos salen solo por `withdraw`,** del escrow resuelto y hacia su titular. Cada resolución tiene efecto una sola vez, y los retiros, todos juntos, nunca sacan del contrato más que el `amount` del escrow.
- **`amount` es lo que entró y `withdrawn` lo que salió,** los dos medidos por diferencia de balance. Un escrow no puede sacar más de lo que aportó, cobre el token la comisión descontada o aparte.
- **Ids secuenciales asignados por el contrato:** no hay ids elegidos por quien llama que se puedan ocupar o pisar.
- **Donaciones:** tokens enviados directo al contrato no se pagan nunca y quedan trabados. No hay `rescue`, porque necesitaría un owner que distinga una donación de un depósito.
- **Evidencia, en los invariantes con modelo de referencia** ([`EscrowInvariants.t.sol`](../contracts/test/invariant/EscrowInvariants.t.sol)):
  - `invariant_NeverPaysOutMoreThanDeposited`
  - `invariant_BalanceMatchesAccounting`: contabilidad exacta con donaciones, `balance == depositado − retirado + donado`
  - `invariant_HoldsEnoughForEveryEscrowBalance`: el contrato tiene al menos `Σ (amount − withdrawn)` de cada token, también con el token que cobra la comisión aparte
  - `invariant_EveryEscrowMatchesModel`: un estado final no cambia nunca, nada se retira mientras `Pending` y nunca más que `amount`

## 5. Ninguna ruta para bloquear fondos

- **Un escrow pendiente siempre tiene salida.** Antes de `expiresAt`, el beneficiary puede confirmar o rechazar; desde `expiresAt`, el sender puede recuperar, sin límite de tiempo. Las ventanas no dejan huecos (decisión 1): `confirm` y `reject` valen hasta `expiresAt − 1` y `recoverExpired` desde `expiresAt`.
- **Nada administrativo:** no hay funciones que pausen, congelen o cambien parámetros.
- **Sin loops:** el gas de cada acción no depende de cuántos escrows haya.
- **Sin overflow en las resoluciones.** `createdAt + CANCEL_WINDOW` y `createdAt + TTL` ya se calculan al crear, para el evento. Si un `TTL` absurdo desbordara, revertiría la creación. Si la creación pasó, las mismas sumas no pueden desbordar después.
- **Una parte no puede trabar a la otra.** Las resoluciones no mueven tokens, así que nada de lo que haga el token o el otro lado las impide. Si el titular no puede recibir (un hook que revierte, una blacklist), el único perjudicado es él: el escrow ya está resuelto y sus fondos esperan.
- **Un retiro siempre puede completarse por menos.** Si el token cobra una comisión aparte, el titular pide menos hasta que el monto más la comisión entren en el saldo: `test_FeeOnTopToken_CannotConsumeOtherEscrowsBacking`.
- **Un beneficiary que no puede actuar,** por ejemplo la dirección del propio contrato o un contrato sin esas llamadas, se resuelve con el TTL: el sender recupera los fondos. No se valida `beneficiary != address(this)`, porque es un caso más de beneficiary que nunca responde. Se verificó con un test descartable.
- **Excepciones:** son del token y están en el [punto 3](#3-tokens-no-estándar): blacklist o pausa que alcanzan al titular o al contrato, y balances que bajan fuera de una transferencia.

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
- **Nada más que adelantar:** no hay precios, oráculos, firmas ni `permit`. Un retiro solo lo puede hacer el titular, y una comisión que el token cambie justo antes la acota `minReceived`.

## Hallazgos

### Revisión de la fase 12

| # | Hallazgo | Decisión | Evidencia |
| --- | --- | --- | --- |
| 1 | Si el token bloquea al propio contrato, todos los escrows de ese token quedan congelados | Aceptado como limitación: es el mismo caso que la blacklist del sender, a nivel de contrato | `test_KnownLimitation_BlacklistedEscrowFreezesItsTokenEscrows` |
| 2 | Un token que debita al que paga más que el monto (fee cobrada aparte, rebasing negativo, quema administrativa) hace que los últimos escrows de ese token queden cortos | Aceptado como limitación en la fase 12. **Corregido en la fase 13** para la fee cobrada aparte (ver abajo) | Era `test_KnownLimitation_FeeOnTopTokenUnderfundsLaterEscrows` |
| 3 | Un beneficiary que no puede actuar, incluida la dirección del propio contrato | Sin cambios: el TTL lo resuelve | Test descartable |

La fase 12 no corrigió el hallazgo 2 con este argumento: medir el balance en cada pago y revertir si sale más de lo registrado cambiaría un escrow corto al final por un escrow trabado ahora. El argumento era incompleto: el escrow trabado no perjudica a nadie más, y un escrow corto sí. Faltaba darle al titular una forma de completar el pago por menos.

### Revisión posterior (fase 13)

Una revisión externa de los contratos marcó dos hallazgos de severidad media, los dos sobre tokens con comisión:

| Hallazgo | Corrección | Evidencia |
| --- | --- | --- |
| **Una comisión cobrada aparte consume el respaldo de otros escrows.** Medir lo recibido al crear no garantiza que una salida saque solo el monto del escrow: pagar 100 con una comisión aparte del 1 % saca 101 del contrato, y el 1 sale de otro escrow del mismo token | Retiros pull: resolver solo asigna el saldo, y `withdraw` mide lo que bajó el balance del contrato y revierte con `ExcessiveDebit` si supera el saldo del escrow. El titular pide menos para que la comisión entre en su propio saldo | `test_FeeOnTopToken_CannotConsumeOtherEscrowsBacking`, `test_FeeOnTopToken_DonationsDoNotPayTheFee`, `testFuzz_FeeOnTopToken_WithdrawNeverTakesMoreThanBalance` e `invariant_HoldsEnoughForEveryEscrowBalance`, con el token del handler. Sin el control, fallan |
| **No hay un mínimo de recepción.** La comisión de salida es del token y puede cambiar entre la creación y el pago, hasta el 100 %: el escrow quedaba `Released` con el beneficiary sin recibir nada | `minReceived` en `withdraw`: el titular fija cuánto acepta recibir, y `ReceivedBelowMinimum` revierte si recibe menos. Lo fija siempre quien cobra | `test_FeeToken_MinReceivedProtectsTheHolder`, `test_RevertWhen_ReceivedBelowMinimum` |

- **Lo que no cambió:** la creación sigue aceptando cualquier recepción positiva, sin `minReceived`. El autor lo consideró suficiente: el escrow registra lo que realmente entró.
- **Garantía y supuestos.** Las mediciones suponen que el token informa sus balances honestamente. No protegen contra un token arbitrariamente malicioso, ni contra balances que bajan fuera de una transferencia, como un rebasing negativo o una quema administrativa.
- **Las otras observaciones** de esa revisión ya estaban documentadas como limitaciones: destinatarios fijos con blacklist, el contrato como beneficiary y un TTL absurdo en el constructor.
