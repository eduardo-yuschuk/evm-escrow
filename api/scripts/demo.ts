// End-to-end demo against the docker compose stack: one escrow for each way to resolve it, sent with
// viem from a sender and a beneficiary account. After each step it waits until the API reflects it,
// checks what the API reports and prints it. An unexpected state, or a step the API does not reflect
// in time, ends the demo with exit code 1, so CI runs it as a smoke test.
//
// On Anvil it sends from Anvil's accounts 0 and 1, mines the blocks the API waits for and moves the
// chain's time forward to expire an escrow. On a live network (Sepolia, docker-compose.sepolia.yml)
// the accounts come from SENDER_PRIVATE_KEY and BENEFICIARY_PRIVATE_KEY, the network mines the blocks
// and the demo waits until the escrow expires.
//
// Usage: docker compose run --rm demo
import { setTimeout as sleep } from "node:timers/promises";

import {
  createTestClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseEventLogs,
  publicActions,
  walletActions,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { z } from "zod";

import { loadDeployment, type Deployment } from "../src/deployment.js";
import { escrowAbi, mockErc20Abi } from "../src/generated/contracts.js";
import type { EscrowView } from "../src/http/view.js";

/** With or without 0x, as forge takes it: wallets usually export keys without the prefix. */
const privateKey = z
  .string()
  .trim()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/, "expected a 32-byte hex key (64 hex digits, 0x optional)")
  .transform((key) => (key.startsWith("0x") ? key : `0x${key}`) as Hex);

const envSchema = z.object({
  RPC_URL: z.url(),
  API_URL: z.url(),
  DEPLOYMENTS_FILE: z.string().min(1),
  /** The API's CONFIRMATIONS: on Anvil, after each transaction the demo mines that many blocks. */
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(0),
  /** The API as seen from the host, for the closing hint. */
  HOST_API_URL: z.url().default("http://localhost:3000"),
  /** Required off Anvil. On Anvil, Anvil's accounts 0 and 1 by default. */
  SENDER_PRIVATE_KEY: privateKey.optional(),
  BENEFICIARY_PRIVATE_KEY: privateKey.optional(),
});

/** How long the API may take to reflect a step on Anvil: the indexer polls every second. */
const WAIT_TIMEOUT_MS = 30_000;
/** Off Anvil, added per confirmation: a block every 12 s, with room for missed slots. */
const WAIT_PER_CONFIRMATION_MS = 24_000;
const POLL_INTERVAL_MS = 200;

/** How often viem polls the node for receipts: Anvil mines at once, Sepolia every 12 s. */
const ANVIL_RPC_POLLING_MS = 100;
const LIVE_RPC_POLLING_MS = 2_000;

/** Anvil's default mnemonic, whose accounts Deploy.s.sol funds. Its keys are public: local only. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/** Escrow.Status.Pending, as getEscrow returns it. */
const ONCHAIN_PENDING = 1;

/** Who sends each resolution, the status it leads to, and who gets the funds. */
const RESOLUTIONS = {
  confirm: { by: "beneficiary", status: "Released", to: "beneficiary" },
  reject: { by: "beneficiary", status: "Rejected", to: "sender" },
  cancel: { by: "sender", status: "CancelledBySender", to: "sender" },
  recoverExpired: { by: "sender", status: "Expired", to: "sender" },
} as const;

type Resolution = keyof typeof RESOLUTIONS;

const noActions = { canCancel: false, canConfirm: false, canReject: false, canRecover: false };

