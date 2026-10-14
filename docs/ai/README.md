# Uso de IA: prompts y outputs

El enunciado pide "incluir outputs de prompts". Este proyecto se desarrolla con **Claude Code** (modelo Claude Opus 5.5). Acá quedan los prompts en el orden en que se dieron, con un resumen de lo que produjo cada uno y qué se decidió.

Los outputs largos están en archivos aparte. Los artefactos en sí (README, ROADMAP, código) están en el repo y su historia queda en los commits.

## 1. Transcripción del enunciado

> genera CHALLENGE.md a partir del pdf

**Output:** [`CHALLENGE.md`](../../CHALLENGE.md), una transcripción literal del PDF a Markdown.
- Las tablas se pasaron a tablas Markdown.
- El diagrama de estados se pasó a Mermaid.

## 2. Análisis del enunciado

> busca inconsistencias, errores y ambiguedades en la definición de CHALLENGE.md

**Output:** [`01-analisis-ambiguedades.md`](01-analisis-ambiguedades.md). Son unos 30 puntos con una decisión sugerida para cada uno.

## 3. Decisiones y README

> haceme las preguntas y volcá todo en el README.md

La IA hizo 8 preguntas de diseño. Respuestas del autor:

| Pregunta | Respuesta |
| --- | --- |
| Límites exactos de tiempo | Estricto: `t < +2h`, `t < +7d`, recuperar con `t >= +7d` |
| Tokens fee-on-transfer | Registrar el monto recibido |
| Movimiento de fondos | Push |
| Beneficiario entre 0 y 2 h | Puede actuar, según la tabla |
| Reorgs | N confirmaciones |
| Base de datos | Postgres |
| Tooling | Foundry + viem |
| Opcionales | Fuzz e invariantes, fee-on-transfer, Slither + CI, gas report y optimización de storage (agregado por el autor) |

**Output:** [`README.md`](../../README.md) con el diseño completo y la tabla de decisiones. Las decisiones menores que tomó la IA quedaron marcadas para revisión, por ejemplo: sin owner, ids desde 1, `ExpiredRecoverable`, reloj de cadena y `EscrowHasExpired`.

## 4. Roadmap

> crea ROADMAP.md con la ruta de desarrollo completo

**Output:** [`ROADMAP.md`](ROADMAP.md), con 13 fases, criterios de "hecho" y commits sugeridos.

## 5. Ajustes de stack

> yo me encargo de los commit, quiero que usemos solidity 0.8.37 y configuremos evm_version = "cancun"

**Output:** versión del compilador y EVM actualizadas en el README y el ROADMAP. La IA no hace commits.

## 6. Solo Docker

> el repo tiene que poder clonarse y ejecutarse completo con Docker, asumamos la ausencia de Node, Foundry, etc

**Output:** README y ROADMAP rediseñados para que el único requisito sea Docker:
- servicios de herramientas en compose (`forge`, `npm`, `slither`, `demo`)
- Soldeer en lugar de submódulos
- guard de cambio de cadena en el indexador
- CI con los mismos comandos

## 7. Fase 0

> vamos con la fase 0

**Output:** setup dockerizado: Dockerfiles, entrypoints, compose, scaffolding de `contracts/` y `api/`. Hallazgos durante la implementación:

- **Versiones.** Se fijaron versiones publicadas hace al menos unas semanas: Foundry `v1.8.3`, forge-std `1.16.2`, OpenZeppelin `5.7.0`. Los paquetes npm se resolvieron con `--before=2026-09-29`, para reducir el riesgo de supply chain con releases de pocos días.
- **Docker rootless.** La máquina de desarrollo usa Docker rootless: el uid 1000 del host es el root del contenedor. En vez de fijar un `user:` en compose, que se rompe en uno de los dos modos, los entrypoints detectan el dueño del código montado y bajan a ese uid con `setpriv`. Se probaron ambos caminos.
- **Dependencias en el host.** `node_modules/` y `dependencies/` se instalan sobre el bind mount, ignorados por git, en lugar de en volúmenes nombrados. Un volumen anidado dentro de un bind mount deja en el host directorios vacíos de root con Docker clásico.
- **esbuild.** npm 11 bloquea los scripts de instalación no aprobados: se aprobó `esbuild` explícitamente (`allowScripts`).

## 8. Fase 1: tipos

