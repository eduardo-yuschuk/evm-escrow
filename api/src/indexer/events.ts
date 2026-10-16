import {
  decodeEventLog,
  formatLog,
  numberToHex,
  toEventSelector,
  type Address,
  type Hash,
  type Log,
} from "viem";

import type { ChainClient } from "../chain.js";
import { escrowAbi } from "../generated/contracts.js";

export interface EscrowCreatedEvent {
  name: "EscrowCreated";
  args: {
    id: bigint;
    sender: Address;
    beneficiary: Address;
    token: Address;
    amount: bigint;
    cancelDeadline: bigint;
    expiresAt: bigint;
  };
}

export type ResolutionEventName =
  "EscrowCancelled" | "EscrowReleased" | "EscrowRejected" | "EscrowExpired";

export interface ResolutionEvent {
  name: ResolutionEventName;
  args: { id: bigint };
}

export interface EscrowWithdrawnEvent {
  name: "EscrowWithdrawn";
  args: { id: bigint; debited: bigint; received: bigint };
}

export type EscrowEvent = EscrowCreatedEvent | ResolutionEvent | EscrowWithdrawnEvent;

/** A decoded Escrow event and where it happened. Addresses and hashes are lowercase. */
export interface IndexedEvent {
  blockNumber: bigint;
  blockHash: Hash;
  blockTimestamp: bigint;
  txHash: Hash;
  logIndex: number;
  event: EscrowEvent;
}

/** topic0 of every event in the Escrow ABI. */
const EVENT_TOPICS = escrowAbi
  .filter((item) => item.type === "event")
  .map((item) => toEventSelector(item));

/** Fails on any log that does not match the ABI, instead of skipping it like viem's getLogs. */
function decode(log: Log): EscrowEvent {
  const decoded = decodeEventLog({
    abi: escrowAbi,
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  switch (decoded.eventName) {
    case "EscrowCreated": {
      const { args } = decoded;
      return {
        name: "EscrowCreated",
        args: {
          id: args.id,
          sender: args.sender.toLowerCase() as Address,
          beneficiary: args.beneficiary.toLowerCase() as Address,
          token: args.token.toLowerCase() as Address,
          amount: args.amount,
          cancelDeadline: args.cancelDeadline,
          expiresAt: args.expiresAt,
        },
      };
    }
    case "EscrowCancelled":
    case "EscrowReleased":
    case "EscrowRejected":
    case "EscrowExpired":
      return { name: decoded.eventName, args: { id: decoded.args.id } };
    case "EscrowWithdrawn": {
      const { id, debited, received } = decoded.args;
      return { name: "EscrowWithdrawn", args: { id, debited, received } };
    }
  }
}

/**
 * Escrow events emitted by `escrow` in `[fromBlock, toBlock]`, sorted by (blockNumber, logIndex).
 * The block timestamp comes from the log when the node includes it (Anvil, recent Geth) and from
 * the block otherwise, fetched once per block.
 */
export async function fetchEvents(
  client: ChainClient,
  escrow: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<IndexedEvent[]> {
  const rpcLogs = await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: escrow,
        topics: [EVENT_TOPICS],
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(toBlock),
      },
    ],
  });

  const blockTimestamps = new Map<bigint, Promise<bigint>>();
  const timestampOf = (log: Log & { blockNumber: bigint }): Promise<bigint> => {
    if (log.blockTimestamp != null) return Promise.resolve(log.blockTimestamp);
    let timestamp = blockTimestamps.get(log.blockNumber);
    if (!timestamp) {
      timestamp = client
        .getBlock({ blockNumber: log.blockNumber })
        .then((block) => block.timestamp);
      blockTimestamps.set(log.blockNumber, timestamp);
    }
    return timestamp;
  };

  const events = await Promise.all(
    rpcLogs.map(async (rpcLog) => {
      const log = formatLog(rpcLog);
      const { blockNumber, blockHash, transactionHash, logIndex } = log;
      if (
        blockNumber === null ||
        blockHash === null ||
        transactionHash === null ||
        logIndex === null
      ) {
        throw new Error(`Pending log returned for blocks ${String(fromBlock)}-${String(toBlock)}`);
      }
      return {
        blockNumber,
        blockHash: blockHash.toLowerCase() as Hash,
        blockTimestamp: await timestampOf({ ...log, blockNumber }),
        txHash: transactionHash.toLowerCase() as Hash,
        logIndex,
        event: decode(log),
      };
    }),
  );

  return events.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
}
