# Avances: día 2

_15/10/2026_

Llevamos las fases 0 a 11 de 13 terminadas. Ayer se hizo todo el backend: indexador, API, tests, stack compose, demo y CI, y los tres workflows quedaron en verde en GitHub. Falta solo el cierre de la entrega (fase 12) y los pendientes decididos. El detalle de cada fase está en el [`ROADMAP.md`](../ROADMAP.md), el diseño en [`DESIGN.md`](../DESIGN.md) y cada prompt en el [log de `docs/ai`](../README.md), entradas 16 a 25.

## Hecho

**Reorganización de la documentación** (entradas 16 y 17).
- El diseño salió del README a [`DESIGN.md`](../DESIGN.md), y el ROADMAP pasó a `docs/ai/`. El README raíz quedó con la descripción breve, los requisitos y los comandos de cada prueba.
- Quedó anotado en la fase 12 que el README final va a puntear todas las decisiones, una línea cada una, con vínculo a DESIGN.

**6. Indexador.**
- Configuración con zod, migraciones SQL propias con sha256 y `pg_advisory_lock`, y dominios en la base que rechazan direcciones, hashes y montos inválidos.
- Proyector puro (`create`, `resolve` o `skip`), con las mismas guardas repetidas en el SQL.
- Loop con checkpoint: una transacción por batch, `eth_getLogs` directo y decodificación estricta, porque `getLogs` de viem descarta en silencio los logs que no puede decodificar.
- Guard de cadena en dos pasos, archivo de deploy contra cadena y DB contra archivo. El primero no estaba previsto: sin él, con Anvil reiniciado, el indexador esperaba para siempre.
- Reintentos en una sola capa (los de viem, apagados) y apagado en 0,14 s aun con el RPC colgado.

**7. API HTTP.**
- Reloj de cadena cacheado 1 s, estado derivado con `ExpiredRecoverable` y los flags `canCancel`, `canConfirm`, `canReject` y `canRecover`.
- `GET /escrows/:id`, `GET /escrows` con filtros y paginación, y `GET /health`. Indexador y API en un proceso, con `MODE`.
- Bug encontrado al verificar: `/health` informaba `ok` después de reiniciar Anvil. Ahora un lag negativo es `degraded`.
- **Revisión de decisiones** (entrada 20): el autor mantuvo el `400` estricto, los parámetros vacíos como ausentes y el umbral de `/health`, y aceptó dos ajustes: `503` con la DB caída y los `/health` degradados en `info`. Al repasarlo apareció otro bug: con Postgres pausado, una request colgaba más de 3 minutos. Se agregó un timeout de 3 s del lado del cliente.

**8. Tests de la API.**
- 79 tests en unos 6 s: unitarios del proyector y de `toView`, integración contra Anvil y Postgres reales, y HTTP con `fastify.inject`.
- La cadena es el oráculo: la DB tiene que coincidir con los logs y con `getEscrow`.
- Kill real con SIGKILL a mitad de camino, y un trigger de Postgres para probar la atomicidad del batch de forma determinística.
- 19 bugs introducidos a mano, todos detectados. Una mutación resultó equivalente (`ROLLBACK` por `COMMIT`) y otra mostró un hueco, el lag negativo, que se cubrió con un test nuevo.

**9. Stack compose.**
- Servicios `anvil`, `deployer`, `postgres` y `api`: `docker compose up --build` deja `/health` en `ok`.
- Decisiones del autor: Anvil fuera de la salida de `up` (`attach: false`), puertos solo en `127.0.0.1` y Postgres sin publicar.
- Deploy idempotente, no previsto: `deploy.sh` no vuelve a deployar si el archivo ya describe la cadena.
- Imágenes cacheables: cambiar un test pasó de reconstruir en 12,6 s a 2,8 s.

**10. Demo.**
- `docker compose run --rm demo` levanta el stack si hace falta y recorre confirmar, rechazar, cancelar y vencer, con `ExpiredRecoverable` visible antes del recover.
- Espera a que la API refleje cada paso y después compara la vista completa y los saldos. Si algo difiere sale con código 1, así que sirve como smoke test.
- Decisiones del autor: imagen `api:dev` con `pull_policy: build`, salida en inglés y una línea por paso.
- Se probó con tres bugs introducidos en la API y con el indexador detenido: falla en todos los casos, nombrando el problema.

**11. CI.**
- Workflows `contracts`, `api` y `e2e`, con los mismos `docker compose` del README y sin instalar Node ni Foundry.
- Runner y `actions/checkout` fijados, permisos mínimos y badges en el README. Decisiones del autor: sin cache de capas y sin filtros de paths.
- En GitHub, el push `b4c50e3` dejó los tres en verde, en paralelo, en unos 2 min 30 s. Así quedó cubierto Docker clásico, que localmente no se podía probar.

## Pendiente

- **12. Cierre:**
  - verificación en un host solo con Docker, desde `git clone`
  - revisión de seguridad del contrato contra el checklist y de correctitud contra la tabla de reglas del enunciado
  - README final con el resumen de decisiones, los curl con su output real y sin la nota de estado
  - `docs/ai/` completo, con qué se aceptó, qué se cambió y por qué
  - releer el enunciado como checklist, dar acceso a los evaluadores y preparar la sesión de 45-60 minutos
- **Pendientes decididos sin fase asignada:**
  - Owner con `pause` y whitelist de tokens que solo afecten a la creación de escrows.
  - Demo en Sepolia con ventanas cortas. El script de deploy ya acepta las ventanas por variables de entorno.
- **Decisión del autor:** qué hacer con el enunciado. Ver *Estado del repo*.

## Estado del repo

- `main` está pusheado: el último commit es `fcce2ab`, igual que `origin/main`. Solo queda sin seguimiento `.vscode/`.
- Desde el reporte del día 1 hay 24 commits, que suman 5.580 líneas en 54 archivos.
- **El enunciado no está en el repo.** `CHALLENGE.md` se agregó al `.gitignore` en `1f7449f` y tampoco está en la copia local, pero el README, DESIGN, el ROADMAP y el log de `docs/ai` lo enlazan. En un clon, esos vínculos dan 404. Hay que decidirlo en el cierre junto con el PDF: versionarlo o sacar los vínculos.
