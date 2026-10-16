# Consultar escrows por participante directamente al contrato

Es viable mantener un índice por participante con un costo adicional acotado por creación, independiente de cuántos escrows existan. Esto permitiría obtener los IDs directamente del contrato sin depender del indexador/API para ese listado. En el contrato actual, `receiver` se llama `beneficiary`; conviene conservar ese nombre para mantener consistencia.

## Índices por participante

La implementación más simple sería:

```solidity
mapping(address => uint256[]) private _sentIds;
mapping(address => uint256[]) private _receivedIds;
```

Al crear cada escrow:

```solidity
_sentIds[msg.sender].push(id);
_receivedIds[beneficiary].push(id);
```

Los IDs permanecen en esas listas cuando el escrow se resuelve. Así, cancelar, confirmar, rechazar y recuperar no necesitan mantener índices adicionales.

## Costo estimado

Con las reglas de Cancun usadas en los benchmarks del proyecto:

| Situación | Gas adicional por creación |
| --- | ---: |
| Ambas listas ya tienen elementos | ~54.000 |
| Primera entrada en ambas listas | ~88.000 |

Son estimaciones de storage más un pequeño overhead pendiente de medir: cada índice escribe un ID nuevo y actualiza su longitud. Frente a los 141.000 actuales en régimen estable, representa alrededor de un 38 % adicional cuando ambas listas ya existen. Las reglas de referencia son [EIP-2200](https://eips.ethereum.org/EIPS/eip-2200) y [EIP-2929](https://eips.ethereum.org/EIPS/eip-2929); el costo concreto depende de la red.

## Consultas paginadas

Una interfaz posible sería:

```solidity
function getReceivedEscrows(
    address account,
    StatusFilter filter,
    uint256 cursor,
    uint256 maxScanned
) external view returns (uint256[] memory ids, uint256 nextCursor);
```

Y una equivalente `getSentEscrows`. Se pueden agregar sobrecargas sin `account` que usen `msg.sender`; para frontends, la dirección explícita suele ser más cómoda porque no depende de configurar el `from` del `eth_call`.

### Filtro «todos»

Usaría un enum separado `StatusFilter` con `All`, sin alterar `Status.None`, que actualmente significa que el escrow no existe.

### Límite de elementos examinados

La consulta debería limitar cuántas posiciones examina, por ejemplo 100, y devolver las que coincidan con el filtro. Una página podría devolver cero resultados y aun así avanzar el cursor. Limitar solo la cantidad de resultados podría obligar a recorrer todo el historial buscando coincidencias.

La consulta mediante `eth_call` no paga una transacción, pero consume recursos del nodo y está sujeta a sus límites: por eso conviene paginar desde el principio.

### Estado vencido

Hoy el contrato mantiene `Pending` después del vencimiento hasta ejecutar `recoverExpired`. Para reproducir lo que muestra la API, el filtro necesitaría también `ExpiredRecoverable`, calculado con `block.timestamp`.

## Alternativas y recomendación

Para consultas directas al contrato, elegiría esos dos índices y filtrado durante la lectura. Mantener además listas por estado encarecería cada resolución y agregaría complejidad; empezaría con el filtro al leer.

Si solo los necesita el frontend, los eventos actuales ya indexan `sender` y `beneficiary`, y el indexador/API permite resolverlo sin aumentar el gas de creación.

Esta propuesta permite consultar los listados directamente al contrato; no implementa por sí sola todas las funciones que hoy ofrece el backend.
