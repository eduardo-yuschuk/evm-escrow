# Uso de IA: prompts y outputs

El enunciado pide "incluir outputs de prompts". Este proyecto se desarrolla con **Claude Code** (modelo Claude Opus 5.5). Acá quedan los prompts en el orden en que se dieron, con un resumen de lo que produjo cada uno y qué se decidió.

Los outputs largos están en archivos aparte. Los artefactos en sí (README, ROADMAP, código) están en el repo y su historia queda en los commits.

## Qué se aceptó, qué se cambió y por qué

Resumen de todo el log. El número entre paréntesis es la entrada.

**Lo que decidió el autor, y no la IA:**
- **El stack y el alcance:** Solidity 0.8.37 con `evm_version = "cancun"` (5), solo Docker como requisito del host (6), el gas report y la optimización de storage como opcional (3), y la demo en Sepolia, que la IA proponía dejar como mejora (29).
- **Contra la recomendación de la IA:**
  - chequeos inline en cada acción, en lugar de helpers por parte, para leer el contrato de un vistazo (10)
  - ventanas `immutable` y no constantes, para poder hacer la demo en Sepolia (10)
  - descartar `via_ir` y `unchecked`, por un ahorro de gas menor al 2 % (14)
- **Interfaz:** el token se mantiene como `address`, los eventos de resolución solo con `id` y timestamps `uint64` (8, 9).
- **Documentación:** separar el diseño del README (16), y que el README final resuma cada decisión en una línea con vínculo a DESIGN (17). El enunciado queda fuera del repo y el material de la sesión también (29).

**Lo que propuso la IA y el autor aceptó:**
- **Contrato:** `ReentrancyGuardTransient`, el orden CEI al resolver y `createEscrow` midiendo lo recibido bajo el guard (10).
- **Opciones recomendadas en cada cuestionario:** logs de Anvil fuera de `up`, puertos solo en `127.0.0.1` y Postgres sin publicar (22); la imagen de la demo reconstruida en cada `run` (23); CI sin cache ni filtros de paths, con badges (24); validación estricta del listado y el umbral de `/health` (20).
- **Cierre:** coverage sin reescribir el snapshot de gas (28) y el owner limitado como mejora en lugar de implementarlo (29).

**Errores de la IA, corregidos:**
- Un comentario afirmaba que `SafeERC20` aceptaría un EOA como token. Es falso, y el autor ya lo había notado (10).
- Un test de reentrada pasaba por falta de allowance y no por el ataque. Lo expuso una mutación, y se reescribió con un contrato atacante (11).
- La primera versión del handler de invariantes casi no tenía resoluciones exitosas (12).
- `/health` recortaba el lag a 0, y no detectaba un Anvil reiniciado (19).
- Los ejemplos curl tenían direcciones abreviadas que la API rechaza (19).
- Con Postgres pausado, una request colgaba más de 3 minutos (20).
- Una prueba de la demo pasó sin error por una trampa de compose (23).
- `forge coverage` dejaba modificado un archivo versionado (27, 28).

**Cómo se verificó lo que generó la IA:**
- **Mutaciones a mano:** 10 bugs en el contrato (11), 10 solo contra los invariantes (12), 19 en la API (21) y 3 contra la demo (23). Todos detectados.
- **Contra una cadena real:** el gas, contra recibos de Anvil (13), y el indexador y la API, contra Anvil y Postgres antes de tener tests (18, 19).
- **Pruebas descartables antes de afirmar algo,** por ejemplo:
  - lo que no ve Slither (13)
  - el hash del bloque inicial (14)
  - el fallback de timestamps (18)
  - las limitaciones nuevas de la revisión de seguridad (29)
- **Desde cero:** un clon en un host con solo Docker (27) y CI en GitHub (25).

## 1. Transcripción del enunciado

> genera CHALLENGE.md a partir del pdf

**Output:** `CHALLENGE.md`, una transcripción literal del PDF a Markdown. Por decisión del autor queda fuera del repo (entrada 29); cada regla está transcripta en [`docs/correctness.md`](../correctness.md).
- Las tablas se pasaron a tablas Markdown.
- El diagrama de estados se pasó a Mermaid.

## 2. Análisis del enunciado

> busca inconsistencias, errores y ambiguedades en la definición de CHALLENGE.md

**Output:** [`01-ambiguity-analysis.md`](01-ambiguity-analysis.md). Son unos 30 puntos con una decisión sugerida para cada uno.

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

**Output:** [`progress/day1.md`](progress/day1.md), con el mismo resumen fechado y adaptado como documento.

> sí, agregá la entrada 15 al README de docs/ai y mantengamos registrando todos los prompts como venimos haciendo

**Output:** esta entrada. Desde acá, cada prompt se registra en este archivo junto con su resultado.

## 16. Separar el README del diseño