> vamos con la fase 1, con la definición de tipos y revisamos

**Output:** `contracts/src/IEscrow.sol`, con tipos, eventos, errores y firmas, y la propuesta de layout de storage. Revisión del autor:
- **Token:** se mantiene como `address`, según la interfaz pedida.
- **Eventos de resolución:** se quedan solo con `id`, para trabajar más en el indexador y no gastar gas.
- **Timestamps:** `uint64` está bien.

## 9. Fase 1: implementación

> sobre lo que hay que revisar: el tipo del token lo dejamos con la interfaz pedida en la definición. sobre agregar información al evento de resolución, lo dejamos con id, trabajamos más en indexador pero no gastamos más gas. uint64 está bien para los timestamps. Actualizá y seguimos con la implementación

**Output:** `contracts/src/Escrow.sol`. Decisiones de la IA, documentadas en el README:
- **`ReentrancyGuardTransient` en lugar de `ReentrancyGuard`:** con target Cancun usa transient storage y es más barato.
- **Orden al resolver:** estado, evento y después transferencia.
- **`createEscrow`:** transfiere antes de escribir, para medir lo recibido, protegida por `nonReentrant`.
- **`block-timestamp`:** se excluye del lint con una justificación.

Una prueba descartable verificó el flujo básico antes de pasar a la fase 2.

## 10. Revisión de la implementación, punto por punto

> antes de seguir vamos con los puntos de implementación uno por uno

1. **Orden CEI al resolver:** aprobado.
2. **`createEscrow` transfiere antes de escribir** (para medir lo recibido) protegida por `nonReentrant`: aprobado. En la fase 2 se testea el ataque de reentrada con ERC-777.
3. **`ReentrancyGuardTransient`:** aprobado. Se midió el ahorro (+502 contra +5.207 de gas por llamada) y quedó documentado en el README.
4. **Validación `token.code.length`.** **Corrección de un error de la IA:** el comentario original afirmaba que `SafeERC20` aceptaría un EOA como token. Es falso.
   - OZ 5.7 exige `extcodesize(token) > 0` cuando la llamada no devuelve datos, y revierte con `SafeERC20FailedOperation`. El autor ya lo había notado.
   - Se verificó con un test descartable y se corrigió el comentario.
   - El chequeo se mantiene porque da un error claro: sin él, el `balanceOf` previo revierte sin motivo.

   El autor pidió además anotar como pendiente un owner que pueda pausar la creación de escrows y mantener una whitelist de tokens. Quedó en *Pendientes decididos* del ROADMAP.
5. **Reparto de chequeos entre helpers.** La IA propuso tres opciones: A (dejarlo como estaba), B (helpers por parte, con el tiempo inline) y C (todo inline). Recomendó B.
   - **El autor eligió C:** por ser un contrato simple, prefiere maximizar la lectura a primera vista.
   - Se eliminó `_loadPendingForBeneficiary`. Solo queda `_loadPending` (existencia y `Pending`), y cada acción muestra sus chequeos de quién llama y de tiempo.
   - Costo: +156 B de bytecode y el mismo gas.
6. **Avisos del lint:** aprobado como estaba. `unsafe-typecast` se desactiva solo en esa línea y con justificación. `block-timestamp` se excluye en todo el proyecto, porque las ventanas de tiempo son la lógica del contrato. En la fase 4 se aplica el mismo criterio al detector `timestamp` de Slither.
7. **Tope de `ttl` en el constructor.** La IA presentó tres opciones: A (sin tope), B (`MAX_TTL`) y C (constantes en lugar de `immutable`), y recomendó A.
   - **El autor descartó C:** no poder hacer una demo en testnet con ventanas cortas no es aceptable.
   - Se mantiene A, con el análisis documentado en el README: el overflow solo bloquea la creación y nunca los escrows existentes, y `TTL()` es público.

## 11. Fase 2: tests del contrato

> vamos con la fase 2

**Output:** 61 tests en 4 suites, con 7 mocks y una base común. Cobertura del 100 % en `Escrow.sol`.

