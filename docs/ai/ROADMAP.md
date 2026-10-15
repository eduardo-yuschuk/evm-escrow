# Roadmap

Ruta de desarrollo completa, desde el repo vacío hasta la entrega. Las decisiones de diseño están en [`DESIGN.md`](DESIGN.md), cómo correrlo en el [`README.md`](../../README.md) y el enunciado en [`CHALLENGE.md`](../../CHALLENGE.md).

**Principios:**
- **Solo Docker.** El único requisito del host es Docker con Compose v2. Todo corre en contenedores: scaffolding, build, tests, lint, deploy, Slither y demo. Nada asume Node, Foundry, solc ni Python instalados, y CI usa exactamente los mismos comandos.
- **Contrato primero, con tests.** La seguridad y la corrección del contrato pesan el 50 % de la evaluación.
- **Commits chicos y descriptivos,** uno por paso lógico. El enunciado valora un historial que muestre el avance.
- **Cada fase termina en verde:** tests, lint y build pasan antes de pasar a la siguiente.
- **Versiones fijadas:** imagen de Foundry por tag, solc `0.8.37` con `evm_version = "cancun"`, Node, Postgres, Slither y los lockfiles commiteados.

## Resumen

| Fase | Entregable | Depende de |
| --- | --- | --- |
| 0. Setup dockerizado | Estructura, Dockerfiles, servicios `forge` y `npm`, `docs/ai/` | — |
| 1. Contrato | `Escrow.sol` completo | 0 |
| 2. Tests del contrato | Unitarios, reverts, límites de tiempo, tokens no estándar | 1 |
| 3. Fuzz e invariantes | Handler más invariantes de Foundry | 2 |
| 4. Gas y análisis estático | Gas report, snapshot, servicio `slither` con hallazgos comentados | 2 |
| 5. Deploy y ABI | `forge script`, `deployments/31337.json`, ABI y bytecode tipados | 1 |
| 6. Indexador | Esquema DB, proyector, loop con checkpoint, guard de cadena | 5 |
| 7. API HTTP | `/escrows/:id`, `/escrows`, `/health`, estado derivado | 6 |
| 8. Tests de la API | Proyector, idempotencia, reanudación, endpoints | 6, 7 |
| 9. Stack compose | `anvil`, `deployer`, `postgres` y `api` con `docker compose up` | 5, 7 |
| 10. Script de demo | Servicio `demo`: confirmar, rechazar, cancelar, vencer | 9 |
| 11. CI | GitHub Actions con los mismos comandos `docker compose` | 3, 4, 8, 10 |
| 12. Cierre | Verificación en un host solo con Docker, README final, entrega | todo |

Las fases 3 y 4 pueden ir en paralelo con la 5. La 6 solo necesita el ABI y el deploy local.

---

## Pendientes decididos

Trabajo acordado que todavía no tiene fase asignada. Se agenda antes del cierre (fase 12).

- [ ] **Owner con alcance limitado a la creación de escrows.**
  - `pause()` / `unpause()`: mientras está pausado, `createEscrow` revierte. Las cuatro acciones de resolución **siguen funcionando siempre**, así pausar nunca bloquea fondos.
  - **Whitelist de tokens** (`setTokenAllowed(token, bool)`): `createEscrow` solo acepta tokens permitidos. Quitar un token de la lista no afecta a los escrows ya creados con él.
  - **Restricción:** el owner no puede mover fondos ni cambiar el estado de un escrow existente, como pide el enunciado ("nadie, ni siquiera el owner").
  - **Valor:** la whitelist cubre riesgos que hoy son limitaciones documentadas: contratos que no son ERC-20, tokens rebasing y tokens con hooks.
  - **Diseño a definir:**
    - `Ownable2Step` para transferir el owner en dos pasos
    - eventos `Paused`/`Unpaused` y `TokenAllowed`
    - si la whitelist arranca vacía o con tokens del deploy
    - impacto en el indexador (eventos nuevos) y en los tests (matriz de permisos)
  - Al implementarlo, actualizar la decisión 9 y la sección *Seguridad* de [DESIGN](DESIGN.md).

- [ ] **Demo en testnet (Sepolia) con ventanas cortas.**
  - **Para qué:** mostrar el vencimiento en vivo, ya que en una testnet no se puede avanzar el tiempo del nodo. Es la razón por la que `CANCEL_WINDOW` y `TTL` son `immutable` y no constantes.
  - **Script de deploy parametrizable:** ventanas por variables de entorno (por ejemplo, 2 y 10 minutos) y verificación del contrato en el explorador.
  - **Clave del deployer:** se pasa por variable de entorno y nunca se commitea. Se corre con `docker compose run`.
  - **Indexador:** la API corre contra el RPC de Sepolia, con `CONFIRMATIONS` de alrededor de 12 o el tag `finalized`.
  - **README:** dirección del contrato deployado, link al explorador y pasos para reproducir la demo.

## Fase 0: Setup dockerizado ✅

Como no hay tooling local, la infraestructura Docker va **primero**: sin ella no se puede ni compilar.