> vamos a sacar las decisiones de diseño del README.md y movela a docs/ai/DESIGN.md, también move el ROADMAP.md a docs/ia/ROADMAP.md y corregí el vínculo entre ambos. README.md de la carpeta raíz sólo debe tener información descriptiva breve del proyecto, los requisitos para ejecutarlo y los pasos para correr cada prueba

**Output:** se interpretó `docs/ia/` como `docs/ai/`, la carpeta existente.
- [`DESIGN.md`](DESIGN.md): todo el diseño que estaba en el README, sin cambios de contenido. Incluye arquitectura, versiones fijadas, servicios de compose, detalles de ejecución, contrato, API e indexador, decisiones, limitaciones, opcionales y mejoras.
- [`ROADMAP.md`](ROADMAP.md): movido desde la raíz, con los vínculos a DESIGN, README y CHALLENGE corregidos.
- [`README.md`](../../README.md): descripción breve, tabla de documentación, requisitos, cómo levantar el stack y los comandos de cada prueba (contrato, Slither, API, ABI, demo y curl).
- Se actualizaron las referencias en `docs/gas.md`, `docs/slither.md`, `01-ambiguity-analysis.md`, `progress/day1.md` y un comentario de `EscrowTokens.t.sol`. Un chequeo automático confirmó que no quedan vínculos ni anclas rotos.

## 17. Resumen de decisiones en el README final

> anotemos para recordar hacer una versión final del README.md al terminar con el proyecto con una versión resumida de las decisiones de diseño. Si dejamos todo el detalle técnico completo en el README.md principal se vuelve muy abrumador. Propongo, para cuando terminemos, que el README.md principal puntee todas las decisiones de diseño pero haga referencia a la versión completa y desarrollada en DESIGN.md.

**Output:** tarea agregada en la fase 12 del [ROADMAP](ROADMAP.md), dentro de *README final*. El README va a puntear todas las decisiones, una línea cada una, con vínculo a su desarrollo en [DESIGN](DESIGN.md). Así cumple con lo que pide el enunciado sin cargarlo con el detalle técnico.

## 18. Fase 6: indexador

> sigamos con la fase 6

