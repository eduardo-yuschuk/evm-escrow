# Propuesta: listar escrows por address en el contrato

**Estado:** propuesta, sin implementar.

## Motivación

Hoy el contrato solo expone `getEscrow(id)`. Para listar los escrows de una address hace falta la API, que indexa los eventos. La propuesta agrega dos vistas que devuelven los ids de los escrows donde una address es sender o beneficiary, con filtro por estado y la opción "todos". Así un frontend puede listar sin depender del indexador.

## Costo

**Es razonable si no se agregan slots por escrow.** El 63 % del gas de `createEscrow` (141.000) son los 4 slots nuevos, a 22.100 cada uno ([gas.md](../../gas.md)). Por eso las dos opciones cuestan tan distinto:

| Opción | Extra en `createEscrow`, estado estable | Resoluciones |
| --- | ---: | --- |
| Un `uint256[]` por address y rol | ~+54.000 (+38 %): 2 slots nuevos más los largos de los arrays | sin cambios |
| **Lista enlazada en el espacio libre de los slots que ya existen** | **~+10.000 a +11.000 (~+7,5 %)** | sin cambios |

Los números son estimados y se confirman con el benchmark al implementar.

La lista enlazada funciona así:
- Los slots 1 (`beneficiary`, 20 B) y 2 (`token`, 20 B) tienen 12 B libres cada uno. Ahí van `prevOfBeneficiary` y `prevOfSender` (`uint64`), el id del escrow anterior de la misma address en ese rol. Ese slot ya pasa de cero a no-cero, así que el campo empaquetado cuesta ~100 de gas.
- Se agrega un slot por address, con la cabeza de cada lista: `struct Party { uint64 lastSent; uint64 lastReceived; }`.
- En estado estable, `createEscrow` escribe 2 slots de `Party` que ya tenían valor (sender y beneficiary), a ~5.000 cada uno: lectura en frío más escritura de no-cero a no-cero. La primera vez que aparece una address se pagan +17.100 extra por ese slot, igual que hoy con el saldo de un token.

## Decisiones del autor

- **El filtro usa el estado guardado,** igual que `getEscrow`. `Status.None` significa "todos": es el valor cero y ningún escrow existente lo tiene. Un escrow vencido que nadie recuperó sigue apareciendo como `Pending`, y el cliente lo distingue con `expiresAt`. Filtrar por el estado efectivo (`ExpiredRecoverable`, como la API) pedía un enum de filtro aparte en el ABI.
- **La address se pasa solo por parámetro,** sin overloads que usen `msg.sender`. En un `eth_call`, `msg.sender` es el `from` que elige quien llama, así que el overload no agrega nada y complica el ABI para ethers.
- **`limit` acota los escrows recorridos, no los resultados.** Así el costo de cada `eth_call` queda acotado aunque el filtro coincida con pocos escrows de un historial largo. Una página puede traer menos de `limit` ids, o ninguno, y el cliente sigue con `nextCursor` hasta que valga 0.
- **El nombre es `getBeneficiaryEscrows`** y no `getReceiverEscrows`, porque el contrato usa "beneficiary" en todos lados.

## Interfaz ([IEscrow.sol](../../../contracts/src/IEscrow.sol))

```solidity
/// Recorre hasta `limit` escrows de `sender`, del más nuevo al más viejo, empezando en `cursor`
/// (0 = el más nuevo). Devuelve los que tienen `status` (`None` = todos) y el id desde donde
/// seguir (0 = no hay más). Una página puede traer menos de `limit` ids, o ninguno.
function getSenderEscrows(address sender, Status status, uint256 cursor, uint256 limit)
    external view returns (uint256[] memory ids, uint256 nextCursor);

function getBeneficiaryEscrows(address beneficiary, Status status, uint256 cursor, uint256 limit)
    external view returns (uint256[] memory ids, uint256 nextCursor);
```

El orden, del más nuevo al más viejo, coincide con el del listado de la API (`ORDER BY id DESC`).

