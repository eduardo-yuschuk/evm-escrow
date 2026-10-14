# evm-escrow

Escrow de tokens ERC-20 en Solidity, más una API/indexador en TypeScript que proyecta los eventos del contrato en Postgres.

- **Contrato** (`contracts/`): un solo contrato gestiona muchos escrows. El enviador deposita tokens y el beneficiario los confirma o rechaza; el enviador puede cancelar en las primeras 2 horas y recuperar los fondos después de 7 días. Foundry, Solidity 0.8.37 y OpenZeppelin.
- **API e indexador** (`api/`): Node.js, TypeScript y viem. Indexa los eventos en Postgres y expone el estado de cada escrow por HTTP.
- **Todo corre con Docker Compose:** nodo local (Anvil), deploy, base de datos, API, tests, análisis estático y demo.

> **Estado:** el contrato, el indexador y la API HTTP están terminados y testeados. El stack completo (`docker compose up`), la demo y CI están en desarrollo; los comandos de esas secciones son los previstos.

## Documentación

| Documento | Contenido |
| --- | --- |
| [`CHALLENGE.md`](CHALLENGE.md) | Enunciado |
| [`docs/ai/DESIGN.md`](docs/ai/DESIGN.md) | Arquitectura, diseño, decisiones sobre ambigüedades, limitaciones y mejoras |
| [`docs/ai/ROADMAP.md`](docs/ai/ROADMAP.md) | Ruta de desarrollo por fases |
| [`docs/gas.md`](docs/gas.md) | Reporte de gas y optimizaciones evaluadas |
| [`docs/slither.md`](docs/slither.md) | Hallazgos de Slither y sus veredictos |
| [`docs/ai/README.md`](docs/ai/README.md) | Uso de IA: prompts y outputs |

## Requisitos

- **Solo Docker:** Docker Engine 24 o superior con el plugin Compose v2 (`docker compose`).
- No hace falta Node, npm, Foundry, solc ni Python en el host: cada comando, incluidos tests, lint, análisis estático y demo, corre en contenedores.
- El repo se clona con un `git clone` normal, sin `--recursive`, porque no hay submódulos.

## Levantar el stack

```bash
git clone <repo> evm-escrow && cd evm-escrow
docker compose up --build
```

Ese comando hace todo en orden:
1. Construye las imágenes. Ahí se descargan solc 0.8.37 y las dependencias, y se compila el contrato.
2. Levanta Anvil.
3. Deploya el contrato y un token de prueba.
4. Levanta Postgres y corre las migraciones.
5. Arranca el indexador y la API.

Puertos expuestos (configurables en `.env`):

| Servicio | URL |
| --- | --- |
| API | `http://localhost:3000` |
| Anvil (RPC, para conectar una wallet) | `http://localhost:8545`, chain id `31337` |

Para empezar de cero: `docker compose down -v`.

## Pruebas

Todas corren en contenedores y no necesitan el stack levantado, salvo la demo y los ejemplos HTTP.

### Contrato

```bash
docker compose run --rm forge test -vvv                       # unitarios, límites de tiempo, fuzz e invariantes
docker compose run --rm -e FOUNDRY_PROFILE=ci forge test      # más runs de fuzz e invariantes, como en CI
docker compose run --rm forge snapshot --check                # regresiones de gas
docker compose run --rm forge test --match-contract EscrowGasTest --gas-report
docker compose run --rm forge coverage
docker compose run --rm forge fmt --check
```

### Análisis estático

```bash
docker compose run --rm slither
```

### API

```bash
docker compose run --rm npm test            # proyector, estado derivado, indexador contra Anvil y Postgres, endpoints
docker compose run --rm npm run lint
docker compose run --rm npm run typecheck
```

`npm` levanta `postgres` si no está corriendo, y queda corriendo hasta `docker compose down`. Los tests usan su propia base, `escrow_test`, y cada archivo levanta su propio Anvil.

### ABI tipado

Regenerar después de cambiar el contrato; no debe quedar diff:

```bash
docker compose run --rm forge build && docker compose run --rm npm run abi
git diff --exit-code api/src/generated
```

### Demo de punta a punta

```bash
docker compose run --rm demo
```

Si el stack no está corriendo, lo levanta y espera a que `api` esté sano. Crea un escrow por cada camino y muestra el estado que devuelve la API después de cada paso:

1. Escrow A: crear → **confirmar** → `Released`
2. Escrow B: crear → **rechazar** → `Rejected`
3. Escrow C: crear → **cancelar** (dentro de las 2 h) → `CancelledBySender`
4. Escrow D: crear → avanzar 7 días → la API lo informa como `ExpiredRecoverable` → **recuperar** → `Expired`

### Ejemplos HTTP

Con el stack levantado:

```bash
curl http://localhost:3000/health          # DB, RPC, último bloque indexado y lag
curl http://localhost:3000/escrows/1       # un escrow, con su estado efectivo y qué acciones admite
curl "http://localhost:3000/escrows?sender=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266&status=Pending&limit=20&offset=0"
curl "http://localhost:3000/escrows?beneficiary=0x70997970C51812dc3A010C7d01b50e0d17dc79C8&status=ExpiredRecoverable"
```

Las direcciones son las cuentas 0 y 1 de Anvil, las que usa la demo. El formato de cada respuesta y los códigos de error están en [DESIGN](docs/ai/DESIGN.md#endpoints).

Si no tenés `curl` en el host:

```bash
docker run --rm --network host curlimages/curl -s http://localhost:3000/health
```