function createClient(rpcUrl: string, chainId: number, anvil: boolean) {
  return createTestClient({
    // viem checks that the node is on this chain before sending a transaction.
    chain: defineChain({
      id: chainId,
      name: `Chain ${String(chainId)}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    }),
    mode: "anvil",
    transport: http(rpcUrl),
    pollingInterval: anvil ? ANVIL_RPC_POLLING_MS : LIVE_RPC_POLLING_MS,
    // The demo mines blocks and reads the head right away: a cached block number would be stale.
    cacheTime: 0,
  })
    .extend(publicActions)
    .extend(walletActions);
}

/** An account of the demo, and where it comes from. */
interface Party {
  account: LocalAccount;
  source: string;
}

/** What every step needs: the configuration, the chain, the accounts, the contracts and the token's units. */
interface Demo {
  env: z.infer<typeof envSchema>;
  client: ReturnType<typeof createClient>;
  /** On Anvil the demo mines the blocks and moves the time; elsewhere the network does both. */
  anvil: boolean;
  sender: Party;
  beneficiary: Party;
  deployment: Deployment;
  /** How long the API may take to reflect a step. */
  waitTimeoutMs: number;
  /** A whole number of tokens in base units. */
  tokens: (whole: number) => bigint;
  format: (amount: bigint) => string;
}

/** The accounts from the environment, or Anvil's accounts 0 and 1 on Anvil. */
function parties(
  env: z.infer<typeof envSchema>,
  anvil: boolean,
): { sender: Party; beneficiary: Party } {
  const { SENDER_PRIVATE_KEY: senderKey, BENEFICIARY_PRIVATE_KEY: beneficiaryKey } = env;
  if (senderKey && beneficiaryKey) {
    return {
      sender: { account: privateKeyToAccount(senderKey), source: "SENDER_PRIVATE_KEY" },
      beneficiary: {
        account: privateKeyToAccount(beneficiaryKey),
        source: "BENEFICIARY_PRIVATE_KEY",
      },
    };
  }
  if (senderKey || beneficiaryKey || !anvil) {
    throw new Error("Set both SENDER_PRIVATE_KEY and BENEFICIARY_PRIVATE_KEY (required off Anvil)");
  }
  return {
    sender: {
      account: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 }),
      source: "Anvil account 0",
    },
    beneficiary: {
      account: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 }),
      source: "Anvil account 1",
    },
  };
}

async function setUp(): Promise<Demo> {
  // An empty variable means its default, as in the API's configuration.
  const defined = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ""),
  );
  const parsed = envSchema.safeParse(defined);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  const deployment = await loadDeployment(env.DEPLOYMENTS_FILE);
  if (deployment.token === zeroAddress) {
    throw new Error(
      `${env.DEPLOYMENTS_FILE} has no test token: deploy with DEPLOY_MOCK_TOKEN=true`,
    );
  }
  const anvil = deployment.chainId === foundry.id;
  const { sender, beneficiary } = parties(env, anvil);
  const client = createClient(env.RPC_URL, deployment.chainId, anvil);
  const token = { address: deployment.token, abi: mockErc20Abi } as const;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ ...token, functionName: "symbol" }),
    client.readContract({ ...token, functionName: "decimals" }),
  ]);
  return {
    env,
    client,
    anvil,
    sender,
    beneficiary,
    deployment,
    waitTimeoutMs: WAIT_TIMEOUT_MS + (anvil ? 0 : env.CONFIRMATIONS * WAIT_PER_CONFIRMATION_MS),
    tokens: (whole) => BigInt(whole) * 10n ** BigInt(decimals),
    format: (amount) => `${formatUnits(amount, decimals)} ${symbol}`,
  };
}

/** Waits for the transaction and fails if it reverted. On Anvil, mines the blocks the indexer waits for. */
async function mined({ env, client, anvil }: Demo, hash: Hash): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  // Anvil mines a block per transaction only, so nothing else would confirm this one.
  if (anvil && env.CONFIRMATIONS > 0) await client.mine({ blocks: env.CONFIRMATIONS });
  return receipt;
}

async function balanceOf({ client, deployment }: Demo, account: Address): Promise<bigint> {
  return client.readContract({
    address: deployment.token,
    abi: mockErc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

/** The escrow as the API returns it, or undefined while the indexer has not seen it. */
async function getView({ env }: Demo, id: bigint): Promise<EscrowView | undefined> {
  const response = await fetch(new URL(`/escrows/${String(id)}`, env.API_URL));
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${await response.text()}`);
  return (await response.json()) as EscrowView;
}

/** Polls the API until `ready` holds, that is, until the API reflects the step. */
async function waitForApi(
  demo: Demo,
  id: bigint,
  what: string,
  ready: (view: EscrowView) => boolean,
): Promise<EscrowView> {
  const deadline = Date.now() + demo.waitTimeoutMs;
  for (;;) {
    let last: string;
    try {
      const view = await getView(demo, id);
      if (view && ready(view)) return view;
      last = view ? `status ${view.status}` : "404";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The API did not reflect ${what} of escrow #${String(id)} within ` +
          `${String(demo.waitTimeoutMs / 1000)} s. Last answer: ${last}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Fails with every field of `view` that differs from `expected`. */
function check(step: string, view: EscrowView, expected: Partial<EscrowView>): void {
  const wrong = Object.entries(expected)
    .filter(([key, value]) => view[key as keyof EscrowView] !== value)
    .map(([key, value]) => {
      const actual = JSON.stringify(view[key as keyof EscrowView]);
      return `${key} is ${actual}, expected ${JSON.stringify(value)}`;
    });
  if (wrong.length > 0) {
    throw new Error(`${step} of escrow #${view.id}: ${wrong.join("; ")}`);
  }
}

function actionsOf(view: EscrowView): string {
  const actions = [
    view.canCancel && "cancel",
    view.canConfirm && "confirm",
    view.canReject && "reject",
    view.canRecover && "recover",
  ].filter((action) => action !== false);
  return actions.length > 0 ? `can ${actions.join(", ")}` : "no actions";
}

function print(label: string, step: string, view: EscrowView, note: string): void {
  const id = `#${view.id}`;
  console.log(
    `${label.padEnd(3)}${step.padEnd(18)}${id.padEnd(5)}${view.status.padEnd(20)}${note}`,
  );
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${String(seconds / 86_400)} days`;
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)} h`;
  if (seconds % 60 === 0) return `${String(seconds / 60)} min`;
  return `${String(seconds)} s`;
}

async function create(demo: Demo, label: string, amount: bigint): Promise<bigint> {
  const { client, deployment, format, sender, beneficiary } = demo;
  const receipt = await mined(
    demo,
    await client.writeContract({
      account: sender.account,
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "createEscrow",
      args: [deployment.token, beneficiary.account.address, amount],
    }),
  );
  const [created] = parseEventLogs({
    abi: escrowAbi,
    eventName: "EscrowCreated",
    logs: receipt.logs,
  });
  if (!created) throw new Error(`${receipt.transactionHash} created no escrow`);
  const { id } = created.args;

  const view = await waitForApi(demo, id, "the creation", () => true);
  check("create", view, {
    status: "Pending",
    onchainStatus: "Pending",
    canCancel: true,
    canConfirm: true,
    canReject: true,
    canRecover: false,
    sender: sender.account.address,
    beneficiary: beneficiary.account.address,
    token: getAddress(deployment.token),
    amount: amount.toString(),
    createdTx: receipt.transactionHash,
    resolvedTx: null,
  });
  print(label, `create ${format(amount)}`, view, actionsOf(view));
  return id;
}

async function resolve(
  demo: Demo,
  id: bigint,
  amount: bigint,
  resolution: Resolution,
): Promise<void> {
  const { client, deployment, format } = demo;
  const { by, status, to } = RESOLUTIONS[resolution];
  const recipient = demo[to].account.address;
  const before = await balanceOf(demo, recipient);
  const receipt = await mined(
    demo,
    await client.writeContract({
      account: demo[by].account,
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: resolution,
      args: [id],
    }),
  );

  const view = await waitForApi(demo, id, resolution, (escrow) => escrow.resolvedTx !== null);
  check(resolution, view, {
    status,
    onchainStatus: status,
    ...noActions,
    resolvedTx: receipt.transactionHash,
  });
  const received = (await balanceOf(demo, recipient)) - before;
  if (received !== amount) {
    throw new Error(`${resolution} of escrow #${view.id}: the ${to} got ${format(received)}`);
  }
  const destination = to === "beneficiary" ? "to the beneficiary" : "back to the sender";
  print("", resolution, view, `${format(amount)} ${destination}`);
}

/** Waits for a block with a timestamp of at least `target` and returns that timestamp. */
async function waitForChainTime(demo: Demo, target: bigint): Promise<bigint> {
  for (;;) {
    const { timestamp } = await demo.client.getBlock();
    if (timestamp >= target) return timestamp;
    // The chain's time follows the wall clock: the next block after this sleep should do.
    await sleep(Number(target - timestamp) * 1000);
  }
}

/**
 * Lets the escrow's TTL pass without any transaction to the contract: on Anvil by moving the chain's
 * time forward, elsewhere by waiting for a block from `expiresAt` on.
 */
async function expire(demo: Demo, id: bigint): Promise<void> {
  const { client, deployment, anvil } = demo;
  const getEscrow = {
    address: deployment.escrow,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [id],
  } as const;
  let timestamp: bigint;
  if (anvil) {
    await client.increaseTime({ seconds: deployment.ttl });
    await client.mine({ blocks: 1 });
    ({ timestamp } = await client.getBlock());
  } else {
    const { expiresAt } = await client.readContract(getEscrow);
    timestamp = await waitForChainTime(demo, expiresAt);
  }

  // The API's clock is the timestamp of the latest block.
  const view = await waitForApi(
    demo,
    id,
    "the new time",
    (escrow) => BigInt(escrow.now) >= timestamp,
  );
  check("expiry", view, {
    status: "ExpiredRecoverable",
    onchainStatus: "Pending",
    ...noActions,
    canRecover: true,
    resolvedTx: null,
  });
  const onchain = await client.readContract(getEscrow);
  if (onchain.status !== ONCHAIN_PENDING) {
    throw new Error(`Escrow #${view.id} is no longer Pending on-chain`);
  }
  const step = anvil ? `advance ${formatDuration(deployment.ttl)}` : "wait for expiry";
  print("", step, view, `on-chain Pending, ${actionsOf(view)}`);
}

async function main(): Promise<void> {
  const demo = await setUp();
  const { env, client, anvil, sender, beneficiary, deployment, tokens, format } = demo;
  const amounts = { A: tokens(100), B: tokens(200), C: tokens(300), D: tokens(400) };
  const total = Object.values(amounts).reduce((sum, amount) => sum + amount, 0n);

  console.log(`Escrow demo: API ${env.API_URL}, chain ${String(deployment.chainId)}`);
  console.log(`  escrow       ${getAddress(deployment.escrow)}`);
  console.log(`  token        ${getAddress(deployment.token)}`);
  console.log(`  sender       ${sender.account.address}  ${sender.source}`);
  console.log(`  beneficiary  ${beneficiary.account.address}  ${beneficiary.source}`);
  console.log(
    `  windows      cancel ${formatDuration(deployment.cancelWindow)}, ` +
      `expiry ${formatDuration(deployment.ttl)}`,
  );
  if (!anvil) {
    console.log(
      `Each step waits for ${String(env.CONFIRMATIONS)} confirmations, ` +
        "and D waits until it expires: this takes a while.",
    );
  }
  console.log();

  for (const { account, source } of [sender, beneficiary]) {
    if ((await client.getBalance({ address: account.address })) === 0n) {
      throw new Error(`${account.address} (${source}) has no ETH to pay for gas`);
    }
  }

  // Off Anvil nobody gets tokens at deploy time; the test token's mint is open.
  const balance = await balanceOf(demo, sender.account.address);
  if (balance < total) {
    await mined(
      demo,
      await client.writeContract({
        account: sender.account,
        address: deployment.token,
        abi: mockErc20Abi,
        functionName: "mint",
        args: [sender.account.address, total - balance],
      }),
    );
    console.log(`mint ${format(total - balance)}`);
  }

  await mined(
    demo,
    await client.writeContract({
      account: sender.account,
      address: deployment.token,
      abi: mockErc20Abi,
      functionName: "approve",
      args: [deployment.escrow, total],
    }),
  );
  console.log(`approve ${format(total)}`);

  // Each escrow is created right before it is resolved. The expiring one goes last, because moving
  // the chain's time forward affects every escrow at once.
  const a = await create(demo, "A", amounts.A);
  await resolve(demo, a, amounts.A, "confirm");
  const b = await create(demo, "B", amounts.B);
  await resolve(demo, b, amounts.B, "reject");
  const c = await create(demo, "C", amounts.C);
  await resolve(demo, c, amounts.C, "cancel");
  const d = await create(demo, "D", amounts.D);
  await expire(demo, d);
  await resolve(demo, d, amounts.D, "recoverExpired");

  console.log();
  console.log("Every state matched. The full views, from the host:");
  console.log(`  curl "${env.HOST_API_URL}/escrows?sender=${sender.account.address}&limit=4"`);
}

try {
  await main();
} catch (error) {
  console.error(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
