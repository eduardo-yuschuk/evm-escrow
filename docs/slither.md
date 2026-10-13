# Slither

Análisis estático de `contracts/src/` con Slither 0.11.6.

```bash
docker compose run --rm slither
```

**Resultado actual:** `. analyzed (9 contracts with 100 detectors), 0 result(s) found`, con exit code 0. Un hallazgo nuevo hace fallar el comando, así que CI puede usarlo tal cual.

## Configuración

**Imagen** ([`docker/slither.Dockerfile`](../docker/slither.Dockerfile)):
- **Base:** `python:3.12.14-slim-bookworm`.
- **`forge`:** se copia de la imagen de Foundry fijada (`v1.8.3`), porque crytic-compile compila invocando `forge build`. El binario necesita glibc 2.35, y Debian 12 trae la 2.36.
- **Dependencias de Python:** Slither y todas sus dependencias están fijadas con hashes en [`docker/slither.requirements.txt`](../docker/slither.requirements.txt), y se instalan con `--require-hashes`. Se resolvieron con `uv` limitando a versiones publicadas antes del 29/09/2026, con el mismo criterio que npm. El comando está en el encabezado del archivo.
- **solc 0.8.37:** se descarga en la imagen, así que analizar no necesita red.
- **Contexto de build:** el repo, filtrado por [`docker/slither.Dockerfile.dockerignore`](../docker/slither.Dockerfile.dockerignore) a los dos archivos que usa.

**Servicio** `slither` (perfil `tools`):
- **Código:** monta `./contracts` y reutiliza el entrypoint de `forge`, que baja al dueño del código e instala las dependencias de Soldeer si faltan.
- **Artefactos de compilación:** crytic-compile corre `forge clean` y `forge build --force`. Por eso `FOUNDRY_OUT` y `FOUNDRY_CACHE_PATH` apuntan a un directorio dentro del contenedor, y el `out/` y el `cache/` del servicio `forge` quedan intactos.

**Filtros** ([`contracts/slither.config.json`](../contracts/slither.config.json)):

| Filtro | Por qué |
| --- | --- |
| `filter_paths`: `dependencies/`, `test/`, `script/` | El alcance es el código del contrato. En OpenZeppelin y forge-std, Slither reporta 18 hallazgos informativos (`assembly`, `pragma`, `solc-version`) sobre código auditado de terceros. Los tests y los mocks tienen tokens maliciosos a propósito. |
| `detectors_to_exclude`: `timestamp` | Mismo criterio que `block-timestamp` en el lint de Foundry (punto 6 de la revisión). Ver el veredicto abajo. |
| `detectors_to_exclude`: `naming-convention` | Choca con `forge lint`, que exige `SCREAMING_SNAKE_CASE` para las `immutable` siguiendo la guía de estilo de Solidity. Los nombres los controla `forge lint`. |

## Hallazgos sin filtros y su veredicto

Primera corrida, sin exclusiones de detectores: 9 resultados de 3 detectores.

| Detector | Dónde | Veredicto |
| --- | --- | --- |
| `incorrect-equality` | `createEscrow`: `received == 0` | **Falso positivo.** Se desactiva en esa línea con `slither-disable-next-line` y un comentario. |
| `timestamp` (4) | Las comparaciones de ventana en `cancel`, `confirm`, `reject` y `recoverExpired` | **Aceptado,** excluido en la configuración. |
| `naming-convention` (4) | `CANCEL_WINDOW` y `TTL`, en `Escrow` y en `IEscrow` | **Aceptado,** excluido en la configuración. |

### `incorrect-equality`: `received == 0`

- **Qué busca el detector:** igualdades estrictas sobre valores que un atacante puede mover, como `balanceOf(this) == x`. Si alguien dona tokens, la igualdad deja de cumplirse y la lógica se rompe.
- **Por qué no aplica:** se compara contra cero lo recibido en esta llamada, y cero es justamente el caso a rechazar. Si una donación entrara durante el `transferFrom`, solo aumentaría `received` con tokens que el contrato efectivamente tiene, sin poder llevarlo a cero ni hacer que un escrow pague más de lo que hay. El único caso peligroso es reentrar `createEscrow` y contar dos veces el mismo depósito. Eso lo bloquea `nonReentrant` y lo cubre `test_RevertWhen_SenderHookReentersCreateDuringDeposit`.
- **Por qué inline y no en la configuración:** así el detector sigue activo para cualquier otra igualdad que se agregue.

### `timestamp`

- **Qué busca el detector:** lógica que depende de `block.timestamp`, porque el productor del bloque puede moverlo algunos segundos.
- **Por qué se acepta:** las ventanas de tiempo son la lógica del contrato, y un desvío de segundos es irrelevante frente a 2 horas y 7 días. Está documentado en *Limitaciones conocidas* del README.
- **Cómo se cubre:** los límites exactos (−1 s, exacto y +1 s) se testean en `EscrowTimeWindows.t.sol`, en los fuzz de `EscrowFuzz.t.sol` y en los invariantes, con `warpToDeadline`.

### `naming-convention`

- `CANCEL_WINDOW()` y `TTL()` son parte de la interfaz pública: los getters de las `immutable`.
- Slither espera `mixedCase` para las `immutable`. `forge lint` y la guía de estilo de Solidity piden `SCREAMING_SNAKE_CASE`, y se sigue a esos dos.

## Lo que Slither no ve: reentrada a través de `SafeERC20`

Prueba de cordura de la configuración: se inyectó una reentrada real en `confirm`, sin `nonReentrant` y con la transferencia antes del cambio de estado.

| Mutación | Resultado de Slither |
| --- | --- |
| Transferencia con `safeTransfer` (como en el contrato) | **0 hallazgos**, incluso sin ningún filtro |
| Transferencia con `IERC20.transfer` directo | `reentrancy-events` en `confirm` |

- **Causa:** OZ 5.7 implementa `safeTransfer` y `safeTransferFrom` con un `call` en assembly. Slither no modela llamadas externas dentro de assembly, así que sus detectores de reentrada no las ven.
- **Consecuencia:** en este contrato, los detectores de reentrada de Slither **no cubren los movimientos de fondos**.
- **Qué lo cubre:**
  - `nonReentrant` en las 5 funciones que mueven fondos, más el orden CEI al resolver
  - los tests de reentrada de `EscrowTokens.t.sol`: el ataque de doble conteo en `createEscrow` y la reentrada durante el pago en las 4 resoluciones
  - las mutaciones de las fases 2 y 3: sacar el guard de `createEscrow` hace fallar los tests

Un "0 hallazgos" de Slither no es evidencia de que no haya reentrada; la evidencia son los tests.