**Output:** configuración, migraciones, proyector, loop con checkpoint y guard de cadena en `api/src/`, más `api/migrations/0001_initial.sql`. El detalle está en el [ROADMAP](ROADMAP.md), fase 6, y el diseño en [DESIGN](DESIGN.md#indexador).

- **Verificación contra una cadena real.** Los tests automatizados son de la fase 8. Mientras tanto, la IA verificó contra Anvil y Postgres con un override de compose descartable: los cuatro caminos, varios eventos en un mismo bloque, reinicio, reproceso del rango, `kill -9` a mitad de una puesta al día y caídas de Postgres y del RPC. En cada caso comparó dumps de la DB.
- **Guard en dos pasos.** El ROADMAP preveía comparar la DB con la cadena. Se agregó un chequeo previo del archivo de deploy contra la cadena. Si Anvil se reinicia sin volver a deployar, la DB y el archivo coinciden entre sí pero no con la cadena, y sin ese chequeo el indexador se habría quedado esperando para siempre.
- **Logs descartados en silencio.** `getLogs` de viem, en modo estricto, descarta sin avisar los logs que no puede decodificar. Se pide `eth_getLogs` directo y se decodifica con `decodeEventLog`, que en ese caso falla.
- **Reintentos ocultos.** Con el RPC congelado, la primera prueba no mostró ningún error en 14 s: viem reintentaba 3 veces con 10 s de timeout cada una. Se apagaron sus reintentos para dejar una sola capa, la del indexador, con un log por fallo.
- **Apagado con el RPC colgado.** Un SIGTERM en ese estado tardaba 9 s, al borde del SIGKILL de `docker compose stop`. Ahora se cancelan las requests en curso, sin perder el timeout de viem, y sale en 0,14 s.
- **Prueba del mismo bloque.** En el primer intento, con automine apagado, se perdieron dos de tres transacciones porque cada `cast` calculaba el mismo nonce. Se repitió con nonces explícitos.
- **Fallback de timestamps.** Anvil incluye `blockTimestamp` en los logs, así que el camino alternativo con `getBlock` no se ejercitaba. Un script descartable le sacó el campo a la respuesta y comprobó que da los mismos timestamps, con un `getBlock` por bloque.

## 19. Fase 7: API HTTP

> sigamos con la fase 7

**Output:** reloj de cadena, `toView`, `GET /escrows/:id`, `GET /escrows`, `GET /health` y el flag `MODE` para correr el indexador, la API o los dos en un proceso, en `api/src/clock.ts` y `api/src/http/`. El detalle está en el [ROADMAP](ROADMAP.md), fase 7, y el diseño en [DESIGN](DESIGN.md#endpoints).

- **Verificación contra una cadena real.** Igual que en la fase 6, con un override de compose descartable. Se recorrieron los cuatro caminos, los límites exactos de `cancelDeadline` y `expiresAt` con `evm_setNextBlockTimestamp`, cada filtro y cada error, caídas del RPC y de Postgres, los tres modos y el apagado con una request en curso.
- **Bug encontrado en `/health`.** La primera versión leía el checkpoint y el head en paralelo y recortaba el lag a 0, para tolerar la carrera entre las dos lecturas. Al reiniciar Anvil, un proceso `MODE=api` seguía informando `ok`. Ahora lee primero el checkpoint y después el head: un head menor solo puede significar que la cadena retrocedió, y se informa como `degraded` con lag negativo.
- **Validación estricta pero práctica.**
  - Un `limit` fuera de rango da `400` en lugar de recortarse, y un parámetro desconocido da `400` en lugar de ignorarse. Así, un error de tipeo no descarta un filtro sin avisar.
  - Un parámetro vacío cuenta como ausente, porque la ruta del enunciado es `/escrows?sender=&beneficiary=&status=`.
- **`total` consistente.** El conteo y la página salen de una misma transacción `REPEATABLE READ`, así coinciden aunque el indexador escriba entre las dos consultas.
- **Ejemplos curl del README.** Tenían direcciones abreviadas (`0xf39f...2266`) que la API rechaza con `400`. Se reemplazaron por las completas y se verificaron contra el stack.
- **Commits.** El ROADMAP preveía separar los endpoints de escrows y el de health, pero los dos se registran en `buildServer`. Se reagruparon y se comprobó, en una copia descartable, que cada commit compila solo.

## 20. Revisión de las decisiones de la fase 7

> iteremos las "Decisiones que conviene revisar"

**Output:** la IA repasó las cuatro decisiones que había marcado al cerrar la fase 7 y las presentó en un cuestionario, cada una con sus alternativas. El autor eligió:
- **Validación del listado:** se mantiene el `400` estricto para un `limit` fuera de rango o un parámetro desconocido. Se descartaron recortar el `limit` e ignorar los parámetros desconocidos.
- **Parámetros vacíos:** siguen contando como ausentes.
- **Umbral de `/health`:** se mantiene `CONFIRMATIONS + HEALTH_MAX_LAG`. Se descartaron un umbral absoluto y un lag solo informativo.
- **Errores y logs:** se aplican los dos ajustes propuestos.
  - Con la DB caída, los endpoints de escrows responden `503` "Cannot read the database", igual que con el nodo, en lugar de un `500` genérico. El `500` queda para errores inesperados.
  - Las requests a `/health` van en `debug` solo si responden `200`. Antes, un `degraded` causado solo por el lag no dejaba ninguna línea en `info`, así que un indexador trabado pasaba desapercibido.

Al repasar el manejo de errores apareció un bug que no se había probado en la fase 7: se había probado Postgres detenido, pero no pausado.
- **Con Postgres pausado**, `/escrows/1` no respondió en 40 s, y SIGTERM no terminó el proceso hasta que volvió la DB, más de 3 minutos después. El pool de `pg` no tenía ningún timeout.
- **La corrección** es un timeout de 3 s, del lado del cliente, para obtener una conexión y para cada query. `statement_timeout` no sirve, porque lo aplica el servidor, que en este caso no responde. Con 3 s, aunque venzan una query y su `ROLLBACK`, el apagado entra en los 10 s que espera `docker compose stop`.

**Verificación** con el override descartable de la fase 7:
- **Postgres pausado:** los escrows dan `503` a los 3 s, o a los 6 s en el listado si la transacción ya estaba abierta. 50 requests simultáneas reciben `503` en menos de 3,1 s. El indexador reintenta sin caerse, y todo se recupera al reanudar Postgres.
- **Apagado:** un SIGTERM con un listado colgado sale en 5,6 s con código 0.
- **Postgres detenido:** los escrows dan `503` al instante.
- **Logs:** el log de cada `503` incluye la causa (`Cannot read the database: Query read timeout`). Un `/health` degradado solo por lag queda en `info`, y los `200` no aparecen.

`typecheck`, `lint` y `build` pasan. Se actualizaron [DESIGN](DESIGN.md#endpoints) (códigos, logs y *Postgres colgado* en *Proceso y configuración*) y la fase 7 del [ROADMAP](ROADMAP.md).

## 21. Fase 8: tests de la API

> seguimos con la fase 8

**Output:** 79 tests en `api/test/`: unitarios del proyector y de `toView`, integración del indexador y del guard contra Anvil y Postgres reales, y tests HTTP con `fastify.inject`. Corren con `docker compose run --rm npm test` en unos 6 s. El detalle está en el [ROADMAP](ROADMAP.md), fase 8, y el enfoque en [DESIGN](DESIGN.md#ejecución-y-tests).

- **Postgres adelantado.** Los tests necesitan Postgres, así que el servicio `postgres` y `docker/postgres/init.sql`, previstos para la fase 9, se agregaron en esta. Los tests usan la base `escrow_test`, aparte de la del stack. El healthcheck va por TCP, porque durante la inicialización Postgres solo escucha en su socket Unix y un chequeo por socket daría sano antes de tiempo.
- **La cadena como oráculo.** Los tests de integración no comparan contra valores esperados escritos a mano. Leen los logs del contrato y `getEscrow` y exigen que la DB coincida exactamente.
- **Kill real.** "Indexar, matar y reanudar" se prueba con un proceso indexador real, que se mata con SIGKILL dos veces a mitad de camino. Como un SIGKILL no cae siempre a mitad de una transacción, un trigger de Postgres hace fallar un batch después de que guardó sus eventos, y así la atomicidad se prueba de forma determinística.
- **Comprobación de los tests con mutaciones.** Que todo pasara al primer intento no alcanzaba como prueba. La IA introdujo a mano 19 bugs en `src/`, uno por vez, y los tests detectaron todos. En el camino aparecieron cuatro cosas:
  - **Una mutación equivalente.** Cambiar `ROLLBACK` por `COMMIT` no rompe nada, porque en Postgres un `COMMIT` sobre una transacción abortada hace rollback. Se reemplazó por un batch sin `BEGIN`.
  - **Un hueco.** Ningún test cubría el lag negativo de `/health`, que fue el bug de la fase 7. Se agregó el test.
  - **Un test que colgaba la corrida.** Con la reanudación rota, el test de kill esperaba para siempre a su proceso hijo. Ahora tiene un tope de espera y mata a sus hijos si falla.
  - **Un cache inesperado.** El cliente de viem cachea `getBlockNumber` durante el `pollingInterval`, así que un test leía un head viejo. El cliente de los tests va sin cache.
- **Estabilidad.** 5 corridas seguidas en verde, una con un solo núcleo de CPU y otra desde un volumen de Postgres nuevo.

## 22. Fase 9: stack compose

> implementa la fase 9, preguntame si hay dudas

**Output:** servicios `anvil`, `deployer` y `api` en `docker-compose.yml`, más `contracts/script/deploy.sh`, `.env.example` y los Dockerfiles reestructurados. `docker compose up --build` levanta todo y deja `/health` en `ok`. El detalle está en el [ROADMAP](ROADMAP.md), fase 9, y el diseño en [DESIGN](DESIGN.md#stack).

La IA armó y probó un borrador antes de preguntar, así las preguntas venían con datos. Hizo tres, y el autor eligió la opción recomendada en cada una:

| Pregunta | Respuesta |
| --- | --- |
| Anvil registra cada llamada RPC: 2,4 líneas por segundo con el stack quieto, que tapan los logs de la API | `attach: false`: fuera de `docker compose up` y disponibles con `docker compose logs anvil`. Se descartaron `--quiet`, que también oculta las transacciones, y dejarlo como estaba. Requiere Compose 2.20. |
| Interfaces de los puertos publicados | Solo `127.0.0.1`, porque Anvil tiene las cuentas desbloqueadas. Se descartaron todas las interfaces y una variable `BIND_ADDRESS`. |
| Puerto de Postgres "opcional por `.env`", que compose no puede activar con una variable | Sin publicar, con `docker compose exec postgres psql` en el README. Se descartaron un archivo de override activable con `COMPOSE_FILE` y publicarlo siempre. |

- **Deploy idempotente, no previsto.** Al probar el borrador apareció que `docker compose up` vuelve a correr el deployer en cada arranque, aunque el stack ya esté corriendo. También lo hace `docker compose run` de un servicio que depende de la API, como va a ser la demo. Un segundo deploy en la misma cadena dejaría a la API indexando el primer contrato. `deploy.sh` deploya solo si el archivo de deploy no describe la cadena, con los mismos chequeos que el guard de cadena. Se prefirió un script del servicio a cambiar `Deploy.s.sol`, que ya estaba revisado y que también sirve para Sepolia.
- **Imágenes cacheables.** Antes, cambiar un test reconstruía las dos imágenes del stack, en 12,6 s. Las etapas ahora copian solo lo que usan, y en ese caso salen enteras de cache, en 2,8 s.
- **Sin defaults duplicados.** Compose pasa vacías las variables de la API que no están en `.env`, y la API ya trata una variable vacía como ausente. Así, los defaults viven en un solo lugar.
- **Verificación.** Desde una copia limpia del repo, con build sin cache, el stack queda sano en 34 s. También se probaron `up` repetido, `down` y `up` con datos, Anvil reiniciado solo, Postgres detenido, `Ctrl+C`, los overrides de `.env` y los tiempos de apagado. Los 79 tests de la API pasan con las imágenes nuevas.

## 23. Fase 10: script de demo

> sigamos con la fase 10

**Output:** `api/scripts/demo.ts`, `npm run demo` y el servicio `demo` en `docker-compose.yml`. `docker compose run --rm demo` levanta el stack si hace falta, recorre los cuatro caminos y sale con código 0. El detalle está en el [ROADMAP](ROADMAP.md), fase 10, la salida en el [README](../../README.md#demo-de-punta-a-punta) y el diseño en [DESIGN](DESIGN.md#ejecución-y-tests).

Antes de preguntar, la IA comprobó que `pull_policy: build` reconstruye la imagen en cada `docker compose run`. Hizo tres preguntas, y el autor eligió la opción recomendada en cada una:

| Pregunta | Respuesta |
| --- | --- |
| De dónde toma el código el servicio `demo` | De la imagen `api:dev` con `pull_policy: build`: siempre el script actual, sin montar `./api` ni instalar nada en el host. Se descartaron montar `./api` y la imagen sin rebuild. |
| Idioma de la salida | Inglés, como los logs, los errores de la API y Foundry. |
| Cuánto muestra cada paso | Una línea con el estado, las acciones admitidas y adónde fueron los fondos, y al final un curl para ver el JSON completo. Se descartaron el JSON por paso y un modo detallado opcional. |

- **Esperar y después verificar.** La demo no hace polling hasta que coincida todo, porque un bug recién se vería al vencer la espera. Espera a que la API refleje el paso (el escrow existe, tiene `resolvedTx` o su `now` alcanzó el bloque nuevo) y recién ahí compara la vista completa y los saldos. Si algo difiere, falla enseguida, con cada campo distinto.
- **Sin mint.** El ROADMAP preveía mintear, pero el deploy ya fondea las cuentas de Anvil: alcanza con el approve.
- **Confirmaciones, no previsto.** Con `CONFIRMATIONS` > 0 y el automine de Anvil, el indexador no vería nunca la última transacción. La demo mina esa cantidad de bloques después de cada una. Se comprobó que sin ese minado la demo se queda esperando.
- **Comprobación con bugs.** Tres bugs introducidos a mano en la API (una resolución mal proyectada, la expiración sin derivar y `canRecover` sin chequear el vencimiento) y un indexador detenido hacen fallar la demo con código 1 y un mensaje que nombra el problema.
- **Una trampa de compose.** La primera prueba con el indexador detenido pasó sin error: la variable que lo detenía estaba en el `up` pero no en el `run`, y `docker compose run` recreó la API con la configuración por defecto.

## 24. Fase 11: CI

> sigamos con la fase 11

**Output:** `.github/workflows/contracts.yml`, `api.yml` y `e2e.yml`, con los mismos `docker compose` del README, más los badges en el README. El detalle está en el [ROADMAP](ROADMAP.md), fase 11, y el diseño en [DESIGN](DESIGN.md#ejecución-y-tests).

Antes de preguntar, la IA corrió todos los pasos de los workflows sobre una copia limpia del repo, con las imágenes construidas sin cache, para tener los tiempos. Hizo tres preguntas, y el autor eligió la opción recomendada en cada una:

| Pregunta | Respuesta |
| --- | --- |
| Cache de capas de Docker en CI | Sin cache: las tres imágenes de herramientas se construyen en 30 s, y el build queda igual al de una máquina limpia. Se descartó el cache `type=gha` con `docker buildx bake`. |
| Cuándo corren los workflows | En cada push a `main` y en cada pull request, sin filtros de paths. Se descartaron ignorar los cambios solo de documentación y filtrar por carpeta. |
| Badges en el README | Sí, los tres, bajo el título. |

- **Versiones fijadas también en CI.** La única acción, `actions/checkout`, va fijada por SHA en la v7.0.1, publicada hace casi tres meses, con el mismo criterio de antigüedad que el resto de las dependencias. El runner es `ubuntu-24.04`, no `ubuntu-latest`.
- **Permisos mínimos.** `contents: read` y `persist-credentials: false`, para no dejar el token en `.git/config` mientras corren dependencias de terceros.
- **Los chequeos de gas se probaron en falso.** Con una sola unidad de gas cambiada en cada snapshot, los dos comandos salen con código 1. El paso más lento es `forge test` con el perfil `ci`: 64 s.
- **El commit de la fase 10.** Se agrupó en un solo commit, y se corrigió la línea *Commits* de esa fase en el ROADMAP.
- **Verificación en GitHub:** quedó para después del push (entrada 25).

## 25. Fase 11: corridas en GitHub

> ya pusheé, revisá las corridas en GitHub

**Output:** la IA siguió las corridas por la API pública de GitHub, sin `gh` ni token. El push `b4c50e3` dejó los tres workflows en verde, y los badges del README dicen *passing*.

- **Tiempos:** `contracts` 2 min 25 s, de los que 99 s son `forge test` con el perfil `ci`; `api` 1 min 19 s; `e2e` 1 min 3 s. Corren en paralelo. El detalle por paso está en el [ROADMAP](ROADMAP.md), fase 11, que quedó cerrada.
- **Sin advertencias:** ningún job dejó anotaciones.
- **Docker clásico cubierto.** El runner de GitHub usa Docker clásico, que en la fase 9 no se había podido probar. El stack y los servicios de herramientas pasaron sin ajustes.
- **Límite de la verificación.** Los logs de los jobs piden un token con permisos de admin, aun en un repo público. Por eso se verificaron los resultados y los tiempos de cada paso, pero no su salida.

## 26. Avances del día 2

> genera avances/dia2.md con lo que hicimos en el proyecto

**Output:** [`progress/day2.md`](progress/day2.md), con el mismo formato que el del día 1: las fases 6 a 11 terminadas, la reorganización de la documentación, las decisiones del autor de cada fase, lo que falta (fase 12 y los pendientes decididos) y el estado del repo.

- **Enunciado fuera del repo.** Al revisar el estado apareció que `CHALLENGE.md` está en el `.gitignore` desde `1f7449f` y no existe en la copia local, pero el README, DESIGN, el ROADMAP y este log lo enlazan. Quedó anotado como decisión del autor para el cierre, junto con la del PDF.

## 27. Fase 12: verificación en un host solo con Docker

> vamos con los puntos de cierre y entrega, pero por partes. para la Verificación en un host solo con Docker ahora estamos en Debian (WSL) recién instalado con algunos comandos básicos y docker rootless. hagamos esa primera verificación nomás ("Verificación en un host solo con Docker")

**Output:** la verificación completa, registrada en la fase 12 del [ROADMAP](ROADMAP.md). La IA comprobó primero que el host no tuviera Node, Foundry ni solc, y que Docker no tuviera imágenes, volúmenes ni contenedores. Después clonó el repo desde GitHub y corrió los comandos del README tal cual, en su orden.

- **Stack:** `docker compose up --build` queda sano en 51 s desde cero. Los curl, la demo y el `Ctrl+C` se comportan como dice el README.
- **Pruebas:** los 13 comandos de la sección *Pruebas* salen con código 0, y los archivos generados quedan del usuario del host.
- **Hallazgo:** `forge coverage` compila sin optimizador y reescribe `contracts/snapshots/EscrowGasTest.json` con esos valores. Corriendo el README en orden, el clon termina con un archivo versionado modificado. Se confirmó aislando el paso: coverage lo cambia y el siguiente `forge test` lo restaura. CI no corre coverage, por eso no había aparecido. Quedó abierto en la fase 12, sin corregir.
- **Detalles para el README final:** el encabezado de la demo que no se muestra, el cuarto curl que da vacío después de la demo y la imagen de curl sin versión fijada.

## 28. Coverage sin reescribir el snapshot de gas

> si, de acuerdo, que EscrowGasTest no escriba el snapshot cuando corre el coverage

**Output:** `EscrowGasTest` escribe el snapshot con un helper, `_snapshotGas`, que no hace nada bajo `forge coverage` (`vm.isContext(VmSafe.ForgeContext.Coverage)`). Se actualizaron [`docs/gas.md`](../gas.md), [DESIGN](DESIGN.md) y la fase 12 del [ROADMAP](ROADMAP.md).

- **Riesgo revisado:** si la consulta de contexto contara como último frame, el benchmark mediría esa consulta y no la operación. `EscrowGasTest.json` sale idéntico, así que no cuenta.
- **Prueba de que sigue escribiendo:** con un valor del JSON alterado a mano, coverage lo deja como está y `forge test` lo restaura.
- **`.gas-snapshot` regenerado:** mide cada función de test completa, y los 7 tests del benchmark suben entre 713 y 724 por la consulta. El gas del contrato no cambió.

## 29. Fase 12: el resto del cierre

> sigamos con las partes que restan de la fase 12 del roadmap

Antes de empezar, la IA hizo cuatro preguntas, porque cambiaban el alcance y el orden del trabajo:

| Pregunta | Respuesta del autor |
| --- | --- |
| Owner con pausa y whitelist de tokens, de *Pendientes decididos* | Pasarlo a mejoras, la opción recomendada |
| Demo en Sepolia con ventanas cortas, también pendiente | Hacerla ahora. La IA había recomendado dejarla como mejora |
| `CHALLENGE.md` está en el `.gitignore` pero el README, DESIGN, el ROADMAP y este log lo enlazan | Sacar los vínculos: el enunciado queda fuera del repo |
| Dónde va el material para la sesión de 45-60 minutos | Fuera del repo |

**Output:** el detalle de cada ítem está en la fase 12 del [ROADMAP](ROADMAP.md).

- **Revisión de seguridad:** [`docs/security.md`](../security.md). El contrato no cambió. Aparecieron dos limitaciones nuevas, las dos causadas por el token: un token que bloquea al propio contrato congela sus escrows, y uno que debita al que paga más que el monto deja cortos a los últimos. La IA las confirmó con tests descartables antes de escribirlas, y quedaron fijadas con dos tests `test_KnownLimitation_*`, en total 81.
- **Revisión de correctitud:** [`docs/correctness.md`](../correctness.md). Cubre cada regla del contrato, los requisitos de la API y los entregables, así que también es el checklist final del enunciado.
- **Sepolia:**
  - `docker-compose.sepolia.yml`, con la API contra un RPC público y el archivo de deploy versionado: indexar el contrato deployado no necesita claves
  - las claves del deploy y la demo, en `.env.sepolia`, que git ignora
  - la demo, que ahora funciona fuera de Anvil: espera las confirmaciones y el vencimiento en tiempo real
  - **Ventanas de 5 y 10 minutos,** no de 2 y 10 como preveía el ROADMAP: con 12 confirmaciones, la API tarda unos 2,5 minutos en ver un escrow, y con 2 minutos nunca lo mostraría como cancelable.
  - **Verificado antes de gastar gas.** Contra Sepolia, sin transacciones: el hash del bloque inicial que calcula el deploy coincide con el real, y el RPC público acepta los rangos de logs del indexador. Contra un Anvil que imita una testnet, el deploy, su idempotencia, la demo completa y los errores de configuración.
  - **Pendiente:** el deploy real y la demo en Sepolia, que corre el autor con sus claves.
- **README final:**
  - la salida completa de la demo y los curl con sus respuestas reales
  - `curlimages/curl` fijada en `8.22.0`
  - la sección de Sepolia
  - el resumen de decisiones en 29 líneas, más supuestos, limitaciones y mejoras, cada una con su vínculo a DESIGN
- **Este log:** la nota de [qué se aceptó, qué se cambió y por qué](#qué-se-aceptó-qué-se-cambió-y-por-qué), al principio.
- **Una trampa en la verificación.** La primera tanda de curl respondió `404` en rutas que existen: otro proyecto de compose de la máquina de desarrollo publicaba el puerto 3000, y la API del stack no había podido levantar. Se repitió con `API_PORT=3002`.

## 30. Nombres de archivo en inglés

> cambia el nombre de archivo y las referencias de docs/correctitud.md, docs/seguridad.md, docs/ai/avances (y los archivos) y docs/ai/01-analisis-ambiguedades.md al inglés. el contenido queda como está en español

**Output:** cuatro renombres, con el contenido sin cambios:

| Antes | Ahora |
| --- | --- |
| `docs/correctitud.md` | [`docs/correctness.md`](../correctness.md) |
| `docs/seguridad.md` | [`docs/security.md`](../security.md) |
| `docs/ai/avances/dia1.md` y `dia2.md` | [`docs/ai/progress/day1.md`](progress/day1.md) y [`day2.md`](progress/day2.md) |
| `docs/ai/01-analisis-ambiguedades.md` | [`docs/ai/01-ambiguity-analysis.md`](01-ambiguity-analysis.md) |

- **Referencias actualizadas:** el README, DESIGN, el ROADMAP, este log, `docs/correctness.md` y un comentario de `EscrowTokens.t.sol`.
- **Lo que no cambió:** los prompts citados en este log conservan los nombres viejos, porque son textuales. Las palabras del contenido, como "avances" o "correctitud", siguen en español.
- **Verificación:** un chequeo automático confirmó que no quedan vínculos ni anclas rotos.
- **Git:** los archivos se movieron con `mv`, sin tocar el índice. Git detecta el renombre al agregarlos.

## 31. Sepolia: el primer deploy falla sin gas

> (salida de `docker compose -f docker-compose.sepolia.yml run --rm deploy`, con las dos creaciones en `[Failed]`)

**Output:** las dos transacciones se minaron y agotaron su límite de gas. El detalle está en la fase 12 del [ROADMAP](ROADMAP.md).

- **Causa:** forge fija cada límite en 1,3 veces el gas de su propia simulación, que usa los costos de `cancun`, el `evm_version` del proyecto. Sepolia ya cobra mucho más por crear un contrato: según su `eth_estimateGas`, el Escrow necesita 6.545.373 de gas y no 933.537. La testnet simulada no lo podía mostrar, porque Anvil 1.8.3 cobra lo mismo con cualquier hardfork.
- **Corrección:** `deploy.sh` agrega `--skip-simulation`, y con eso forge toma cada límite de `eth_estimateGas` del nodo.
- **Verificada sin gastar más:**
  - en Sepolia, con `eth_call` de las mismas creaciones: fallan con los límites viejos y pasan con los nuevos
  - en Anvil, el límite pasa a ser 1,3 veces la estimación del nodo
  - el stack local y la demo siguen en verde
- **Documentación:** se agregó a [DESIGN](DESIGN.md#sepolia) y a [`docs/gas.md`](../gas.md) que los números de gas son de Cancun y cuánto cuesta el deploy en Sepolia.

## 32. Sepolia: deploy y verificación

> (salida del segundo `docker compose -f docker-compose.sepolia.yml run --rm deploy`: las dos creaciones en `[Success]` y los dos contratos verificados)

**Output:** con el gas estimado por el nodo, el deploy pasó.
- **Direcciones:** `Escrow` en `0x9a3b2D1C29c049F65875b6DfA0Cf869485625055` y el token de prueba en `0xbCb0FcD74C568Be777E86734db21d35EeB2C826e`, los dos verificados en Etherscan y Sourcify. Costaron 0,0053 ETH.
- **Comprobado en la cadena:** el código, las ventanas de 300 y 600 s, y que el `startBlockHash` del archivo es el hash real del bloque inicial.
- **La API contra Sepolia:** la IA la levantó sin claves y quedó sana, con lag 12.
- **README:** suma las dos direcciones con su link a Etherscan. El archivo `contracts/deployments/11155111.json` quedó versionado, con este deploy, en `32fda84`.
- **Lo que falta:** la demo, que corre el autor con sus claves.

## 33. Sepolia: la demo rechaza las claves sin `0x`

> 'docker compose -f docker-compose.sepolia.yml run --rm demo' va a usar .env.sepolia?

> (salida de `docker compose -f docker-compose.sepolia.yml run --rm demo`: `Demo failed: Invalid configuration`, `expected a 0x-prefixed 32-byte hex key` en las dos claves)

**Output:**
- **La pregunta:** sí. Solo `deploy` y `demo` cargan `.env.sepolia`, y solo dentro del contenedor: compose no lo usa para los `${...}` del YAML, que van en `.env`.
- **El fallo:** la demo exigía las claves con `0x`, y las billeteras suelen exportarlas sin el prefijo. El deploy había pasado con la misma clave porque forge acepta las dos formas. La IA no leyó `.env.sepolia`: lo dedujo de esa diferencia.
- **Corrección:** la demo acepta las claves con `0x` o sin él, y también con espacios alrededor, igual que forge. El mensaje de error no muestra el valor. `.env.sepolia.example` aclara que el `0x` es opcional.
- **Verificada en el stack local:**
  - la demo pasa con las claves de Anvil sin `0x`, una de ellas con espacios
  - con claves mal formadas, falla con el mensaje nuevo
  - lint y typecheck en verde

## 34. Monad testnet

> sepolia es muy lenta, podemos usar monad testnet. create los archivos para una prueba sobre monad testnet

**Output:** un tercer proyecto de compose, [`docker-compose.monad.yml`](../../docker-compose.monad.yml), con la misma estructura que el de Sepolia. El diseño está en [DESIGN](DESIGN.md#monad-testnet).
- **Primero se midió la red,** contra el RPC público:
  - un bloque cada 0,3 s, y `finalized` 2 bloques detrás de `latest`
  - `eth_getLogs` limitado a 100 bloques por llamada
  - `TSTORE`, `TLOAD` y `MCOPY` funcionan
  - el deploy del Escrow cuesta 941.725 de gas, casi lo mismo que en Cancun
  - el sender de Sepolia ya tiene 5 MON en esa red
- **Configuración:** 10 confirmaciones (unos 3 s), `BATCH_SIZE=100`, `HEALTH_MAX_LAG=50`, ventanas de 60 y 120 s, y la API en el puerto 3002. Las claves van en `.env.monad`, ignorado por git, con su plantilla [`.env.monad.example`](../../.env.monad.example).
- **Código:**
  - `deploy.sh` verifica en el Sourcify de MonadVision, sin API key.
  - La demo toma `BLOCK_TIME_MS` para el polling y las esperas, y usa el `nonceManager` de viem para no repetir un nonce si un nodo atrasado contesta.
  - En Anvil y en Sepolia nada cambia.
- **Comprobado contra una testnet simulada** (Anvil con `--network monad` y el chain id 10143): deploy, un segundo deploy que no hace nada y la demo completa, con código 0. En el stack local, la demo, lint y typecheck siguen en verde. La simulación se borró: archivo de deploy, base y contenedores.
- **Lo que falta:** el deploy y la demo reales, que corre el autor con sus claves.

## 35. Sepolia: la demo

> vamos primero con los resultados de la demo en sepolia: (salida de `docker compose -f docker-compose.sepolia.yml run --rm demo`: los cuatro caminos y `Every state matched`)

**Output:** la demo pasó contra el contrato deployado. La salida quedó en el [README](../../README.md#sepolia), con tres notas que la IA verificó contra la API y la cadena:
- **Los ids arrancan en 4:** los escrows 1 a 3 son anteriores, de otra cuenta.
- **Mintea 992 y no 1.000:** el sender ya tenía 8 MOCK.
- **D se ve como `ExpiredRecoverable` apenas vence,** aunque la API indexa con 12 bloques de atraso, porque su reloj es el último bloque. El `recoverExpired` salió 12 s después del vencimiento.

Tiempos medidos en la cadena: unos 29 minutos en total y 156 s por paso. DESIGN decía "unos 3 minutos" por paso y pasó a decir "unos 2,5". La fase 12 del [ROADMAP](ROADMAP.md) marca el pendiente como hecho.