**Verificación por mutaciones.** Como todos los tests pasaron al primer intento, la IA introdujo 10 bugs a mano para comprobar que la suite los detecta. Detectó los 10.
- **Una mutación expuso un test débil.** Al quitar `nonReentrant` de `createEscrow`, el test de reentrada fallaba por falta de allowance y no por el ataque.
- **Se reescribió con un contrato atacante** que es el sender y reentra desde el hook, como en ERC-777. Así reproduce el doble conteo real: registra 300 por 200 depositados sin el guard.
- **Otra mutación mostró defensa en profundidad:** sin guard en `confirm`, la reentrada igual falla por CEI (`NotPending`).

## 12. Fase 3: fuzz e invariantes

> vamos con la fase 3

**Output:** 10 fuzz unitarios y una suite de 5 invariantes sobre un handler con modelo de referencia. En total quedan 72 tests en verde, con el perfil por defecto y con el `ci`.

- **Modelo de referencia en el handler.** En lugar de solo acumular *ghost variables*, el handler predice el resultado de cada resolución (éxito o el error exacto) a partir de las reglas de `IEscrow` y lo compara con el contrato. Por eso se cambió `fail_on_revert` a `true` en `foundry.toml`, que en la fase 0 había quedado en `false`.
- **Primer ajuste por cobertura.** En la primera versión, la mayoría de las resoluciones apuntaban a ids ya resueltos o caían fuera de la ventana, y había entre 0 y 3 éxitos por acción en cada run. Se sesgó la elección de ids hacia escrows pendientes (3 de cada 4 llamadas) y se acortaron los `warp` a 1 día como máximo. Ahora casi todos los escrows creados en cada run terminan resueltos. El techo es la cantidad de creaciones, porque Foundry elige los selectores de forma uniforme.
- **Límites exactos.** Los `warp` aleatorios casi nunca caen en un deadline, así que se agregó `warpToDeadline` (−1 s, exacto o +1 s). Con eso, la suite de invariantes sola detecta los tres errores de comparación (`>=` por `>`, `<` por `<=`).
- **Verificación por mutaciones.** Se introdujeron 10 bugs, uno por vez, corriendo solo la suite de invariantes, y los 10 la hicieron fallar. El detalle está en el ROADMAP, fase 3.
- **Invariante más fuerte que el pedido.** Además de `balanceOf >= Σ pendientes` (decisión 8 del README), se verifica la contabilidad exacta con donaciones: `balanceOf == depositado − pagado + donado`.

## 13. Fase 4: gas y Slither

> implementá la fase 4: reporte de gas y Slither

**Output:** benchmark de gas con snapshots, `.gas-snapshot`, `docs/gas.md`, imagen y servicio de Slither, y `docs/slither.md`. El contrato solo cambió en un comentario de Slither.

- **Gas verificado contra una cadena.** Antes de documentar los números del benchmark, la IA mandó las mismas transacciones a Anvil y comparó el `gasUsed` de los recibos: coinciden exactamente. La única diferencia, en `recoverExpired`, se explicó por un refund de 4.800 (en Anvil era el último escrow del contrato).
- **Optimizaciones medidas, no aplicadas.** Se midieron 7 variantes sobre una copia del contrato. Ninguna se aplicó, porque el contrato ya estaba revisado punto por punto. Las dos que podrían valer la pena (`via_ir` y `unchecked`) se le presentaron al autor, que las descartó: "no vale la pena aplicar esos cambios".
- **Versiones de Slither.** `pip freeze` traía dependencias publicadas después del 29/09/2026. Se re-resolvieron con `uv --exclude-newer` y se fijaron con hashes. Por el mismo criterio, se usó Python 3.12.14 y no 3.12.15 (publicado el 01/10/2026).
- **Efecto colateral evitado.** crytic-compile corre `forge clean` y `--force` sobre el proyecto. Se redirigieron sus artefactos dentro del contenedor para no borrar el `out/` y el `cache/` del servicio `forge`.
- **Limitación de Slither descubierta con una prueba de cordura.** Con una reentrada inyectada en `confirm`, Slither reportó 0 hallazgos. La IA verificó la causa: OZ 5.7 hace la llamada de `safeTransfer` en assembly, y Slither no la ve. Con `transfer` directo, sí la detecta. Quedó documentado que el "0 hallazgos" de Slither no cubre reentrada en este contrato.
- **Deprecación detectada.** `vm.snapshotGasLastCall` emitía un aviso: está reemplazado por `vm.snapshotGasLastFrame`. Se cambió y los valores no se movieron.

## 14. Fase 5: deploy y ABI

