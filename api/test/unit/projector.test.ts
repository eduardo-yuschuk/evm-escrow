import type { Address, Hash } from "viem";
import { describe, expect, it } from "vitest";

import type { EscrowEvent, IndexedEvent, ResolutionEventName } from "../../src/indexer/events.js";
import { applyEvent, type EscrowState, type FinalStatus } from "../../src/indexer/projector.js";

const sender = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const beneficiary = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;
const token = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" as Address;

const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, "0")}`;
const CREATE_TX = hash(1);
const RESOLVE_TX = hash(2);
const OTHER_TX = hash(3);
const WITHDRAW_TX = hash(4);

function indexed(event: EscrowEvent, txHash: Hash): IndexedEvent {
  return {
    blockNumber: 10n,
    blockHash: hash(0xb10c),
    blockTimestamp: 1_000n,
    txHash,
    logIndex: 0,
    event,
  };
}

const created = indexed(
  {
    name: "EscrowCreated",
    args: {
      id: 1n,
      sender,
      beneficiary,
      token,
      amount: 5n,
      cancelDeadline: 8_200n,
      expiresAt: 605_800n,
    },
  },
  CREATE_TX,
);

const resolution = (name: ResolutionEventName, txHash: Hash) =>
  indexed({ name, args: { id: 1n } }, txHash);

const withdrawal = (debited: bigint, received = debited) =>
  indexed({ name: "EscrowWithdrawn", args: { id: 1n, debited, received } }, WITHDRAW_TX);

const RESOLUTIONS: [ResolutionEventName, FinalStatus][] = [
  ["EscrowCancelled", "CancelledBySender"],
  ["EscrowReleased", "Released"],
  ["EscrowRejected", "Rejected"],
  ["EscrowExpired", "Expired"],
];

const pending: EscrowState = {
  status: "Pending",
  amount: 5n,
  withdrawn: 0n,
  createdTx: CREATE_TX,
  resolvedTx: null,
};
const released: EscrowState = { ...pending, status: "Released", resolvedTx: RESOLVE_TX };

describe("applyEvent", () => {
  it("creates an escrow that is not projected yet, timestamped with its block", () => {
    expect(applyEvent(undefined, created)).toEqual({
      kind: "create",
      escrow: {
        id: 1n,
        sender,
        beneficiary,
        token,
        amount: 5n,
        createdAt: 1_000n,
        cancelDeadline: 8_200n,
        expiresAt: 605_800n,
        createdTx: CREATE_TX,
      },
    });
  });

  it.each(RESOLUTIONS)("resolves a Pending escrow on %s as %s", (name, status) => {
    expect(applyEvent(pending, resolution(name, RESOLVE_TX))).toEqual({
      kind: "resolve",
      id: 1n,
      status,
      resolvedTx: RESOLVE_TX,
      resolvedAt: 1_000n,
    });
  });

  it.each(RESOLUTIONS)(
    "applies a withdrawal from a %s escrow, up to its balance, with its fees",
    (_, status) => {
      const state: EscrowState = { ...released, status, withdrawn: 2n };
      expect(applyEvent(state, withdrawal(3n, 2n))).toEqual({
        kind: "withdraw",
        withdrawal: {
          id: 1n,
          debited: 3n,
          received: 2n,
          txHash: WITHDRAW_TX,
          logIndex: 0,
          blockNumber: 10n,
          withdrawnAt: 1_000n,
        },
      });
    },
  );

  describe("the same event twice is a no-op", () => {
    it("EscrowCreated, while the escrow is Pending or once resolved", () => {
      for (const state of [pending, released]) {
        expect(applyEvent(state, created)).toEqual({
          kind: "skip",
          level: "debug",
          reason: "escrow already created by this event",
        });
      }
    });

    it.each(RESOLUTIONS)("%s", (name, status) => {
      const state: EscrowState = { ...released, status };
      expect(applyEvent(state, resolution(name, RESOLVE_TX))).toEqual({
        kind: "skip",
        level: "debug",
        reason: "escrow already resolved by this event",
      });
    });
  });

  // The contract makes these impossible: they mean the projection is out of sync with the chain.
  describe("an event that conflicts with the projection is reported and not applied", () => {
    it("EscrowWithdrawn on an unknown escrow", () => {
      expect(applyEvent(undefined, withdrawal(1n))).toEqual({
        kind: "skip",
        level: "error",
        reason: "withdrawal from an unknown escrow",
      });
    });

    it("EscrowWithdrawn on a Pending escrow", () => {
      expect(applyEvent(pending, withdrawal(1n))).toEqual({
        kind: "skip",
        level: "error",
        reason: "withdrawal from a Pending escrow",
      });
    });

    it("EscrowWithdrawn above the balance", () => {
      expect(applyEvent({ ...released, withdrawn: 2n }, withdrawal(4n))).toEqual({
        kind: "skip",
        level: "error",
        reason: "withdrawal of 4 exceeds the balance of 3",
      });
    });

    it.each(RESOLUTIONS)("%s on an escrow resolved by another transaction", (name) => {
      expect(applyEvent(released, resolution(name, OTHER_TX))).toEqual({
        kind: "skip",
        level: "error",
        reason: `escrow already resolved as Released by transaction ${RESOLVE_TX}`,
      });
    });

    it.each(RESOLUTIONS)("%s on an unknown escrow", (name) => {
      expect(applyEvent(undefined, resolution(name, RESOLVE_TX))).toEqual({
        kind: "skip",
        level: "error",
        reason: "resolution of an unknown escrow",
      });
    });

    it("EscrowCreated for an id created by another transaction", () => {
      expect(applyEvent({ ...pending, createdTx: OTHER_TX }, created)).toEqual({
        kind: "skip",
        level: "error",
        reason: `escrow already created by transaction ${OTHER_TX}`,
      });
    });
  });
});