Errores nuevos:
- `InvalidCursor(uint256 cursor)`: el cursor no es un escrow de esa address en ese rol. Incluye un id que no existe.
- `ZeroLimit()`.

## Cambios en el contrato ([Escrow.sol](../../../contracts/src/Escrow.sol))

- **`EscrowData`:** `uint64 prevOfBeneficiary` después de `beneficiary` y `uint64 prevOfSender` después de `token`. Sigue ocupando 4 slots.
- **Storage nuevo:** `mapping(address account => Party) private _parties;`
- **`createEscrow`:** guarda `prevOfSender = _parties[msg.sender].lastSent` y `prevOfBeneficiary = _parties[beneficiary].lastReceived`, y después actualiza las dos cabezas con `id`. El cast a `uint64` lleva un comentario como el de `createdAt`: harían falta 2^64 escrows para que no entre.
- **Vistas:** las dos comparten un helper privado `_list(bool bySender, address account, Status status, uint256 cursor, uint256 limit)`.
  - Con `cursor == 0` arranca en la cabeza. Con otro valor, valida que `_escrows[cursor].sender == account` (o `beneficiary`); si no coincide, revierte con `InvalidCursor`.
  - Por cada escrow recorrido lee el slot 0 (`status`) y el slot del puntero `prev`: 2 `SLOAD`, unos ~5.000 de gas. Con `limit` 1.000, un `eth_call` gasta ~5M, debajo del tope habitual de 50M de los nodos.
  - Junta los ids en un array de tamaño `limit` y al final los copia a uno del tamaño justo, sin assembly.
- **Acciones:** `cancel`, `confirm`, `reject` y `recoverExpired` no cambian. Solo las vistas recorren, siempre acotadas por `limit`, así que la nota "Sin loops" de [security.md](../../security.md) sigue valiendo para las acciones.

## Tests

- **`EscrowQueries.t.sol`, nuevo,** sobre `EscrowTestBase`:
  - Listas vacías.
  - Orden del más nuevo al más viejo.
  - Roles separados: una address que es sender en unos escrows y beneficiary en otros.
  - Escrows de otras partes intercalados.
  - Filtro por cada `Status`, y `None` como "todos".
  - Paginación con cursor en varias páginas, y `limit` mayor que el total.
  - Una página sin coincidencias que igual devuelve `nextCursor`.
  - Reverts por `InvalidCursor` (id de otra address, id del otro rol, id inexistente) y por `ZeroLimit`.
- **Invariante** en [EscrowInvariants.t.sol](../../../contracts/test/invariant/EscrowInvariants.t.sol): para cada actor del handler, recorre las dos listas con `None` y compara contra el modelo fantasma. Tienen que tener el mismo conjunto de ids, en orden descendente.
- **Gas** en [EscrowGasTest](../../../contracts/test/EscrowGas.t.sol): suma el escenario `createEscrow (beneficiary nuevo)` y regenera los snapshots.

## Otros cambios

- **Docs:** actualizar [gas.md](../../gas.md) (tabla y la comparación de arriba, con números medidos) y [DESIGN.md](../DESIGN.md) (Interfaz, Storage y una decisión nueva). En [security.md](../../security.md), aclarar que solo las vistas recorren. Mencionar las vistas en el README.
- **API:** regenerar [contracts.ts](../../../api/src/generated/contracts.ts) con `forge build` y `npm run abi`. El código de la API no cambia.
- **Redeploy:** los contratos de Sepolia y Monad testnet son inmutables y no tendrían estas vistas. Volver a deployar es una decisión aparte.

## Verificación

1. `forge fmt --check` y `forge build`.
2. `forge test`, también con `FOUNDRY_PROFILE=ci`, que corre más fuzz y más invariantes.
3. `forge test --match-contract EscrowGasTest --gas-report`: confirmar que `createEscrow` sube ~10.000 y que las resoluciones no cambian. Después, `forge snapshot` y `forge snapshot --check`.
4. Slither, como en CI.
5. Los tests de integración de la API, con el ABI regenerado.