- [x] **Versiones fijadas** (anotadas en [DESIGN](DESIGN.md#arquitectura)). Se eligieron releases con al menos dos semanas de publicadas, salvo la imagen de Node, que es el último parche de Node 24 LTS:
  - `ghcr.io/foundry-rs/foundry:v1.8.3`
  - solc `0.8.37`
  - forge-std `1.16.2` y OpenZeppelin `5.7.0`
  - `node:24.21.0-bookworm-slim`
  - npm: dependencias exactas resueltas con `--before=2026-09-29`
  - Postgres y Slither se fijan en sus fases (9 y 4).
- [x] **Scaffolding con contenedores efímeros,** sin instalar nada en el host:
  - `forge soldeer install` en la imagen de Foundry, que genera `soldeer.lock`
  - `npm install --package-lock-only` en la imagen de Node, que genera `package-lock.json` sin `node_modules`
- [x] **`contracts/foundry.toml`:**
  - `solc_version = "0.8.37"`, `evm_version = "cancun"`
  - optimizer con 200 runs
  - perfil `ci` con más runs de fuzz e invariantes
  - `fs_permissions` para `deployments/`
  - Soldeer en `[dependencies]` con `soldeer.lock`
  - `remappings.txt` escrito a mano con los paths convencionales (`@openzeppelin/contracts/`, `forge-std/`) y `remappings_generate = false`
- [x] **`contracts/Dockerfile`:**
  - stage `deps`: solc 0.8.37 precargado, para compilar sin red (verificado con `--network none`), más las dependencias Soldeer
  - stage `build`: contratos compilados, para el deployer
- [x] **`api/Dockerfile`:**
  - `dev`: `npm ci` más `anvil` copiado de la imagen de Foundry. Las libc son compatibles: Ubuntu 22.04 (glibc 2.35) hacia Debian 12 (glibc 2.36).
  - `build`: `tsc` y `npm prune`
  - `runtime`: solo dependencias de producción y `dist/`
- [x] **API:**
  - TypeScript 6 estricto, ESM
  - ESLint 10 (`strictTypeChecked`) y Prettier
  - Vitest 5 con `passWithNoTests` hasta la fase 8
  - script de instalación de `esbuild` aprobado en `allowScripts`, porque npm 11 los bloquea por defecto
- [x] **`docker-compose.yml`** con los servicios de herramientas `forge` y `npm` (perfil `tools`), que montan `./contracts` y `./api`.
- [x] **Permisos.** En lugar de un `user:` fijo, los servicios arrancan como root y el entrypoint baja con `setpriv` al dueño del código montado.
  - Con Docker rootless, el dueño es el root del contenedor, que equivale al usuario del host, así que se queda como root.
  - Con Docker clásico, baja al uid del host.
  - Se probaron los dos caminos.
- [x] **Dependencias en el host.** El entrypoint las instala desde el contenedor en `contracts/dependencies/` y `api/node_modules/`, ignorados por git, cuando faltan o cambia el lockfile (stamp con sha256). Se descartaron los volúmenes nombrados anidados en el bind mount, porque con Docker clásico dejan directorios vacíos de root en el host.
- [x] `.dockerignore` por imagen, `.gitignore` y `.editorconfig`.
- [x] `docs/ai/`: log de prompts y outputs, y el análisis de ambigüedades.
- [ ] Sacar el PDF del repo o decidir si se versiona (**decisión del autor**).
- `.env.example` pasa a la fase 9: recién ahí hay variables para sobrescribir (puertos, confirmaciones).

**Hecho cuando:** en un clon limpio, con imágenes construidas con `--no-cache`, `docker compose run --rm forge build` y `docker compose run --rm npm run build` pasan sin código de negocio. ✅ También pasan `npm run typecheck`, `npm run lint` y `npm test`.

**Commits:** `build: foundry image and forge tool service`, `chore: scaffold foundry project with soldeer`, `build: node image and npm tool service`, `chore: scaffold api project`, `docs: add challenge, readme, roadmap and ai outputs`.

## Fase 1: Contrato `Escrow.sol` ✅

Orden seguido: primero los tipos (revisados antes de implementar) y después cada acción con sus checks.

- [x] **Interfaz `src/IEscrow.sol`** con tipos, eventos, errores, acciones y vistas, documentada con NatSpec. Decisiones de la revisión:
  - el token se pasa como `address`, como en la firma del evento del enunciado
  - los eventos de resolución llevan solo `id`: el indexador hace el cruce y no se gasta más gas
  - timestamps en `uint64`
  - los errores llevan datos de diagnóstico
  - se agregaron las vistas `escrowCount()`, `CANCEL_WINDOW()` y `TTL()`
- [x] **Tipos.** `enum Status { None, Pending, Released, Rejected, CancelledBySender, Expired }` y el `struct EscrowData` empaquetado en 4 slots: `sender + uint64 createdAt + Status`, `beneficiary`, `token`, `amount`.
- [x] **Constructor.** `uint64 cancelWindow`, `uint64 ttl` como `immutable` (`CANCEL_WINDOW`, `TTL`). Revierte con `InvalidWindows(cancelWindow, ttl)` salvo que `0 < cancelWindow < ttl`.
- [x] **`createEscrow(token, beneficiary, amount)`.**
  - Validaciones: `amount > 0`, `beneficiary` distinto de 0 y del sender, y `token` con código, lo que también excluye `address(0)`.
  - Diferencia de `balanceOf` alrededor de `safeTransferFrom`, con `NothingReceived` si es 0.
  - Guarda lo recibido y emite el evento con ese monto. Los ids van desde 1.
- [x] **`cancel(id)`:** solo el sender, con `t < createdAt + CANCEL_WINDOW`.
- [x] **`confirm(id)` y `reject(id)`:** solo el beneficiary, con `t < createdAt + TTL`.
- [x] **`recoverExpired(id)`:** solo el sender, con `t >= createdAt + TTL`.
- [x] **Único helper, `_loadPending(id)`:** revierte con `EscrowNotFound` o `NotPending`. Los chequeos de quién llama y de tiempo van inline en cada acción: por decisión del autor, cada función se lee completa a primera vista y su regla se compara 1 a 1 con la tabla del enunciado. Costo: +156 B de bytecode, sin cambio de gas por llamada.
- [x] **CEI en las resoluciones:** checks, `status = final`, `emit` y `safeTransfer`.
  - El evento va antes de la transferencia: si la transferencia revierte, el evento se revierte con ella.
  - Todas las funciones que mueven fondos son `nonReentrant`, con `ReentrancyGuardTransient` (target Cancun).
- [x] **`getEscrow(id)`:** devuelve un `EscrowView` con los deadlines calculados y revierte con `EscrowNotFound`.
- [x] **NatSpec** en la interfaz pública, y `@inheritdoc` en la implementación.
- [x] **Lint.** `forge lint` queda limpio:
  - el cast de `uint64(block.timestamp)` está justificado en la misma línea
  - `block-timestamp` se excluye en `foundry.toml`, porque las ventanas de tiempo son la lógica del contrato y el drift de los validadores es de segundos

**Hecho cuando:** `docker compose run --rm forge build` compila sin warnings y `docker compose run --rm forge fmt --check` pasa. ✅ Runtime: 4.063 B.

**Commits:** `feat(contract): escrow interface`, `feat(contract): escrow implementation`.

## Fase 2: Tests del contrato ✅

Estructura (61 tests, todos verdes):

```
test/utils/EscrowTestBase.sol   setup común: Escrow(2h, 7d), MockERC20, actores, helpers por acción
test/mocks/                     MockERC20, NoReturnERC20, FalseReturnERC20, FeeOnTransferERC20,
                                ReentrantERC20, ReentrancyAttacker, BlacklistERC20
test/EscrowCreate.t.sol         constructor, createEscrow (happy path y validaciones), getEscrow
test/EscrowResolve.t.sol        transiciones, control de acceso, matriz de resueltos, orden de checks, aislamiento
test/EscrowTimeWindows.t.sol    límites de 2 h y 7 días: −1 s, exacto, +1 s
test/EscrowTokens.t.sol         tokens no estándar, reentrada, limitaciones conocidas
```

**Mocks:**
- [x] `MockERC20`: estándar.
- [x] `NoReturnERC20`: estilo USDT, sin `bool`.
- [x] `FalseReturnERC20`: devuelve `false`. Revierte con `SafeERC20FailedOperation`.
- [x] `FeeOnTransferERC20`: fee en basis points, incluido el 100 %.
- [x] `ReentrantERC20`: hook previo a mover balances, que llama a un target una sola vez.
- [x] `ReentrancyAttacker`: sender que reentra `createEscrow` desde el hook, el ataque ERC-777 real.
- [x] `BlacklistERC20`: estilo USDC.

**Tests:**
- [x] **Constructor:** las ventanas inválidas (0, igual a `ttl`, mayor que `ttl`) revierten con `InvalidWindows`.
- [x] **Create, happy path:** storage, deadlines, balances, evento con todos los campos e ids secuenciales desde 1.
- [x] **Create, reverts:** monto 0, beneficiary 0, beneficiary igual al sender, token 0, token sin código, allowance insuficiente y balance insuficiente.
- [x] **Cada transición:** estado final, balances del sender, del beneficiary y del contrato, y evento. Los datos siguen legibles después de resolver.
- [x] **Parte equivocada:** cada acción llamada por la otra parte, por un tercero y por el deployer.
- [x] **Matriz de escrows resueltos:** 4 estados finales × 4 acciones, todas con `NotPending` y sin mover fondos.
- [x] **Id inexistente:** `0` y uno no creado todavía, en las 4 acciones y en `getEscrow`.
- [x] **Orden de los chequeos:** existencia y estado, después quién llama, después la ventana de tiempo.
- [x] **Límites de tiempo** (timestamp realista):
  - cancel: mismo bloque, `+2h − 1` (ok), `+2h` y `+2h + 1` (revert), después de los 7 días (revert)
  - confirm y reject: mismo bloque, después de las 2 h, `+7d − 1` (ok), `+7d` y `+7d + 1` (revert)
  - recover: mismo bloque y `+7d − 1` (revert), `+7d`, `+7d + 1` y `+7d + 365d` (ok)
- [x] **Tokens no estándar:**
  - no-return: ciclo completo
  - false-return: revierte
  - fee-on-transfer: registra lo recibido, no drena otros escrows, y con fee del 100 % revierte con `NothingReceived`
- [x] **Reentrada:**
  - ataque de doble conteo en `createEscrow` desde el hook del sender
  - reentrada durante el pago en las 4 acciones
- [x] **Limitaciones conocidas** (`test_KnownLimitation_*`):
  - sender en la blacklist: los fondos quedan trabados hasta que el token lo desbloquea
  - beneficiary en la blacklist: no puede confirmar, pero sí rechazar
- [x] **Aislamiento:** resolver un escrow no afecta a los demás del mismo token.
- [x] **`forge coverage`:** 100 % de líneas (58/58), sentencias (82/82), ramas (16/16) y funciones (8/8) en `Escrow.sol`.

**Verificación por mutaciones.** Se introdujeron 10 bugs a mano en `Escrow.sol`, uno por vez, y todos hicieron fallar al menos un test:
- `>=` cambiado por `>` en cancel y en confirm
- `<` cambiado por `<=` en recover
- reject que paga al beneficiary
- guardar el monto pedido en lugar del recibido
- sin `nonReentrant` en create
- sin `nonReentrant` en confirm
- sin el chequeo del sender en cancel
- sin el cambio de estado en recover
- sender permitido como beneficiary

Dos de esas mutaciones revelaron algo:
- **Sin guard en `createEscrow`:** el ataque registra 300 por 200 depositados, y el test lo detecta.
- **Sin guard en `confirm`:** la reentrada falla igual con `NotPending`, así que CEI solo ya protege el pago.

**Hecho cuando:** `docker compose run --rm forge test` está todo verde y la cobertura está reportada. ✅

**Commits:** `test(contracts): token mocks and shared base`, `test(contracts): creation and validation`, `test(contracts): transitions, access control and resolved matrix`, `test(contracts): time window boundaries`, `test(contracts): non-standard tokens, reentrancy and known limitations`.

## Fase 3: Fuzz e invariantes ✅

Estructura (11 tests nuevos, 72 en total, todos verdes):

```
test/EscrowFuzz.t.sol                  10 fuzz: ventanas, montos, fees, timestamps y callers aleatorios
test/invariant/EscrowHandler.sol       handler con modelo de referencia de cada escrow
test/invariant/EscrowInvariants.t.sol  5 invariantes sobre el handler
```

- [x] **Fuzz unitarios** (`EscrowFuzz.t.sol`):
  - **Constructor:** ventanas aleatorias; revierte si y solo si `cancelWindow == 0 || cancelWindow >= ttl`.
  - **Create:** monto y timestamp de creación aleatorios; storage, deadlines y balances.
  - **Fee-on-transfer:** fee entre 0 y 100 % y monto aleatorio. Registra lo recibido, el pago saca exactamente eso del escrow y con fee del 100 % revierte con `NothingReceived`.
  - **Ventanas:** una prueba por acción, con creación y tiempo transcurrido aleatorios (0 a 14 días). La acción funciona si y solo si su ventana está abierta, según la regla de `IEscrow`.
  - **Pagos:** monto y acción aleatorios; cada acción paga lo registrado a la parte correcta.
  - **Control de acceso:** caller, acción y tiempo aleatorios; cualquier caller que no sea la parte revierte con `NotSender`/`NotBeneficiary`, sin importar la ventana.
  - **Ids inexistentes:** cualquier id distinto de 1 revierte con `EscrowNotFound`, en `getEscrow` y en las 4 acciones.
- [x] **Handler** (`test/invariant/EscrowHandler.sol`):
  - **Escenario:** 3 actores y 3 tokens (estándar, estilo USDT y fee-on-transfer del 1 %).
  - **Acciones:** `createEscrow`, `cancel`, `confirm`, `reject`, `recoverExpired`, `donate` (tokens enviados al contrato fuera de `createEscrow`), `warp` (hasta 1 día) y `warpToDeadline` (−1 s, exacto o +1 s de un deadline, para pegarle a los límites).
  - **Modelo de referencia:** guarda cada escrow escrito a partir de las reglas de `IEscrow`. Antes de cada resolución predice el resultado (éxito o el error exacto, con sus argumentos) y lo compara con el contrato, incluido cuánto se mueve cada balance.
  - **Elección de ids y callers:** 3 de cada 4 llamadas apuntan a un escrow pendiente y vienen de la parte correcta, para que haya resoluciones exitosas. El resto usa cualquier id (incluidos 0 y el siguiente sin usar) y cualquier actor.
  - **Ghost variables:** por token, lo depositado, lo pagado y lo donado; cantidad de escrows creados; éxitos y reverts esperados por acción, que se imprimen con `-vv` en `afterInvariant`.
- [x] **Invariantes** (`EscrowInvariants.t.sol`). Las sumas se leen del contrato con `getEscrow`, no del modelo:
  - **Solvencia:** por token, `balanceOf(escrow) >= Σ amount` de los escrows `Pending`.
  - **Contabilidad exacta:** por token, `balanceOf(escrow) == depositado − pagado + donado == Σ pendientes + donado`. Nada entra ni sale por otro camino.
  - **Pagos:** por token, lo pagado nunca supera lo depositado.
  - **Modelo:** cada escrow coincide con el modelo en estado, datos y deadlines. Como el modelo nunca saca un escrow de un estado final, esto cubre "un estado final nunca cambia".
  - **Ids:** `escrowCount` es igual a la cantidad de creaciones; `0`, `escrowCount + 1` y `type(uint256).max` no existen.
- [x] **`fail_on_revert = true`** en los dos perfiles, un cambio respecto de la fase 0. El handler envuelve cada llamada y verifica él mismo el resultado esperado, así que cualquier revert que llega al fuzzer es un bug, del contrato o del handler.
- [x] **Perfiles:**
  - `default`: fuzz 256 runs; invariantes 256 runs × 50 de profundidad (12.800 llamadas). La suite completa tarda ~8 s.
  - `ci` (`FOUNDRY_PROFILE=ci`): fuzz 10.000 runs; invariantes 512 × 100 (51.200 llamadas). La suite completa tarda ~47 s.

**Verificación por mutaciones.** Se repitieron 10 bugs en `Escrow.sol`, uno por vez, corriendo **solo** la suite de invariantes. Los 10 la hicieron fallar:
- `>=` cambiado por `>` en cancel y en confirm, y `<` por `<=` en recover. Los límites exactos los alcanza `warpToDeadline`.
- cancel sin cambio de estado
- confirm que paga al sender
- reject que deja el estado `Released`
- guardar el monto pedido en lugar del recibido (lo detecta el token con fee)
- id sin incrementar `escrowCount`
- cancel que chequea al beneficiary
- pago del doble

**Hecho cuando:** `docker compose run --rm -e FOUNDRY_PROFILE=ci forge test` pasa. ✅

**Commits:** `test(contracts): fuzz time windows, amounts and access control`, `test(contracts): invariant suite with reference model`.

## Fase 4: Gas y análisis estático ✅

**Gas** (detalle en [`docs/gas.md`](../gas.md)):
- [x] **Benchmark `test/EscrowGas.t.sol`:** 7 escenarios, uno por operación (más el primer escrow del contrato y un beneficiary sin saldo previo). Registra el gas de cada llamada con `vm.snapshotGasLastFrame` en `contracts/snapshots/EscrowGasTest.json`, que se reescribe en cada `forge test`.
- [x] **Verificado contra Anvil:** las mismas transacciones enviadas a un nodo dan exactamente el mismo `gasUsed` en el recibo. Deploy: 933.537.
- [x] **`.gas-snapshot`** con `docker compose run --rm forge snapshot`. Es determinista (la semilla del fuzz es fija en `snapshot`), y `forge snapshot --check` pasa en una segunda corrida.
- [x] **`FORGE_SNAPSHOT_CHECK=true`** hace fallar `forge test` si cambia el gas de una operación. Se probó alterando un valor a mano.
- [x] **7 variantes de optimización medidas** sobre una copia del contrato, cada una con su veredicto:
  - `uint96`: −22.059 en `createEscrow`, descartada por el límite de monto
  - borrar storage al resolver, descartada
  - `via_ir`: −0,7 % a −1,6 % y −848 B, descartada por el autor
  - `optimizer_runs` alto, descartada
  - sin medir lo recibido, descartada
  - sin chequeo de código, descartada
  - `unchecked`: −52, descartada por el autor

  **No se aplicó ninguna al contrato.**

**Slither** (detalle en [`docs/slither.md`](../slither.md)):
- [x] **Imagen `docker/slither.Dockerfile`:**
  - `python:3.12.14-slim-bookworm` con `forge` copiado de `ghcr.io/foundry-rs/foundry:v1.8.3`
  - solc 0.8.37 descargado en la imagen
  - contexto de build en la raíz, filtrado por `docker/slither.Dockerfile.dockerignore`
- [x] **`docker/slither.requirements.txt`:** `slither-analyzer==0.11.6` y sus 46 dependencias fijadas con hashes (`--require-hashes`), resueltas con `uv --exclude-newer 2026-09-29`.
- [x] **Servicio `slither`** (perfil `tools`):
  - monta `./contracts` y reutiliza el entrypoint de `forge`
  - `FOUNDRY_OUT` y `FOUNDRY_CACHE_PATH` dentro del contenedor, porque crytic-compile corre `forge clean`
- [x] **`contracts/slither.config.json`:**
  - `filter_paths`: `dependencies/`, `test/` y `script/`
  - excluye `timestamp` y `naming-convention`, con su justificación
- [x] **Hallazgos:** 9 en la primera corrida, de 3 detectores, todos con su veredicto.
  - `incorrect-equality` (`received == 0`): falso positivo, desactivado en esa línea. Es el único cambio en `Escrow.sol`, solo de comentarios.
  - `timestamp`: aceptado, con el mismo criterio que el lint.
  - `naming-convention`: aceptado, se sigue a `forge lint`.
- [x] **Prueba de cordura:**
  - Slither no detecta una reentrada inyectada en `confirm` si el pago usa `safeTransfer`, porque OZ 5.7 hace la llamada en assembly.
  - Con `transfer` directo, sí la detecta.
  - Quedó documentado: la cobertura de reentrada la dan `nonReentrant`, CEI y los tests.

**Hecho cuando:** `docker compose run --rm slither` termina con 0 hallazgos y exit 0, y cada hallazgo original está comentado. ✅

**Commits:** `test(contracts): gas benchmark and snapshots`, `build: slither service`, `docs: gas report and slither findings`.

## Fase 5: Deploy y ABI ✅

- [x] **`script/Deploy.s.sol`:**
  - deploya `Escrow` con ventanas configurables por `ESCROW_CANCEL_WINDOW` y `ESCROW_TTL` (2 h y 7 días por defecto), lo que deja lista la demo en Sepolia de *Pendientes decididos*
  - en la chain `31337` (o con `DEPLOY_MOCK_TOKEN=true`) deploya un `MockERC20` y le da 1.000.000 de tokens a cada una de las 10 cuentas de Anvil, derivadas del mnemonic por defecto
  - la clave se pasa con `--private-key`; el script no tiene ninguna
- [x] **`deployments/<chainId>.json`** con `vm.writeJson`: `{ chainId, escrow, token, cancelWindow, ttl, startBlock, startBlockHash }`.
  - `startBlock` es el último bloque antes del deploy, así que indexar desde ahí no pierde eventos.
  - `blockhash` devuelve cero para el bloque actual dentro del script, así que el hash se calcula con `keccak256(vm.getRawBlockHeader(startBlock))`. Se verificó contra `cast block`, incluso en el bloque 0.
  - Un dry run (sin `--broadcast`) no escribe el archivo.
- [x] **`npm run abi`** (`api/scripts/generate-abi.ts`):
  - lee `contracts/out/`; el servicio `npm` monta `./contracts` solo lectura en `/contracts` (la carpeta entera, porque si faltara `out/` Docker la crearía como root)
  - valida los artefactos con zod y da un error claro si falta compilar
  - genera `api/src/generated/contracts.ts` con ABI y bytecode de `Escrow` y `MockERC20`, con `as const`
  - **se commitea**, así la imagen de la API no compila contratos
  - un archivo descartable comprobó que viem infiere los tipos de eventos y funciones, y que rechaza nombres de función inexistentes
- [x] **Chequeo de desincronización** para CI: `forge build`, después `npm run abi`, después `git diff --exit-code api/src/generated`. El archivo sale idéntico después de `forge clean` + `build`, de `forge coverage` y de Slither.

**Verificación:**
- Deploy contra un Anvil levantado con compose, desde otro contenedor. El JSON queda correcto:
  - `startBlockHash` es igual al hash de la cadena
  - el código y las ventanas del contrato son los esperados
  - el saldo de las cuentas es el esperado
- Con ventanas de 120 s y 600 s, y sin token, también queda correcto.
- Con ventanas inválidas, el deploy revierte con `InvalidWindows`.
- Dos Anvil distintos dan hashes de génesis distintos en el mismo bloque. Es lo que usa el guard de cadena.

**Hecho cuando:** el deploy contra un Anvil levantado por compose deja el JSON correcto, y `docker compose run --rm npm run abi` regenera sin diff. ✅

**Commits:** `feat(deploy): deploy script with deployments file`, `chore(api): generate typed abi and bytecode`.

## Fase 6: Indexador ✅

- [x] **Configuración** validada con zod (`src/config.ts`):
  - `RPC_URL`, `DATABASE_URL` y `DEPLOYMENTS_FILE`, obligatorias
  - `CONFIRMATIONS` (0 por defecto), `BATCH_SIZE` (1000), `POLL_INTERVAL_MS` (1000), `RESET_ON_CHAIN_MISMATCH` (`false`) y `LOG_LEVEL` (`info`)
  - una variable vacía toma el default; un valor inválido aborta con la lista de errores
- [x] **Migraciones SQL** versionadas en `api/migrations/`, con un runner propio al arrancar (`src/db/migrate.ts`):
  - cada migración corre en su transacción y queda en `schema_migrations` con su sha256: editar una ya aplicada, o correr código más viejo que la base, es un error fatal
  - `pg_advisory_lock` para que dos procesos que arrancan juntos no migren a la vez
  - la imagen `runtime` copia `migrations/` junto a `dist/`
  - `0001_initial.sql`:
    - dominios `address`, `bytes32` y `uint256`: la base rechaza direcciones o hashes que no estén en minúsculas y montos fuera de rango
    - `events`: clave primaria `(tx_hash, log_index)`, `block_number`, `block_hash`, `name` y `args jsonb`. Se agregó `block_timestamp`, así cada evento guarda todo lo que necesita la proyección.
    - `escrows`: las columnas previstas, un `CHECK` de estados y otro que exige `resolved_tx` y `resolved_at` exactamente cuando el estado es final
    - índices `(sender, id)`, `(beneficiary, id)` y `(status, id)`, que sirven al filtro y al orden del listado, y uno parcial por `expires_at` sobre los `Pending`, que separa `Pending` de `ExpiredRecoverable`
    - `indexer_state`: una sola fila con `chain_id`, `contract_address`, `start_block`, `start_block_hash` y `last_indexed_block`
- [x] **Guard de cadena** al arrancar (`src/indexer/guard.ts`), en dos pasos:
  - **El archivo de deploy contra la cadena:** chain id, hash del `startBlock` y código en la dirección del contrato. Si no coinciden, por ejemplo porque Anvil se reinició y nadie volvió a deployar, aborta siempre: el archivo no sirve. Este paso no estaba previsto; sin él, el indexador esperaría para siempre bloques de una cadena que ya no existe.
  - **La DB contra el archivo de deploy:** si la DB viene de otra cadena o contrato, con `RESET_ON_CHAIN_MISMATCH=true` vacía `events` y `escrows` y reindexa, y si no aborta con un error que dice cómo seguir. Todo en una transacción.
  - Durante el loop, si el head queda por debajo del checkpoint, repite el primer paso: un nodo RPC atrasado se espera y otra cadena es fatal.
- [x] **Proyector puro** `applyEvent(state, event) → mutation` (`src/indexer/projector.ts`):
  - devuelve `create` si el escrow no existe, `resolve` si está `Pending` y `skip` en cualquier otro caso
  - el mismo evento dos veces es un `skip` de nivel debug
  - una resolución de un id desconocido, o de un escrow ya resuelto por otra transacción, es un `skip` de nivel error: se loggea y no se aplica
  - el SQL repite las guardas: `INSERT … ON CONFLICT (id) DO NOTHING` y `UPDATE … WHERE id = $1 AND status = 'Pending'`
- [x] **Loop** (`src/indexer/indexer.ts`):
  - `to = min(head − CONFIRMATIONS, from + BATCH_SIZE − 1)`, con `eth_getLogs` filtrado por address y los topics de los 5 eventos
  - decodificación estricta con `decodeEventLog`: un log que no coincide con el ABI es un error, mientras que `getLogs` de viem lo descartaría sin avisar
  - orden por `(blockNumber, logIndex)`
  - una transacción por batch: bloquea la fila de `indexer_state` y verifica que el checkpoint no se movió, inserta en `events` con `ON CONFLICT DO NOTHING … RETURNING`, aplica solo los eventos nuevos y avanza el checkpoint
  - el checkpoint se relee en cada vuelta, así que moverlo a mano hacia atrás reprocesa el rango (lo usa la fase 8)
  - timestamp del bloque: el campo `blockTimestamp` del log, que Anvil incluye, o `getBlock` una vez por bloque si el nodo no lo manda
- [x] **Reintentos con backoff** exponencial, de 0,5 s a 30 s, en cada vuelta del loop y en cada paso del arranque, con un log por fallo.
  - El cliente de viem va con `retryCount: 0`: con sus reintentos internos, un RPC colgado tardaba más de 40 s en dar un error visible.
  - Los errores irrecuperables (`FatalError`) no se reintentan y el proceso sale con código 1: configuración, archivo de deploy, migración editada o cadena distinta.
  - Logs JSON con pino. `pino` pasó a dependencia directa, con la misma versión que ya traía fastify.
- [x] **Apagado ordenado** con SIGTERM o SIGINT:
  - cancela las requests al RPC en curso, con un `fetchFn` que combina el timeout de viem con la señal de apagado (`AbortSignal.any`), y deja terminar la transacción de DB en curso
  - sale con código 0, y una segunda señal sale de inmediato
  - sin la cancelación, un SIGTERM con el RPC colgado tardaba 9 s, al borde de los 10 s que espera `docker compose stop` antes del SIGKILL
- Los tests automatizados son de la fase 8.

**Verificación:** contra Anvil y Postgres levantados con un override de compose descartable, porque los servicios definitivos son de la fase 9. El contrato se deployó con el servicio `forge` y las transacciones se mandaron con `cast`.
- Confirmar, rechazar, cancelar y vencer (`evm_increaseTime` y `recoverExpired`) quedan proyectados con `created_at`, deadlines y `resolved_at` correctos.
- Un bloque con tres eventos (crear 6, crear 7 y cancelar 6) se proyecta bien.
- `docker compose restart` del indexador retoma desde el checkpoint, sin duplicados.
- Con el checkpoint forzado a 0 y el indexador corriendo, reprocesa 14 eventos, 0 nuevos, y el dump de la DB queda idéntico.
- `kill -9` en 6 momentos de una puesta al día de 1.025 bloques con `BATCH_SIZE=1`: los eventos guardados son siempre exactamente los de los bloques hasta el checkpoint, y al reanudar la DB queda idéntica.
- Con `CONFIRMATIONS=2`, el escrow aparece recién con 2 bloques encima.
- **Guard de cadena:**
  - con Anvil reiniciado mientras el indexador corre, sale con un error claro
  - con el archivo de deploy viejo, no arranca
  - después de redeployar, la DB vieja aborta con `RESET_ON_CHAIN_MISMATCH=false`, y se vacía y reindexa con `true`
- Con Postgres caído unos segundos, reintenta a los 0,5, 1, 2 y 4 s, y se recupera sin perder el escrow creado mientras tanto.
- Con el RPC sin responder, da un error de timeout a los 10 s, y un SIGTERM en ese estado sale en 0,14 s con código 0.
- La imagen `runtime` arranca con los defaults, aplica la migración e indexa.
- Sin `blockTimestamp` en los logs, el fallback a `getBlock` da los mismos timestamps, con un `getBlock` por bloque.
- Una configuración inválida, un archivo de deploy inexistente, una migración editada y una resolución de un escrow ausente dan, cada uno, el error esperado.

**Hecho cuando:** contra Anvil, crear y resolver escrows se refleja en la DB, y reiniciar el indexador no duplica ni pierde nada. ✅ Se verificó con el override descartable: `anvil` y `api` pasan a ser servicios de compose en la fase 9. `npm run lint`, `typecheck` y `build` pasan.

**Commits:** `feat(api): db schema and migrations`, `feat(api): event projector`, `feat(api): indexer loop with checkpoint`, `feat(api): chain mismatch guard`.

## Fase 7: API HTTP ✅

- [x] **Reloj de cadena** (`src/clock.ts`): `now()` es el timestamp del último bloque, cacheado 1 s. Las requests simultáneas comparten una sola consulta al nodo, y una falla no se cachea.
- [x] **Estado derivado** en `toView(escrow, now)`, una función pura (`src/http/view.ts`):
  - `status` efectivo, que incluye `ExpiredRecoverable`, más `onchainStatus`
  - flags `canCancel`, `canConfirm`, `canReject` y `canRecover`, con las mismas ventanas que el contrato
  - `now` en la respuesta: el timestamp con el que se calculó todo
- [x] **`GET /escrows/:id`:**
  - `400` si el id no es un entero decimal dentro del rango de `uint256` (`abc`, `-1`, `0x1`, `1e3`)
  - `404` si no existe
  - `503` si el nodo no responde, porque sin reloj no hay estado derivado, o si no responde la DB
- [x] **`GET /escrows`:**
  - filtros `sender`, `beneficiary` y `status` (el efectivo, con `ExpiredRecoverable` calculado en SQL con `now`)
  - `limit` (por defecto 20, de 1 a 100) y `offset`, más `total`. Fuera de rango es un `400`, no se recorta.
  - un parámetro vacío cuenta como ausente, así que la forma del enunciado, `?sender=&beneficiary=&status=`, lista todo
  - un parámetro desconocido es un `400`, para que un error de tipeo no descarte un filtro sin avisar
  - `total` y la página salen de una misma transacción `REPEATABLE READ` de solo lectura
- [x] **`GET /health`:** DB, RPC, `lastIndexedBlock`, `chainHead` y `lag`. Devuelve `503` con `degraded` si:
  - un chequeo no responde en 2 s
  - el indexador todavía no arrancó
  - el lag supera `CONFIRMATIONS + HEALTH_MAX_LAG` (10 por defecto)
  - el lag es negativo: el checkpoint se lee antes que el head, así que eso solo pasa si la cadena retrocedió
  - la primera versión leía los dos en paralelo y recortaba el lag a 0. Así, un proceso `MODE=api` informaba `ok` después de reiniciar Anvil. Se corrigió durante la verificación.
  - el healthcheck de compose se agrega en la fase 9
- [x] **Serialización:** `uint256` como string, direcciones con checksum y timestamps como número. Los errores mantienen el formato de fastify (`statusCode`, `error`, `message`), y un `500` no expone el mensaje original.
- [x] **Proceso:** indexador y API en el mismo proceso, con `MODE=all` (default), `indexer` o `api`.
  - Con `MODE=api` no hace falta `DEPLOYMENTS_FILE` ni corre el guard de cadena.
  - Si un componente falla de forma irrecuperable, se detiene el otro y el proceso sale con código 1.
  - Con SIGTERM, la API deja de aceptar requests y espera a las que están en curso.
  - Variables nuevas: `MODE`, `HOST`, `PORT` y `HEALTH_MAX_LAG`.
- [x] **Postgres colgado:** timeout de 3 s, del lado del cliente, para obtener una conexión y para cada query. Sin él, con Postgres pausado, una request quedaba colgada y SIGTERM no terminaba el proceso hasta que volvía la DB. Se encontró al revisar las decisiones de la fase.
- [x] **Logs:** una línea por request en `info`. Las de `/health` que responden `200` van en `debug`, y un `degraded` queda en `info`.
- Los tests automatizados son de la fase 8. `buildServer` arma la app sin escuchar, así los tests pueden usar `fastify.inject`.

**Verificación:** contra Anvil y Postgres, con el mismo tipo de override descartable que en la fase 6, y la API en el puerto 3107 porque el 3000 estaba ocupado en el host.
- **Cuatro caminos:** confirmar, rechazar, cancelar y vencer con `recoverExpired`, más un escrow vencido sin recuperar y uno en sentido inverso. `/escrows/:id` devuelve estado, flags, hashes y timestamps correctos.
- **Límites de tiempo** con `evm_setNextBlockTimestamp`:
  - en `cancelDeadline − 1`, `canCancel` es `true`
  - en `cancelDeadline`, pasa a `false`
  - en `expiresAt − 1`, el escrow sigue `Pending`
  - en `expiresAt`, pasa a `ExpiredRecoverable` con `canRecover`, sin ninguna transacción de recover
- **Listado:**
  - cada uno de los 6 estados efectivos devuelve exactamente su escrow
  - `sender` en minúsculas, mayúsculas y checksum da el mismo resultado
  - los filtros combinados funcionan
  - la paginación es correcta, incluido un `offset` más allá del final
  - el `?sender=&beneficiary=&status=` del enunciado lista todo
- **Errores:**
  - 20 entradas inválidas dan `400` con un mensaje claro: id no decimal o fuera de rango, `status` o dirección inválidos, `limit` 0 o 101, `offset` enorme, parámetro desconocido o repetido
  - el id `0` y el máximo `uint256` dan `404`
- **Reloj:** 50 requests simultáneas hacen una sola consulta `eth_getBlockByNumber` al nodo.
- **Health:**
  - con el RPC congelado, `/health` responde `degraded` en 2 s, y `/escrows/1` responde `503` cuando vence el timeout de viem, a los 10 s
  - con Postgres detenido, `/health` informa `db: error` y los escrows dan `503` al instante. Al volver, todo se recupera sin reiniciar.
  - con Postgres pausado, los escrows dan `503` a los 3 s, o a los 6 s en el listado si la transacción ya estaba abierta. 50 requests simultáneas reciben `503` en menos de 3,1 s, y el indexador reintenta sin caerse.
  - con el indexador detenido y 12 bloques nuevos, un proceso `MODE=api` pasa a `degraded` con `lag: 12`. Ese `503` queda en el log en `info`, y los `200` no aparecen.
  - el umbral `CONFIRMATIONS + HEALTH_MAX_LAG` se respeta en el borde
  - sin fila en `indexer_state`, informa `lastIndexedBlock: null`
  - después de reiniciar Anvil, el proceso `MODE=api` informa `lag: -36` y `degraded`
- **Modos:**
  - `MODE=indexer` no abre el puerto y sigue indexando
  - `MODE=api` arranca sin `DEPLOYMENTS_FILE` y lee la DB del otro proceso
  - una configuración inválida lista todos los errores juntos
- **Fallas:**
  - si la API no puede escuchar (`EADDRNOTAVAIL`), el indexador se detiene y el proceso sale con código 1
  - al reiniciar Anvil, el guard detiene el indexador, la API cierra el puerto y el proceso sale con código 1
- **Apagado:** un SIGTERM sale en 0,23 s con código 0. Con una request esperando a un RPC congelado, esa request recibe `503` en 0,57 s y el proceso sale en 0,26 s. Con un listado esperando a Postgres pausado, el listado recibe `503` a los 6 s y el proceso sale en 5,6 s con código 0.
- La imagen `runtime` arranca con los defaults, indexa y sirve la API.
- Los cuatro ejemplos curl del README, cambiando solo el puerto, devuelven lo documentado. Las direcciones abreviadas (`0xf39f...2266`) no se podían copiar y pegar: se reemplazaron por las completas.

**Hecho cuando:** los ejemplos curl del README devuelven lo documentado contra el stack de compose. ✅ Se verificó con el override descartable, porque el stack de compose es de la fase 9. `npm run lint`, `typecheck` y `build` pasan.

**Commits:** `feat(api): chain clock and derived status`, `feat(api): escrow and health endpoints`, `feat(api): run the indexer and the api in one process`. El plan original separaba los endpoints de escrows y el de health, pero comparten `buildServer` y cada commit tiene que compilar solo.

## Fase 8: Tests de la API ✅

Se corren con `docker compose run --rm npm test`: 79 tests en 6 archivos, en unos 6 s. El servicio `npm` depende de `postgres` sano y usa la base `escrow_test`, creada por `docker/postgres/init.sql`. Los tests de integración levantan su propio `anvil` efímero en un puerto libre, con el binario incluido en la imagen `api:dev`, y deployan con el bytecode generado.

```
test/unit/projector.test.ts        19: cada evento, eventos repetidos y conflictos
test/unit/view.test.ts             10: límites de tiempo, estados finales y serialización
test/integration/indexer.test.ts    6: caminos, mismo bloque, confirmaciones, reproceso, falla a mitad de batch, kill
test/integration/guard.test.ts      4: reinicio de Anvil con la misma DB
test/integration/http.test.ts      38: endpoints con fastify.inject
test/integration/expiry.test.ts     2: estado derivado mientras avanza el reloj de la cadena
test/support/                      Anvil, un schema propio en Postgres y el oráculo contra la cadena
```

- [x] **Servicio `postgres`**, adelantado de la fase 9 porque los tests lo necesitan:
  - imagen `postgres:17.11-alpine3.24` y volumen `pgdata`
  - `init.sql` crea `escrow_test`, aparte de la base `escrow` del stack
  - healthcheck con `pg_isready` por TCP: mientras corren los scripts de init, Postgres solo escucha en su socket Unix, así que un chequeo por socket daría sano antes de tiempo
- [x] **Unitarios del proyector:**
  - cada evento
  - el mismo evento dos veces, incluida la creación de un escrow que ya se resolvió
  - una resolución sobre un estado final, ya sea con el mismo estado y otra transacción o con otro estado
  - una resolución de un escrow desconocido
  - una creación repetida por otra transacción
- [x] **Unitarios de `toView`:**
  - límites `now = cancelDeadline − 1`, `= cancelDeadline`, `= expiresAt − 1` y `= expiresAt`, para cada flag y para `ExpiredRecoverable`
  - los estados finales no admiten acciones, antes y después de `expiresAt`
  - serialización con `uint256` máximo y checksum
- [x] **Oráculo: la cadena.** Los eventos guardados tienen que ser exactamente los logs del contrato. Cada fila de `escrows` tiene que coincidir con `getEscrow`, más las transacciones y los timestamps de sus logs.
- [x] **Integración con Anvil y Postgres reales:**
  - **Indexar, matar y reanudar.** Un proceso indexador real (`MODE=indexer`, `BATCH_SIZE=1`) recorre unos 270 bloques. Se lo mata con SIGKILL a un tercio y a dos tercios, se crean escrows mientras está caído y se lo reanuda hasta el final. Con SIGTERM sale con código 0, y la DB coincide con la cadena.
  - **Falla a mitad de batch.** Un trigger hace fallar la primera escritura en `escrows`, después de que el batch guardó sus eventos. No queda nada, y el reintento aplica cada evento una vez.
  - **Reproceso.** Al reprocesar todo lo indexado, forzando el checkpoint hacia atrás, la DB queda idéntica fila por fila.
  - **Mismo bloque.** Tres escrows creados y resueltos en el mismo bloque, con Anvil en `--order fifo` y con nonce y gas fijados a mano.
  - **Confirmaciones.** Con `CONFIRMATIONS = 2`, el checkpoint queda 2 bloques detrás del head, y el escrow aparece recién cuando tiene 2 bloques encima.
  - **Guard de cadena.** El Anvil reiniciado tiene el mismo chain id, las mismas direcciones y el mismo `startBlock`; solo cambia el hash.
    - el archivo de deploy viejo se rechaza
    - sin `RESET_ON_CHAIN_MISMATCH`, aborta sin tocar la DB
    - con el flag, la vacía e indexa la cadena nueva
    - el reinicio usa `--timestamp`, porque dos Anvil iniciados en el mismo segundo serían la misma cadena
- [x] **Aislamiento.** Cada archivo crea su propio schema en `escrow_test` y lo usa por `search_path`, así los archivos corren en paralelo. En las suites del indexador, cada test vacía las tablas y deploya su propio contrato.
- [x] **Tests HTTP** con `fastify.inject`, sin abrir puertos:
  - un escrow en cada estado efectivo, y la vista completa comparada con la cadena
  - los 6 filtros de estado, direcciones en cualquier combinación de mayúsculas y minúsculas, filtros combinados, paginación con `total` y parámetros vacíos
  - `400` para 6 ids y 9 queries inválidas, y `404` para 3 ids
  - `/health`: ok, degradado con el lag justo por encima del umbral, con lag negativo y antes de que arranque el indexador
  - `503` sin nodo y sin DB, apuntando a un puerto cerrado
  - `ExpiredRecoverable` después de `evm_increaseTime`, sin transacción de recover: el contrato sigue diciendo `Pending` y no hay eventos nuevos
  - los cuatro límites al segundo, con `evm_setNextBlockTimestamp`, en la vista y en el filtro SQL
- `indexNextBatch` se exporta para que los tests indexen batch por batch, sin el loop ni sus esperas.

**Verificación:**
- **Mutaciones.** Se introdujeron a mano 19 bugs en `src/`, uno por vez, y los tests detectaron todos. Entre otros: límites de tiempo en `toView` y en el SQL, batch sin transacción, confirmaciones corridas en uno, guard que ignora el hash, eventos de un bloque en orden inverso, umbral de `/health`, `500` en lugar de `503`, orden y `total` del listado, un reloj que cachea para siempre, una reanudación que saltea un bloque y el lag recortado a 0 de la fase 7.
  - El primer intento de romper la atomicidad fue cambiar `ROLLBACK` por `COMMIT`, y ningún test lo detectó. No podía detectarlo: en Postgres, un `COMMIT` sobre una transacción abortada hace rollback. Se reemplazó por una mutación que sí la rompe: el batch sin `BEGIN`.
  - El lag recortado a 0 no lo detectaba ningún test. Se agregó el de lag negativo.
  - Con la reanudación rota, el test de kill esperaba para siempre a su proceso hijo y colgaba la corrida. Ahora tiene un tope de espera y, si falla, mata a sus hijos.
- **Cache de viem.** El test de lag negativo leía un head viejo, porque el cliente de viem cachea `getBlockNumber` durante el `pollingInterval`. El cliente de los tests va sin cache.
- **Estabilidad:**
  - 5 corridas seguidas en verde
  - otra limitada a un solo núcleo de CPU, en 12 s
  - otra desde un volumen de Postgres nuevo, en 9 s, incluida la inicialización

**Hecho cuando:** `docker compose run --rm npm test`, `npm run lint` y `npm run typecheck` están en verde. ✅ También `npm run build`.

**Commits:** `build: postgres service for the api tests`, `test(api): projector and derived status units`, `test(api): indexer and chain guard against anvil and postgres`, `test(api): http endpoints and time-derived status`.

## Fase 9: Stack compose ✅

`docker compose up --build` levanta Anvil, deploya, levanta Postgres y arranca la API. Desde una copia limpia del repo, el build sin cache tarda 21 s y el stack queda sano 13 s después, con las imágenes base ya descargadas. El diseño está en [DESIGN](DESIGN.md#stack).

- [x] **Servicio `anvil`:**
  - imagen de Foundry fijada (`v1.8.3`), con `anvil --host 0.0.0.0 --chain-id 31337`
  - healthcheck con `cast block-number`
  - puerto `127.0.0.1:${ANVIL_PORT:-8545}`
  - `attach: false`: registra cada llamada RPC, unas 2,4 líneas por segundo con el stack quieto, y tapaba los logs de la API en `docker compose up`. Siguen en `docker compose logs anvil`. Es una **decisión del autor**, y el README pasa a pedir Compose 2.20.
- [x] **Servicio `deployer`:**
  - imagen `contracts:build`, one-shot que depende de `anvil` sano
  - corre `forge script script/Deploy.s.sol --broadcast` con la clave de la cuenta 0 de Anvil (pública y conocida, solo local)
  - escribe en el volumen nombrado `deployments`. La imagen crea `deployments/` como usuario `foundry`, así un volumen nuevo toma ese dueño y el deployer escribe sin ser root.
  - **Deploy idempotente.** No estaba previsto: `docker compose up` vuelve a correr el deployer en cada arranque, aunque el stack ya esté corriendo, y `docker compose run` de un servicio que depende de la API también. Un segundo deploy en la misma cadena dejaría a la API indexando el primer contrato. [`script/deploy.sh`](../../contracts/script/deploy.sh) deploya solo si `deployments/31337.json` no describe la cadena, con los mismos chequeos que el guard: el hash del `startBlock` y el código en la dirección del contrato.
- [x] **Servicio `postgres`:**
  - [x] healthcheck con `pg_isready` y `docker/postgres/init.sql`, que crea `escrow_test`: adelantados a la fase 8
  - puerto sin publicar. Compose no puede activar un puerto con una variable, así que no queda "opcional por `.env`": se consulta con `docker compose exec postgres psql -U escrow escrow`. Es una **decisión del autor**; se descartaron un archivo de override activable con `COMPOSE_FILE` y publicarlo siempre.
- [x] **Servicio `api`:**
  - imagen `api:runtime`
  - `depends_on`: `anvil` y `postgres` sanos, y `deployer` con `service_completed_successfully`
  - lee `deployments` (solo lectura), corre las migraciones y arranca, con `RESET_ON_CHAIN_MISMATCH=true`
  - healthcheck contra `/health` con el `fetch` de Node, porque la imagen no tiene curl: cada 2 s, con `start_period` de 60 s
  - puerto `127.0.0.1:${API_PORT:-3000}`. Publicar solo en localhost es una **decisión del autor**: Anvil tiene las cuentas desbloqueadas.
- [x] [`.env.example`](../../.env.example) con los overrides: `API_PORT`, `ANVIL_PORT`, `CONFIRMATIONS`, `BATCH_SIZE`, `POLL_INTERVAL_MS`, `HEALTH_MAX_LAG`, `LOG_LEVEL` y `RESET_ON_CHAIN_MISMATCH`. Compose funciona sin `.env`. Las variables de la API pasan vacías si no se definen, y la API toma su propio default, así no se duplican.
- [x] **Contextos de build y `.dockerignore`:**
  - `contracts:build` copia solo `src/`, `script/` y `test/mocks/MockERC20.sol`, en lugar de todo el proyecto
  - `api`: una etapa `deps` nueva instala las dependencias, y de ella salen `dev` y `build`. `build` copia solo `tsconfig*.json` y `src/`, y `runtime` toma `migrations/` del contexto.
  - con un cambio en los tests, las dos imágenes del stack se reconstruían en 12,6 s (3,8 s y 8,8 s). Ahora salen enteras de cache, en 2,8 s.
  - los `.dockerignore` ya excluían los artefactos (`out/`, `cache/`, `dependencies/`, `node_modules/`, `dist/`) y no hizo falta cambiarlos
- [x] **Resiliencia:**
  - `docker compose up --build` desde cero deja `GET /health` en `ok`
  - `docker compose down` seguido de `up` funciona: deploy nuevo, y la API vacía la base y reindexa
  - `docker compose down -v` deja todo limpio

**Verificación:**
- **Copia limpia:** los archivos versionados más los nuevos, sin los ignorados, con los volúmenes borrados y `docker compose build --no-cache`. El stack queda sano y los cuatro curl del README devuelven lo documentado, también con la imagen de curl.
- **`up` repetido** con el stack corriendo: el deployer corre de nuevo y no deploya. Lo mismo con `docker compose run` de un servicio descartable que depende de `api` sana, como va a ser la demo.
- **`down` y `up`** con un escrow creado: el contrato se deploya de nuevo en la misma dirección, el guard detecta el `startBlockHash` distinto, la API vacía la base y reindexa, y el escrow 1 da `404`.
- **Anvil reiniciado solo:** la API sale con código 1 por `ChainMismatchError`. Un `docker compose up -d` deploya de nuevo y la API se recupera.
- **Postgres detenido:** la API pasa a `unhealthy` a los 5 s sin caerse. Vuelve a `healthy` 1 s después de que vuelve Postgres.
- **Apagado:** `docker compose stop` tarda 0,35 s en `api`, 0,28 s en `anvil` y 0,27 s en `postgres`, todos con código 0, y `down` tarda 0,8 s. Anvil no necesita `init`: como PID 1 atiende SIGTERM.
- **`docker compose up` en primer plano:** ninguna línea de Anvil. Con `Ctrl+C` se detiene todo en orden, y el siguiente `up` arranca una cadena nueva y reindexa.
- **Overrides** con un archivo de entorno descartable: los puertos cambian, `CONFIRMATIONS=2` deja `lag: 1` en `ok` y `LOG_LEVEL=debug` activa los logs de nivel debug. Con `RESET_ON_CHAIN_MISMATCH=false`, cambiar `ANVIL_PORT` recrea Anvil, que arranca una cadena nueva, y la API aborta con el mensaje que indica cómo seguir.
- **`deploy.sh`:** deploya con un `startBlock` que no existe en la cadena o sin código en la dirección del contrato, y no deploya con el archivo que escribió. `shellcheck` no marca nada.
- **Herramientas:** con las imágenes nuevas, `npm test` (79 tests, con el stack corriendo), `npm run lint`, `npm run typecheck` y `forge build` pasan.
- Docker clásico no se probó, porque en esta máquina solo hay Docker rootless. El stack no agrega bind mounts, solo volúmenes nombrados, y el único bind mount, `init.sql`, es de la fase 8. Quedó cubierto en la fase 11: el workflow `e2e` levanta el stack con el Docker clásico del runner de GitHub.

**Hecho cuando:** un clon limpio levanta todo con un solo comando. ✅

**Commits:** `build: cacheable stack images`, `build: compose stack services, healthchecks and documentation`. El plan original tenía `build: api runtime image` y `postgres` entre los servicios nuevos, pero la imagen `runtime` existe desde la fase 0 y `postgres` llegó en la fase 8.

## Fase 10: Script de demo ✅

`docker compose run --rm demo` levanta el stack si hace falta y recorre los cuatro caminos. Desde el stack bajado y sin volúmenes tarda 30 s; con el stack corriendo, 14 s. La salida está en el [README](../../README.md#demo-de-punta-a-punta).

- [x] **`api/scripts/demo.ts`** con viem y las cuentas 0 (sender) y 1 (beneficiary) de Anvil, derivadas del mnemonic por defecto, como en el deploy:
  - approve del total de los cuatro escrows. No hace falta mintear, porque el deploy ya le da 1.000.000 de tokens a cada cuenta.
  - escrow A: crear y confirmar
  - escrow B: crear y rechazar
  - escrow C: crear y cancelar
  - escrow D: crear, `evm_increaseTime` por el `ttl` del archivo de deploy, `evm_mine`, mostrar `ExpiredRecoverable` en la API (con el contrato todavía en `Pending`), `recoverExpired` y mostrar `Expired`
  - montos distintos (100, 200, 300 y 400 MOCK), para seguir los saldos
  - se puede repetir: los ids salen del evento `EscrowCreated`, no se suponen
- [x] **Después de cada paso,** espera a que la API lo refleje, con polling cada 200 ms y un tope de 30 s, y después verifica:
  - la vista completa: estado efectivo y on-chain, las cuatro acciones, sender, beneficiary, token, monto y los hashes de creación y resolución. Si algo difiere, el error lista cada campo distinto.
  - que los fondos lleguen a quien corresponde, por la diferencia de saldo del token
  - imprime una línea por paso, en inglés, como el resto de la salida del proyecto. Las dos cosas son **decisión del autor**, igual que el código sin montar (ver abajo).
- [x] **Confirmaciones.** No estaba previsto: con `CONFIRMATIONS` > 0, la demo mina esa cantidad de bloques después de cada transacción. Con el automine de Anvil no se minan bloques vacíos, así que si no lo hiciera, el indexador no vería nunca la última transacción.
- [x] **Servicio `demo`:**
  - perfil `demo`, imagen `api:dev`, con `npm run --silent demo`
  - `pull_policy: build`: compose reconstruye la imagen en cada `run`, así corre el script actual sin montar `./api` ni instalar nada en el host. Con cache suma 1,6 s. Se descartaron montar `./api`, como el servicio `npm`, y la imagen sin rebuild, que corre código viejo sin avisar.
  - `depends_on: api (service_healthy)`, así `docker compose run --rm demo` levanta el stack si hace falta
  - lee el volumen `deployments` y recibe `CONFIRMATIONS` y `API_PORT`, este último solo para imprimir el curl final
  - termina con código 1 si algún estado no es el esperado, si la API no refleja un paso a tiempo o si falla el arranque. Así sirve como smoke test en CI.

**Verificación:**
- **Desde cero:** con el stack bajado y sin volúmenes, `docker compose run --rm demo` levanta todo, recorre los cuatro caminos y sale con código 0.
- **Repetida** con el stack corriendo: ids 5 a 8, código 0. El curl que imprime al final devuelve los cuatro escrows de la corrida con su estado final.
- **Bugs introducidos a mano en la API**, uno por vez y con la imagen reconstruida en cada caso. La demo sale con código 1 y nombra el campo:
  - `EscrowRejected` proyectado como `Released`: `reject of escrow #15: status is "Released", expected "Rejected"; onchainStatus is "Released", expected "Rejected"`
  - sin `ExpiredRecoverable` derivado: `expiry of escrow #19: status is "Pending", expected "ExpiredRecoverable"`
  - `canRecover` sin chequear el vencimiento: `create of escrow #20: canRecover is true, expected false`
- **Indexador detenido**, con `POLL_INTERVAL_MS=600000`: `The API did not reflect the creation of escrow #13 within 30 s. Last answer: 404`, con código 1. El primer intento pasó sin error, porque `docker compose run` recreó la API con la configuración por defecto: la variable tiene que estar también en el `run`.
- **`CONFIRMATIONS=2`:** pasa, con la API indexando 2 bloques detrás. Con la API en 2 y la demo en 0, se agota la espera: el minado extra es necesario.
- **Errores de arranque:** un archivo de deploy inexistente y una URL inválida terminan con `Demo failed` y código 1, sin stack trace.
- `npm run typecheck` y `npm run lint` pasan, y `scripts/` está incluido en los dos.

**Hecho cuando:** `docker compose run --rm demo` muestra los 4 estados finales y el estado derivado de vencimiento, y sale con código 0. ✅

**Commits:** `feat: end-to-end demo with compose service and documentation`.

## Fase 11: CI ✅

Los workflows **no instalan Node ni Foundry**: corren los mismos `docker compose` del README, así lo que pasa en CI pasa en cualquier máquina con Docker. El diseño está en [DESIGN](DESIGN.md#ejecución-y-tests).

- [x] **`.github/workflows/contracts.yml`:**
  - `docker compose build forge slither`, sin cache de capas: es el mismo comando que en una máquina limpia, y las tres imágenes de herramientas tardan 30 s sin cache. Se descartó el cache `type=gha` con `docker buildx bake`. Es una **decisión del autor**.
  - `run --rm forge fmt --check`
  - `run --rm -e FOUNDRY_PROFILE=ci forge test`
  - `run --rm forge snapshot --check`
  - `run --rm -e FORGE_SNAPSHOT_CHECK=true forge test --match-contract EscrowGasTest` (gas por operación)
  - `run --rm slither`
- [x] **`.github/workflows/api.yml`:**
  - `run --rm npm run lint`
  - `run --rm npm run typecheck`
  - `run --rm npm test`
  - chequeo de desincronización del ABI generado (fase 5): `run --rm forge build`, `run --rm npm run abi`, `git diff --exit-code api/src/generated`
- [x] **`.github/workflows/e2e.yml`:** `docker compose up -d --build --wait`, `docker compose run --rm demo` y `docker compose down -v`, este último siempre. Si algo falla, imprime los logs de todo el stack.
- [x] **Común a los tres:**
  - corren en cada push a `main` y en cada pull request, sin filtros de paths. Es una **decisión del autor**; se descartaron ignorar los cambios solo de documentación y filtrar por carpeta.
  - en un pull request, un push nuevo cancela la corrida anterior; en `main`, cada commit conserva su resultado
  - runner `ubuntu-24.04` fijado, `timeout-minutes: 20` e impresión de la versión de Compose
  - `permissions: contents: read`, `actions/checkout` v7.0.1 fijada por SHA (publicada el 20/07/2026, con más de dos semanas, como el resto de las versiones) y `persist-credentials: false`
- [x] **Badges** de los tres workflows en el README. No estaban previstos; es una **decisión del autor**.

**Verificación local**, con los mismos comandos sobre una copia limpia de los archivos versionados y las imágenes construidas sin cache:

| Paso | Tiempo |
| --- | --- |
| Build de `forge`, `slither` y `npm` sin cache | 30 s |
| `forge fmt --check` | 3,5 s |
| `forge test` con el perfil `ci` | 64 s |
| `forge snapshot --check` | 10 s |
| Gas por operación | 0,7 s |
| Slither, con 0 hallazgos | 1,3 s |
| `npm run lint`, `typecheck` y `test` | 12, 4 y 14 s |
| `forge build` y `npm run abi`: el archivo sale idéntico al versionado | 3 s |
| `up -d --build --wait` y la demo | 14 y 13 s |

- **Los chequeos fallan cuando deben:** con una sola unidad de gas cambiada en `.gas-snapshot` o en `snapshots/EscrowGasTest.json`, `snapshot --check` y `FORGE_SNAPSHOT_CHECK` salen con código 1. La demo ya se había probado con bugs en la fase 10, y Slither con un hallazgo en la fase 4.
- **`actionlint`:** 0 errores en los tres workflows.

**Verificación en GitHub:** el primer push con los workflows (`b4c50e3`) dejó los tres en verde, y los badges del README dicen *passing*.

| Workflow | Total | Pasos más largos |
| --- | --- | --- |
| `contracts` | 2 min 25 s | `forge test` con el perfil `ci` 99 s, build 23 s, `snapshot --check` 15 s |
| `api` | 1 min 19 s | build 31 s, lint 24 s, tests 10 s |
| `e2e` | 1 min 3 s | `up --build --wait` 41 s, demo 18 s |

- Los tres corren en paralelo, así que un push queda verificado en unos 2 min 30 s.
- El runner usa Docker clásico, y el código montado tiene otro dueño que en la máquina de desarrollo. Los pasos que escriben sobre él (`forge build`, la instalación de dependencias y `npm run abi`) pasaron sin ajustes.
- Ningún job dejó anotaciones de advertencia, como las de una acción con un runtime de Node deprecado.
- Los logs de los jobs no se pueden leer sin un token con permisos de admin, ni siquiera en un repo público. Los tiempos salen de la API pública de jobs.

**Hecho cuando:** los workflows están en verde en `main`. ✅

**Commits:** `ci: contracts, api and e2e workflows with documentation`.

## Fase 12: Cierre y entrega

- [x] **Verificación en un host solo con Docker:** Debian 13 en WSL recién instalado, con Docker 29.9.1 rootless y Compose v5.6.0. Sin Node, npm, Foundry, solc ni `jq`; Python 3 viene con Debian y no se usa. Docker arrancó sin imágenes, volúmenes ni contenedores.
  - `git clone` desde GitHub, en `fcce2ab`
  - `docker compose up --build`: el stack queda sano en 51 s, incluidas la descarga de las imágenes base y el build. Las únicas advertencias son de la inicialización de Postgres (locales y `trust` local), propias de la imagen.
  - los cuatro curl del README devuelven lo documentado, también con la imagen `curlimages/curl`, que con Docker rootless funciona igual
  - `docker compose run --rm demo` con el stack corriendo: los cuatro caminos y código 0, en 19 s con el build de `api:dev`. El curl que imprime al final devuelve los cuatro escrows con su estado final.
  - `Ctrl+C` en `up` detiene todo en 0,6 s, cada contenedor con código 0
  - los 13 comandos de la sección *Pruebas*, en el orden del README y con las imágenes de herramientas sin construir, salen con código 0:

    | Comando | Tiempo | Resultado |
    | --- | --- | --- |
    | `forge test -vvv`, con el build de `contracts:deps` | 15 s | 79 tests |
    | `forge test` con el perfil `ci` | 49 s | 79 tests |
    | `forge snapshot --check` | 8 s | sin cambios |
    | gas report | 0,6 s | |
    | `forge coverage` | 17 s | 100 % en `Escrow.sol` |
    | `forge fmt --check` | 0,5 s | |
    | `slither`, con el build de su imagen | 24 s | 0 hallazgos |
    | `npm test` | 15 s | 79 tests |
    | `npm run lint` y `typecheck` | 6 y 4 s | |
    | `forge build`, `npm run abi` y `git diff --exit-code api/src/generated` | 2 s | sin diff |

  - todos los archivos generados en el clon (`out/`, `cache/`, `dependencies/`, `node_modules/`) quedan del usuario del host, y `docker compose down -v` no deja contenedores ni volúmenes
- [x] **`forge coverage` ensucia el árbol.** Hallazgo de la verificación: coverage compila sin optimizador y reescribe `contracts/snapshots/EscrowGasTest.json` con esos valores, entre 1.537 y 4.062 de gas más por operación. El siguiente `forge test` lo restaura, pero en el orden del README coverage va después de los chequeos de gas, así que el clon termina con un archivo versionado modificado. CI no corre coverage, por eso no apareció antes.
  - **Corrección:** `EscrowGasTest` escribe el snapshot con un helper, `_snapshotGas`, que no hace nada si `vm.isContext(VmSafe.ForgeContext.Coverage)`.
  - **El gas medido no cambia:** la consulta va antes de `snapshotGasLastFrame` pero no cuenta como último frame, y `EscrowGasTest.json` sale idéntico.
  - **`.gas-snapshot` sí cambia:** mide cada función de test completa, así que los 7 tests del benchmark suben entre 713 y 724. Se regeneró; el resto de los tests no se movió.
  - **Verificación:** con un valor del JSON alterado a mano, `forge coverage` lo deja como está y `forge test` lo restaura. `forge snapshot --check`, `FORGE_SNAPSHOT_CHECK=true`, `fmt --check`, el perfil `ci` y Slither pasan, y coverage sigue en 100 % en `Escrow.sol`.
- [ ] **Detalles para el README final**, de la misma verificación:
  - la salida de la demo empieza con 5 líneas de encabezado (API, cadena, contratos y cuentas) que el README no muestra
  - el cuarto curl (`ExpiredRecoverable`) da una lista vacía después de la demo, porque la demo recupera el escrow D
  - `curlimages/curl` va sin versión fijada, a diferencia del resto de las imágenes
- [ ] **Revisión de seguridad del contrato contra el checklist:**
  - reentrancy y CEI
  - control de acceso por acción
  - tokens sin `bool`, con fee, con hooks y con blacklist
  - ninguna ruta para bloquear o robar fondos
  - sin owner
  - overflow de `uint64` en timestamps (irrelevante en la práctica, pero mencionarlo)
- [ ] **Revisión de correctitud:** recorrer la tabla de reglas del enunciado y confirmar que cada fila tiene implementación y test.
- [ ] **README final:**
  - comandos reales verificados
  - curl de ejemplo con output real
  - quitar la nota de estado
  - **resumen de las decisiones de diseño:** una sección que puntee todas las decisiones, una línea cada una, con vínculo a su desarrollo completo en [DESIGN](DESIGN.md). Cubre lo que pide el enunciado (decisiones, supuestos, mejoras) sin volver abrumador al README: el detalle técnico se queda en DESIGN.
- [ ] **`docs/ai/` completo:** prompts relevantes, outputs y una breve nota de qué se aceptó, qué se cambió y por qué.
- [ ] **Releer `CHALLENGE.md`** como checklist final de entregables.
- [ ] **Push a GitHub** y dar acceso a los evaluadores.
- [ ] **Preparar la sesión de 45-60 minutos:** decisiones y trade-offs, limitaciones conocidas, y alternativas (pull contra push, reorgs por `blockHash`, permit).

---

## Checklist de entregables del enunciado

| Entregable | Fase |
| --- | --- |
| Código del contrato y tests | 1, 2, 3 |
| Código de la API y tests (procesamiento de eventos) | 6, 7, 8 |
| Comando o docker-compose con nodo, deploy, DB y API | 9 |
| Script de flujo completo (confirmar, rechazar, cancelar, vencer) | 10 |
| README (cómo correrlo, curl) y DESIGN (decisiones, supuestos, mejoras) | 12 (base ya escrita) |
| Historial de commits que muestre el avance | todas |
| Outputs de prompts de IA | 0, 12 |

## Mapeo con los criterios de evaluación

| Criterio | Peso | Fases |
| --- | --- | --- |
| Seguridad del contrato | 30 % | 1, 2 (tokens no estándar, reentrancy), 3, 4 (Slither), 12 |
| Corrección de la lógica | 20 % | 1, 2 (límites de tiempo, matriz de estados) |
| Tests | 20 % | 2, 3, 8 |
| API e indexador | 15 % | 6, 7, 8 |
| Calidad y documentación (incluye "facilidad para correrlo") | 15 % | 0, 4, 9, 10, 11, 12 |

## Fuera de alcance (posibles extensiones)

Ver *Qué mejoraría con más tiempo* en [DESIGN](DESIGN.md#qué-mejoraría-con-más-tiempo): patrón pull, rollback de reorgs por `blockHash`, `createWithPermit`, webhooks o SSE, deploy en Sepolia, paginación por cursor, métricas.
