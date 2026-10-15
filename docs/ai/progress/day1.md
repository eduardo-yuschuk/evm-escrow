# Avances: día 1

_14/10/2026_

Llevamos las fases 0 a 5 de 13 terminadas. El contrato está completo, testeado y auditado, y falta todo el backend: indexador, API, stack completo, demo y CI. El detalle de cada fase está en el [`ROADMAP.md`](../ROADMAP.md).

## Hecho (fases 0–5)

**0. Setup dockerizado.** El host solo necesita Docker; todo lo demás corre en contenedores.
- Versiones fijadas: Foundry `v1.8.3`, solc `0.8.37` (cancun), OpenZeppelin `5.7.0`, Node `24.21.0`.
- Dependencias Solidity con Soldeer.
- API en TypeScript estricto con ESLint, Prettier y Vitest.
- El entrypoint baja con `setpriv` al uid del dueño del código, así funciona igual con Docker rootless y con Docker clásico.

**1. Contrato `Escrow.sol`.**
- Interfaz `IEscrow.sol` con NatSpec; el struct ocupa 4 slots.
- Ventanas `immutable` (`CANCEL_WINDOW`, `TTL`).
- `createEscrow` mide el balance antes y después de la transferencia para soportar tokens con fee.
- Patrón CEI más `ReentrancyGuardTransient`.
- Un solo helper, `_loadPending`; los chequeos de quién llama y de tiempo van inline en cada acción. Runtime de 4.063 B.

**2. Tests unitarios.**
- 61 tests y 7 mocks: no-return, false-return, fee-on-transfer, reentrante, atacante ERC-777 y blacklist.
- 100 % de cobertura en `Escrow.sol`.
- Los 10 bugs introducidos a mano fueron detectados.

**3. Fuzz e invariantes.**
- 10 fuzz y 5 invariantes, con un handler que lleva un modelo de referencia de cada escrow. Suma 72 tests en total.
- Perfil `ci` con 10.000 runs de fuzz y 51.200 llamadas en las invariantes.
- Otros 10 bugs introducidos a mano, todos detectados solo por la suite de invariantes.

**4. Gas y Slither.**
- Benchmark con snapshots que da el mismo gas que Anvil.
- Se midieron 7 optimizaciones posibles; no se aplicó ninguna.
- Servicio `slither` con dependencias fijadas por hash: 9 hallazgos iniciales, todos analizados en [`docs/slither.md`](../../slither.md), y hoy 0.

**5. Deploy y ABI.**
- `Deploy.s.sol` con ventanas configurables por variables de entorno. En Anvil también deploya un `MockERC20` y le da fondos a las 10 cuentas.
- Escribe `deployments/<chainId>.json` con `startBlock` y `startBlockHash`, que van a servir para el guard de cadena.
- `npm run abi` genera `api/src/generated/contracts.ts` tipado y commiteado, más un chequeo de desincronización pensado para CI.

## Pendiente

- **6. Indexador:** configuración con zod, migraciones (`events`, `escrows`), proyector, checkpoint y guard de cadena.
- **7–8. API HTTP** (`/escrows/:id`, `/escrows`, `/health`) y sus tests.
- **9. Stack compose:** `anvil`, `deployer`, `postgres` y `api` con un solo `docker compose up`.
- **10. Demo:** confirmar, rechazar, cancelar y vencer.
- **11. CI:** GitHub Actions con los mismos comandos `docker compose`.
- **12. Cierre:** verificación en un host limpio y README final.
- **Pendientes decididos sin fase asignada:**
  - Owner con `pause` y whitelist de tokens que solo afecten a la creación de escrows.
  - Demo en Sepolia con ventanas cortas.
- **Decisión del autor:** si el PDF del enunciado se versiona o sale del repo.

## Estado del repo

En `main`, con cambios sin commitear:
- `README.md` modificado: el README completo con el diseño y las decisiones, unas 470 líneas.
- `CHALLENGE.md` y `ROADMAP.md`, todavía sin agregar a git.
