import { maxUint256, type Hash } from "viem";
import { describe, expect, it } from "vitest";

import type { FinalStatus } from "../../src/indexer/projector.js";
import { toView, type Escrow } from "../../src/http/view.js";

const CREATE_TX: Hash = `0x${"1".repeat(64)}`;
const RESOLVE_TX: Hash = `0x${"2".repeat(64)}`;

// Created at 1000 with a 2 hour cancel window and a 7 day TTL.
const escrow: Escrow = {
  id: 1n,
  sender: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  beneficiary: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  amount: 10n ** 18n,
  createdAt: 1_000n,
  cancelDeadline: 8_200n,
  expiresAt: 605_800n,
  status: "Pending",
  createdTx: CREATE_TX,
  resolvedTx: null,
  resolvedAt: null,
};

describe("toView", () => {
  // cancelDeadline and expiresAt are the first second at which the contract refuses cancel, and
  // confirm or reject; recoverExpired is accepted from expiresAt on.
  it.each([
    { at: "createdAt", now: 1_000n, cancel: true, confirm: true, recover: false },
    { at: "cancelDeadline - 1", now: 8_199n, cancel: true, confirm: true, recover: false },
    { at: "cancelDeadline", now: 8_200n, cancel: false, confirm: true, recover: false },
    { at: "expiresAt - 1", now: 605_799n, cancel: false, confirm: true, recover: false },
    { at: "expiresAt", now: 605_800n, cancel: false, confirm: false, recover: true },
  ])("a Pending escrow at $at", ({ now, cancel, confirm, recover }) => {
    expect(toView(escrow, now)).toMatchObject({
      onchainStatus: "Pending",
      status: recover ? "ExpiredRecoverable" : "Pending",
      canCancel: cancel,
      canConfirm: confirm,
      canReject: confirm,
      canRecover: recover,
    });
  });

  it.each<FinalStatus>(["Released", "Rejected", "CancelledBySender", "Expired"])(
    "a %s escrow admits no action and keeps its status, before and after expiresAt",
    (status) => {
      const resolved: Escrow = { ...escrow, status, resolvedTx: RESOLVE_TX, resolvedAt: 2_000n };
      for (const now of [2_000n, 605_800n]) {
        expect(toView(resolved, now)).toMatchObject({
          onchainStatus: status,
          status,
          canCancel: false,
          canConfirm: false,
          canReject: false,
          canRecover: false,
        });
      }
    },
  );

  it("serializes for JSON: uint256 as strings, checksummed addresses, unix seconds as numbers", () => {
    const resolved: Escrow = {
      ...escrow,
      id: maxUint256,
      amount: maxUint256,
      status: "Released",
      resolvedTx: RESOLVE_TX,
      resolvedAt: 2_000n,
    };
    expect(toView(resolved, 3_000n)).toEqual({
      id: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      sender: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      beneficiary: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      createdAt: 1_000,
      cancelDeadline: 8_200,
      expiresAt: 605_800,
      onchainStatus: "Released",
      status: "Released",
      canCancel: false,
      canConfirm: false,
      canReject: false,
      canRecover: false,
      createdTx: CREATE_TX,
      resolvedTx: RESOLVE_TX,
      resolvedAt: 2_000,
      now: 3_000,
    });
  });
});
