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

**Output:** [`ROADMAP.md`](../../ROADMAP.md), con 13 fases, criterios de "hecho" y commits sugeridos.

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
