# evm-escrow

[![contracts](https://github.com/eduardo-yuschuk/evm-escrow/actions/workflows/contracts.yml/badge.svg?branch=main)](https://github.com/eduardo-yuschuk/evm-escrow/actions/workflows/contracts.yml)
[![api](https://github.com/eduardo-yuschuk/evm-escrow/actions/workflows/api.yml/badge.svg?branch=main)](https://github.com/eduardo-yuschuk/evm-escrow/actions/workflows/api.yml)
[![e2e](https://github.com/eduardo-yuschuk/evm-escrow/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/eduardo-yuschuk/evm-escrow/actions/workflows/e2e.yml)

Escrow de tokens ERC-20 en Solidity, más una API/indexador en TypeScript que proyecta los eventos del contrato en Postgres.

- **Contrato** (`contracts/`): un solo contrato gestiona muchos escrows. El enviador deposita tokens y el beneficiario los confirma o rechaza; el enviador puede cancelar en las primeras 2 horas y recuperar los fondos después de 7 días. Foundry, Solidity 0.8.37 y OpenZeppelin.
- **API e indexador** (`api/`): Node.js, TypeScript y viem. Indexa los eventos en Postgres y expone el estado de cada escrow por HTTP.
- **Todo corre con Docker Compose:** nodo local (Anvil), deploy, base de datos, API, tests, análisis estático y demo.
- **También en Sepolia,** con ventanas cortas para ver un vencimiento en vivo: ver [Sepolia](#sepolia).

## Documentación

| Documento | Contenido |
| --- | --- |
| [`docs/ai/DESIGN.md`](docs/ai/DESIGN.md) | Arquitectura, diseño, decisiones sobre ambigüedades, limitaciones y mejoras, en detalle |
| [`docs/security.md`](docs/security.md) | Revisión de seguridad del contrato, punto por punto |
| [`docs/correctness.md`](docs/correctness.md) | Cada regla del enunciado, con su implementación y sus tests |
| [`docs/gas.md`](docs/gas.md) | Reporte de gas y optimizaciones evaluadas |
| [`docs/slither.md`](docs/slither.md) | Hallazgos de Slither y sus veredictos |
| [`docs/ai/ROADMAP.md`](docs/ai/ROADMAP.md) | Ruta de desarrollo por fases |
| [`docs/ai/README.md`](docs/ai/README.md) | Uso de IA: prompts y outputs |

## Requisitos

- **Solo Docker:** Docker Engine 24 o superior con el plugin Compose 2.20 o superior (`docker compose`).
- No hace falta Node, npm, Foundry, solc ni Python en el host: cada comando, incluidos tests, lint, análisis estático y demo, corre en contenedores. Por eso no hay un `npm install`: las dependencias se instalan dentro de las imágenes.
- El repo se clona con un `git clone` normal, sin `--recursive`, porque no hay submódulos.

## Levantar el stack

```bash
git clone https://github.com/eduardo-yuschuk/evm-escrow.git && cd evm-escrow
docker compose up --build
```

Ese comando hace todo en orden:
1. Construye las imágenes. Ahí se descargan solc 0.8.37 y las dependencias, y se compila el contrato.
2. Levanta Anvil y Postgres.
3. Deploya el contrato y un token de prueba, y le da 1.000.000 de tokens a cada una de las 10 cuentas de Anvil.
4. Arranca la API, que corre las migraciones, indexa los eventos y sirve HTTP.

En una máquina limpia, el stack queda sano en menos de un minuto. Para dejarlo en segundo plano y esperar a que la API esté sana: `docker compose up --build -d --wait`.

Puertos, publicados solo en `127.0.0.1` y configurables en `.env` (ver [`.env.example`](.env.example)):

| Servicio | URL |
| --- | --- |
| API | `http://localhost:3000` |
| Anvil (RPC, para conectar una wallet) | `http://localhost:8545`, chain id `31337` |

- **Logs de Anvil:** `docker compose up` no los muestra, porque Anvil registra cada llamada RPC. Se ven con `docker compose logs -f anvil`.
- **Base de datos:** Postgres no publica su puerto. Para consultarla: `docker compose exec postgres psql -U escrow escrow`.
- **Reinicios:** Anvil no guarda la cadena. Después de `docker compose down` y `up`, o de un `Ctrl+C` y `up`, la cadena es nueva: el contrato se deploya de nuevo, y la API vacía la base y reindexa.
- **Empezar de cero:** `docker compose down -v`, que además borra la base y el archivo de deploy.

## Pruebas

Todas corren en contenedores y no necesitan el stack levantado, salvo los ejemplos HTTP. La demo lo levanta si hace falta.

CI corre estos mismos comandos en GitHub Actions, en cada push a `main` y en cada pull request:

| Workflow | Qué corre |
| --- | --- |
| [`contracts`](.github/workflows/contracts.yml) | Formato, tests con el perfil `ci`, los dos chequeos de gas y Slither |
| [`api`](.github/workflows/api.yml) | Lint, typecheck, tests de la API y que el ABI generado esté al día |
| [`e2e`](.github/workflows/e2e.yml) | El stack completo y la demo contra él |

### Contrato

```bash
docker compose run --rm forge test -vvv                       # unitarios, límites de tiempo, fuzz e invariantes
docker compose run --rm -e FOUNDRY_PROFILE=ci forge test      # más runs de fuzz e invariantes, como en CI
docker compose run --rm forge snapshot --check                # regresiones de gas
docker compose run --rm forge test --match-contract EscrowGasTest --gas-report
docker compose run --rm forge coverage
docker compose run --rm forge fmt --check
```

81 tests, con 100 % de cobertura en `Escrow.sol`.

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

79 tests. `npm` levanta `postgres` si no está corriendo, y queda corriendo hasta `docker compose down`. Los tests usan su propia base, `escrow_test`, y cada archivo levanta su propio Anvil.

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

Salida de una corrida sobre un stack recién levantado:

```
Escrow demo: API http://api:3000, chain 31337
  escrow       0x5FbDB2315678afecb367f032d93F642f64180aa3
  token        0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
  sender       0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  Anvil account 0
  beneficiary  0x70997970C51812dc3A010C7d01b50e0d17dc79C8  Anvil account 1
  windows      cancel 2 h, expiry 7 days

approve 1000 MOCK
A  create 100 MOCK   #1   Pending             can cancel, confirm, reject
   confirm           #1   Released            100 MOCK to the beneficiary
B  create 200 MOCK   #2   Pending             can cancel, confirm, reject
   reject            #2   Rejected            200 MOCK back to the sender
C  create 300 MOCK   #3   Pending             can cancel, confirm, reject
   cancel            #3   CancelledBySender   300 MOCK back to the sender
D  create 400 MOCK   #4   Pending             can cancel, confirm, reject
   advance 7 days    #4   ExpiredRecoverable  on-chain Pending, can recover
   recoverExpired    #4   Expired             400 MOCK back to the sender

Every state matched. The full views, from the host:
  curl "http://localhost:3000/escrows?sender=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266&limit=4"
```

- **Verifica cada paso.** Espera a que la API refleje el paso y compara el estado, las acciones admitidas, los hashes de las transacciones y los saldos. Si algo no coincide, o la API no lo refleja en 30 s, termina con código 1. Por eso sirve como smoke test.
- **Se puede repetir.** Cada corrida crea cuatro escrows nuevos y adelanta 7 días el reloj de Anvil.

### Ejemplos HTTP

Con el stack levantado. Las direcciones son las cuentas 0 y 1 de Anvil, las que usa la demo, y las respuestas son las de la API después de la corrida de arriba, formateadas. El formato de cada campo y los códigos de error están en [DESIGN](docs/ai/DESIGN.md#endpoints).

```bash
curl http://localhost:3000/health          # DB, RPC, último bloque indexado y lag
```

```json
{ "status": "ok", "db": "ok", "rpc": "ok", "lastIndexedBlock": 11, "chainHead": 11, "lag": 0 }
```

```bash
curl http://localhost:3000/escrows/1       # un escrow, con su estado efectivo y qué acciones admite
```

```json
{
  "id": "1",
  "sender": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "beneficiary": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "token": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  "amount": "100000000000000000000",
  "createdAt": 1792078864,
  "cancelDeadline": 1792086064,
  "expiresAt": 1792683664,
  "onchainStatus": "Released",
  "status": "Released",
  "canCancel": false,
  "canConfirm": false,
  "canReject": false,
  "canRecover": false,
  "createdTx": "0x711ef443c8af106075ffbe116b95528727ceb3a2f1ede89f1334a79ae9351265",
  "resolvedTx": "0x6f6c9fc67e70bb407508366cb37170fead1db8e7ab7417fbdfa8bd0739813970",
  "resolvedAt": 1792078864,
  "now": 1792683671
}
```

```bash
curl "http://localhost:3000/escrows?sender=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266&status=Expired&limit=20&offset=0"
```

```
{ "items": [{ "id": "4", "status": "Expired", "amount": "400000000000000000000", … }], "limit": 20, "offset": 0, "total": 1 }
```

Cada item tiene el formato de `/escrows/:id`. Los filtros son `sender`, `beneficiary` y `status`, combinables; `status` filtra por el estado efectivo:

```bash
curl "http://localhost:3000/escrows?beneficiary=0x70997970C51812dc3A010C7d01b50e0d17dc79C8&status=ExpiredRecoverable"
```

```json
{ "items": [], "limit": 20, "offset": 0, "total": 0 }
```

Vacío, porque la demo recupera el escrow D. Mientras está vencido sin recuperar, el paso `advance 7 days` de la demo lo muestra como `ExpiredRecoverable`.

Errores, con el formato de fastify:

```bash
curl http://localhost:3000/escrows/99                                                  # 404
curl "http://localhost:3000/escrows?benficiary=0x70997970C51812dc3A010C7d01b50e0d17dc79C8"  # 400: parámetro desconocido
```

```
{ "statusCode": 404, "error": "Not Found", "message": "Escrow 99 not found" }
{ "statusCode": 400, "error": "Bad Request", "message": "Unrecognized key: \"benficiary\"" }
```

Si no tenés `curl` en el host:

```bash
docker run --rm --network host curlimages/curl:8.22.0 -s http://localhost:3000/health
```

## Sepolia

El mismo contrato está deployado en Sepolia con ventanas cortas, 5 minutos para cancelar y 10 de TTL, para ver un vencimiento en vivo: en una testnet no se puede adelantar el reloj. Todo está en [`docker-compose.sepolia.yml`](docker-compose.sepolia.yml), un proyecto aparte del stack local, con su propia base y la API en el puerto 3001. El diseño está en [DESIGN](docs/ai/DESIGN.md#sepolia).

| Contrato | Dirección, verificada en Etherscan |
| --- | --- |
| `Escrow` (ventanas de 300 y 600 s) | [`0x9a3b2D1C29c049F65875b6DfA0Cf869485625055`](https://sepolia.etherscan.io/address/0x9a3b2d1c29c049f65875b6dfa0cf869485625055#code) |
| Token de prueba `MOCK`, con mint abierto | [`0xbCb0FcD74C568Be777E86734db21d35EeB2C826e`](https://sepolia.etherscan.io/address/0xbcb0fcd74c568be777e86734db21d35eeb2c826e#code) |

El archivo de deploy es [`contracts/deployments/11155111.json`](contracts/deployments/11155111.json).

**Indexar el contrato deployado** no necesita claves ni cuentas: usa el archivo de deploy versionado y un RPC público.

```bash
docker compose -f docker-compose.sepolia.yml up --build
curl "http://localhost:3001/escrows?limit=4"
```

La API espera 12 confirmaciones, así que refleja la cadena con unos 2,5 minutos de atraso.

**Deploy y demo propios.** Necesitan dos cuentas con Sepolia ETH y, para verificar el contrato, una API key de Etherscan. Para correr la demo contra el contrato ya deployado alcanzan los pasos 1 y 4, porque la demo mintea sus propios tokens de prueba:

1. Copiar [`.env.sepolia.example`](.env.sepolia.example) a `.env.sepolia`, que git ignora, y completar las claves.
2. Borrar `contracts/deployments/11155111.json`: el deploy no se repite mientras ese archivo describa Sepolia.
3. Deployar y verificar: `docker compose -f docker-compose.sepolia.yml run --rm deploy`. Las ventanas se cambian con `SEPOLIA_CANCEL_WINDOW` y `SEPOLIA_TTL` en `.env`.
4. Correr la demo: `docker compose -f docker-compose.sepolia.yml run --rm demo`. Es la misma de Anvil, pero espera las confirmaciones y el vencimiento en tiempo real: tarda cerca de media hora.

## Decisiones de diseño

Una línea por decisión; el desarrollo de cada una está en [DESIGN](docs/ai/DESIGN.md), y las ambigüedades del enunciado, numeradas en su [tabla de decisiones](docs/ai/DESIGN.md#decisiones-sobre-ambigüedades-del-enunciado).

**Contrato**
- **Ventanas semiabiertas:** cancelar con `t < +2h`, confirmar y rechazar con `t < +7d`, recuperar con `t >= +7d`; a los 7 días no se solapan (decisiones 1 y 2).
- **El beneficiario actúa desde el primer segundo,** también durante las 2 h del enviador: gana la primera transacción minada (decisión 3).
- **Ventanas `immutable`,** validadas en el constructor, para poder deployar con ventanas cortas en una testnet ([Interfaz](docs/ai/DESIGN.md#interfaz)).
- **Monto recibido, no pedido:** con tokens fee-on-transfer, un escrow nunca paga más de lo que aportó (decisión 7).
- **Sin owner, pausa, upgrade ni `rescue`:** nadie más que las partes puede mover fondos (decisión 9, [Seguridad](docs/ai/DESIGN.md#seguridad)).
- **Push:** los fondos se transfieren en la misma llamada que resuelve el escrow (decisión 15).
- **CEI al resolver y `nonReentrant` en las cinco funciones que mueven fondos,** con `ReentrancyGuardTransient` ([Guard de reentrada](docs/ai/DESIGN.md#guard-de-reentrada-reentrancyguardtransient)).
- **`SafeERC20`** para los tokens que no devuelven `bool`, y un token sin código se rechaza (decisión 12).
- **Ids secuenciales desde 1,** asignados por el contrato (decisión 10).
- **Custom errors con el id y el dato que falló;** `getEscrow` revierte si el id no existe ([Custom errors](docs/ai/DESIGN.md#custom-errors), decisión 11).
- **Eventos de resolución solo con el `id`:** el indexador lo cruza con `EscrowCreated`, y cada resolución gasta menos gas (decisión 16).
- **Storage en 4 slots,** con los deadlines derivados de `createdAt` y timestamps `uint64` ([Storage](docs/ai/DESIGN.md#storage)).

**API e indexador**
- **Polling con `eth_getLogs` y checkpoint transaccional,** en lugar de una suscripción WebSocket (decisión 18).
- **Idempotencia por `(tx_hash, log_index)`** y un proyector puro que repite sus guardas en SQL ([Indexador](docs/ai/DESIGN.md#indexador)).
- **Reorgs: N confirmaciones,** 0 en Anvil y 12 en Sepolia (decisión 19).
- **Guard de cadena:** detecta un Anvil reiniciado y reindexa, o aborta si se configuró así ([Indexador](docs/ai/DESIGN.md#indexador)).
- **El reloj es el timestamp del último bloque,** no el del servidor (decisión 17).
- **`ExpiredRecoverable` es el estado derivado** de un `Pending` vencido; `Expired` queda para el final on-chain (decisión 6).
- **Flags `canCancel`, `canConfirm`, `canReject` y `canRecover`** en cada escrow ([Estado derivado](docs/ai/DESIGN.md#estado-derivado-del-tiempo)).
- **El filtro `status` usa el estado efectivo,** el mismo que se devuelve (decisión 20).
- **`uint256` como string y paginación `limit`/`offset`,** con `400` ante un valor fuera de rango o un parámetro desconocido (decisión 22, [Endpoints](docs/ai/DESIGN.md#endpoints)).
- **`/health` informa DB, RPC, último bloque indexado, head y lag,** con `503` si algo falla (decisión 23).
- **Indexador y API en un proceso,** separables con `MODE` ([Proceso y configuración](docs/ai/DESIGN.md#proceso-y-configuración)).
- **Postgres con migraciones propias** y dominios que rechazan direcciones, hashes y montos inválidos ([Esquema](docs/ai/DESIGN.md#esquema)).

**Ejecución**
- **Solo Docker,** con versiones fijadas: el evaluador no necesita nada más (decisión 27).
- **Soldeer en lugar de submódulos de git** ([Arquitectura](docs/ai/DESIGN.md#arquitectura)).
- **CI con los mismos comandos del README,** sin instalar nada en el runner ([Ejecución y tests](docs/ai/DESIGN.md#ejecución-y-tests)).
- **La demo es un smoke test:** verifica cada paso contra la API y sale con código 1 si algo no coincide ([Ejecución y tests](docs/ai/DESIGN.md#ejecución-y-tests)).
- **Sepolia con ventanas de 5 y 10 minutos,** archivo de deploy versionado y claves fuera del repo ([Sepolia](docs/ai/DESIGN.md#sepolia)).

## Supuestos

- "Si el beneficiario no confirmó **ni canceló**" se lee como "ni rechazó": el beneficiario no cancela (decisión 4).
- "La operación queda cancelada" al vencer es coloquial: el estado es `Expired` (decisión 5).
- El balance del contrato es **mayor o igual** a la suma de los pendientes, no igual: alguien puede donarle tokens (decisión 8).
- Solo el enviador recupera un escrow vencido, como dice la tabla (decisión 14).
- Un escrow tiene un solo monto, el recibido (decisión 21).
- "Vencer" en la demo es avanzar el tiempo, mostrar `ExpiredRecoverable` y recién ahí recuperar (decisión 24).
- No hay reorgs más profundos que las confirmaciones configuradas (decisión 19).
- Los tokens se comportan como ERC-20: rebasing y tokens que debitan más que el monto no están soportados ([Limitaciones](docs/ai/DESIGN.md#limitaciones-conocidas)).

## Limitaciones conocidas

Detalle en [DESIGN](docs/ai/DESIGN.md#limitaciones-conocidas) y en la [revisión de seguridad](docs/security.md). Todas las de tokens afectan solo a los escrows de ese token.

- **Blacklist o pausa del token** (USDC, USDT): si alcanzan al enviador o al contrato, los fondos quedan trabados hasta que el token los libere.
- **Tokens que debitan más que el monto** (fee cobrada aparte, rebasing negativo): los últimos escrows de ese token quedan cortos.
- **Donaciones directas al contrato:** no se pagan nunca y quedan trabadas.
- **Carrera entre 0 y 2 h:** enviador y beneficiario pueden adelantarse; el contrato garantiza que solo una resolución tenga efecto.
- **Reorgs más profundos que N:** fuera del modelo.

## Qué mejoraría con más tiempo

Detalle en [DESIGN](docs/ai/DESIGN.md#qué-mejoraría-con-más-tiempo).

- **Owner limitado a la creación:** pausar nuevos escrows y una whitelist de tokens, sin tocar los existentes.
- **Patrón pull** opcional, contra las blacklists.
- **Rollback de reorgs por `blockHash`,** para indexar sin esperar confirmaciones, o el tag `finalized`.
- **`createWithPermit`** (EIP-2612).
- **Webhooks o SSE** con outbox transaccional.
- **Paginación por cursor,** métricas Prometheus, rate limiting y soporte multi-contrato.