> no vale la pena aplicar esos cambios, seguí con la fase 5

El autor descartó `via_ir` y `unchecked`, y quedó registrado en `docs/gas.md` y el ROADMAP.

**Output:** `script/Deploy.s.sol`, el archivo `deployments/<chainId>.json`, `npm run abi` y `api/src/generated/contracts.ts`.

- **Hash del bloque inicial.** Antes de escribir el script, la IA comprobó en Anvil qué ve un `forge script`. `block.number` es el último bloque minado y `blockhash(block.number)` devuelve cero. Se probaron `vm.rpcJson` y `keccak256(vm.getRawBlockHeader(n))`: los dos dan el hash real, incluso en el bloque 0, y se eligió el segundo por simple. Esto evita leer los recibos del broadcast en un segundo paso.
- **Ventanas por variables de entorno.** El script ya sirve para la demo en Sepolia de *Pendientes decididos*, sin cambios.
- **Mount de solo lectura.** Para que `npm run abi` lea los artefactos se monta `./contracts` completo y no `./contracts/out`. Si `out/` no existiera, Docker crearía la carpeta como root y rompería `forge build` en Docker clásico.
- **Reproducibilidad del ABI.** Se verificó que el archivo generado no cambia después de `forge clean` + `build`, de `forge coverage` y de Slither, que es la condición para que el chequeo de CI no dé falsos positivos.
- **Tipado.** Con un archivo descartable se comprobó que viem infiere los tipos de `decodeEventLog` y `encodeFunctionData` desde el ABI generado, y que rechaza una función inexistente.


## 15. Resumen de avances

> resume lo que hicimos hasta ahora en el proyecto

**Output:** resumen del estado al cierre del día 1: fases 0 a 5 terminadas, lo que falta (fases 6 a 12 y los pendientes decididos) y los cambios sin commitear.

> bajame este reporte completo a docs/ai/avances/dia1.md

**Output:** [`avances/dia1.md`](avances/dia1.md), con el mismo resumen fechado y adaptado como documento.

> sí, agregá la entrada 15 al README de docs/ai y mantengamos registrando todos los prompts como venimos haciendo

**Output:** esta entrada. Desde acá, cada prompt se registra en este archivo junto con su resultado.

## 16. Separar el README del diseño

> vamos a sacar las decisiones de diseño del README.md y movela a docs/ai/DESIGN.md, también move el ROADMAP.md a docs/ia/ROADMAP.md y corregí el vínculo entre ambos. README.md de la carpeta raíz sólo debe tener información descriptiva breve del proyecto, los requisitos para ejecutarlo y los pasos para correr cada prueba

**Output:** se interpretó `docs/ia/` como `docs/ai/`, la carpeta existente.
- [`DESIGN.md`](DESIGN.md): todo el diseño que estaba en el README, sin cambios de contenido. Incluye arquitectura, versiones fijadas, servicios de compose, detalles de ejecución, contrato, API e indexador, decisiones, limitaciones, opcionales y mejoras.
- [`ROADMAP.md`](ROADMAP.md): movido desde la raíz, con los vínculos a DESIGN, README y CHALLENGE corregidos.
- [`README.md`](../../README.md): descripción breve, tabla de documentación, requisitos, cómo levantar el stack y los comandos de cada prueba (contrato, Slither, API, ABI, demo y curl).
- Se actualizaron las referencias en `docs/gas.md`, `docs/slither.md`, `01-analisis-ambiguedades.md`, `avances/dia1.md` y un comentario de `EscrowTokens.t.sol`. Un chequeo automático confirmó que no quedan vínculos ni anclas rotos.

## 17. Resumen de decisiones en el README final

> anotemos para recordar hacer una versión final del README.md al terminar con el proyecto con una versión resumida de las decisiones de diseño. Si dejamos todo el detalle técnico completo en el README.md principal se vuelve muy abrumador. Propongo, para cuando terminemos, que el README.md principal puntee todas las decisiones de diseño pero haga referencia a la versión completa y desarrollada en DESIGN.md.

**Output:** tarea agregada en la fase 12 del [ROADMAP](ROADMAP.md), dentro de *README final*. El README va a puntear todas las decisiones, una línea cada una, con vínculo a su desarrollo en [DESIGN](DESIGN.md). Así cumple con lo que pide el enunciado sin cargarlo con el detalle técnico.
