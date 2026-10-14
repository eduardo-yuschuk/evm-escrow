# Gas

Todo lo que sigue está medido con solc 0.8.37, `evm_version = "cancun"` y optimizer de 200 runs, que es la configuración de `foundry.toml`.

## Cómo se mide

| Artefacto | Qué contiene | Cómo se regenera |
| --- | --- | --- |
| [`contracts/snapshots/EscrowGasTest.json`](../contracts/snapshots/EscrowGasTest.json) | Gas de cada operación, por escenario | Se reescribe en cada `docker compose run --rm forge test` |
| [`contracts/.gas-snapshot`](../contracts/.gas-snapshot) | Gas total de cada test, para detectar regresiones | `docker compose run --rm forge snapshot` |

Para verificar que nada cambió (lo que va a correr CI):

```bash
docker compose run --rm forge snapshot --check
docker compose run --rm -e FORGE_SNAPSHOT_CHECK=true forge test
```

- **Benchmark** ([`EscrowGasTest`](../contracts/test/EscrowGas.t.sol)): cada test arma un escenario y termina en la llamada que mide, con `vm.snapshotGasLastFrame`.
- **Los números son de transacción completa,** incluidos los 21.000 de gas intrínseco, el calldata y el acceso en frío a cuentas y slots.
- **Se verificaron contra una cadena real:** las mismas transacciones enviadas a Anvil dan exactamente el mismo `gasUsed` en el recibo.
- **Determinismo:** `forge snapshot` usa una semilla fija para el fuzz, así que `.gas-snapshot` sale idéntico en cada corrida, incluidas las entradas de fuzz e invariantes. Se comprobó corriéndolo dos veces y comparando.

## Gas por operación

Estado estable: el contrato ya tiene otros escrows del mismo token y quien recibe el pago ya tiene saldo del token, así que ningún balance pasa de cero a no-cero ni al revés.

| Operación | Gas | Notas |
| --- | ---: | --- |
| `createEscrow` | 141.000 | |
| `createEscrow`, primer escrow del contrato | 175.200 | +34.200: `escrowCount` y el saldo del token en el contrato pasan de 0 a no-cero (2 × 17.100) |
| `cancel` | 48.971 | |
| `confirm` | 51.026 | |
| `confirm`, beneficiary sin saldo previo del token | 68.126 | +17.100: el saldo del beneficiary pasa de 0 a no-cero, lo paga el token |
| `reject` | 50.998 | |
| `recoverExpired` | 49.018 | 44.218 en Anvil cuando era el último escrow: vaciar el saldo del contrato da un refund de 4.800 |
| Deploy de `Escrow` | 933.537 | Runtime de 4.063 B, initcode de 4.389 B |

`getEscrow` es una vista: se consulta con `eth_call` y no cuesta gas.

## Storage

El layout y su justificación están en el [DESIGN, sección Storage](ai/DESIGN.md#storage). Lo que agregan las mediciones:

- **Dónde se va el gas de `createEscrow`.** Escribe 4 slots nuevos, de cero a no-cero, a 22.100 cada uno: 88.400 de 141.000, el 63 %. Por eso la única palanca grande es la cantidad de slots, no las micro-optimizaciones de código.
- **Una sola escritura al resolver.** `status` comparte el slot 0 con `sender` y `createdAt`, así que cada resolución hace un único `SSTORE`, sobre un slot que ya leyó (2.900).
- **Deadlines derivados.** Guardados como `uint64` entrarían en el espacio libre de los slots 1 y 2 sin agregar slots, pero sumarían operaciones de empaquetado al escribir y leer, y dos fuentes de verdad para el mismo dato. Derivarlos de `createdAt` y de las `immutable` cuesta unas pocas sumas, porque leer una `immutable` no accede a storage.
- **`amount` como `uint96` (3 slots).** Medido abajo: ahorra 22.059 en `createEscrow` (−15,6 %). Se descartó por el límite de monto; ver [DESIGN](ai/DESIGN.md#storage).

## Micro-optimizaciones evaluadas

Cada variante se aplicó sobre una copia del contrato, se corrió el benchmark y se restauró el original. Diferencia de gas por transacción contra la versión actual (negativo = más barato):

| Variante | `createEscrow` | `cancel` | `confirm` | `reject` | `recoverExpired` | Runtime | Veredicto |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `amount uint96` junto a `beneficiary` (3 slots) | −22.059 | +35 | −2.074 | +35 | +35 | +89 B | Descartada: limita los montos a ~7,9e28 unidades |
| Borrar `beneficiary`, `token` y `amount` al resolver | 0 | −1.147 | −3.163 | — | — | +98 B | Descartada: `getEscrow` deja de devolver los datos de un escrow resuelto |
| `via_ir = true` | −983 | −755 | −563 | −569 | −761 | −848 B | Descartada por el autor: ahorro de 0,7 % a 1,6 % |
| `optimizer_runs` de 10.000 (igual con 1.000.000) | −465 | −247 | −269 | −269 | −247 | +1.573 B | Descartada: ahorro menor que `via_ir` y bytecode un 39 % más grande |
| Sin medir lo recibido (`amount` directo) | −1.956 | 0 | 0 | 0 | 0 | −296 B | Descartada: es el costo del soporte de fee-on-transfer (decisión 7) |
| Sin el chequeo `token.code.length` | −140 | 0 | 0 | 0 | 0 | −53 B | Descartada: da un error claro en lugar de un revert sin motivo |
| `unchecked { ++escrowCount }` | −52 | 0 | 0 | 0 | 0 | −30 B | Descartada por el autor: 0,04 % |

Notas sobre las variantes:
- **`uint96`:** `confirm` ahorra una lectura en frío porque `beneficiary` y `amount` quedan en el mismo slot. Las otras resoluciones pagan al `sender`, que está en el slot 0, así que no ahorran lecturas y suman 35 de enmascarado.
- **Borrar storage:** se midió en `cancel` y `confirm`. Con un beneficiary sin saldo previo, `confirm` ahorra 5.598. El refund de EIP-3529 tiene un tope del 20 % del gas de la transacción.
- **`via_ir`:** es la única variante que mejora todo: gas y tamaño. Pero el ahorro es menor al 2 %, cambia el pipeline del compilador con el que se revisó y testeó el contrato, y compila más lento. El autor decidió no aplicarla, junto con `unchecked`: no vale la pena.

**Ya aplicadas desde el diseño:**
- **`ReentrancyGuardTransient`:** ~1.900 a ~4.700 por llamada contra `ReentrancyGuard`. Ver la medición en [DESIGN](ai/DESIGN.md#guard-de-reentrada-reentrancyguardtransient).
- **Ventanas `immutable`:** se leen del bytecode, sin `SLOAD`.
- **Errores custom:** en lugar de strings.
- **Eventos de resolución solo con `id`:** menos datos de log en cada resolución.
