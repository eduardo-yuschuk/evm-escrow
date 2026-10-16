import { getAddress, maxUint256, type Hash } from "viem";
import { describe, expect, it } from "vitest";

import type { FinalStatus } from "../../src/indexer/projector.js";
import { toView, type Escrow } from "../../src/http/view.js";

const CREATE_TX: Hash = `0x${"1".repeat(64)}`;
const RESOLVE_TX: Hash = `0x${"2".repeat(64)}`;
const WITHDRAW_TX: Hash = `0x${"3".repeat(64)}`;

// Created at 1000 with a 2 hour cancel window and a 7 day TTL.
const escrow: Escrow = {
  id: 1n,
  sender: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  beneficiary: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  amount: 10n ** 18n,
  withdrawn: 0n,
  createdAt: 1_000n,
  cancelDeadline: 8_200n,
  expiresAt: 605_800n,
  status: "Pending",
  createdTx: CREATE_TX,
  resolvedTx: null,
  resolvedAt: null,
  withdrawals: [],
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
      holder: null,
      withdrawable: "0",
      canCancel: cancel,
      canConfirm: confirm,
      canReject: confirm,
      canRecover: recover,
      canWithdraw: false,
    });
  });

  it.each<FinalStatus>(["Released", "Rejected", "CancelledBySender", "Expired"])(
    "a %s escrow keeps its status, before and after expiresAt, and only admits withdrawing",
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
          canWithdraw: true,
        });
      }
    },
  );

  // Only Released pays the beneficiary; the other three return the funds to the sender.
  it.each<[FinalStatus, "sender" | "beneficiary"]>([
    ["Released", "beneficiary"],
    ["Rejected", "sender"],
    ["CancelledBySender", "sender"],
    ["Expired", "sender"],
  ])("the holder of a %s escrow is the %s", (status, party) => {
    const resolved: Escrow = { ...escrow, status, resolvedTx: RESOLVE_TX, resolvedAt: 2_000n };
    expect(toView(resolved, 3_000n).holder).toBe(getAddress(escrow[party]));
  });

  it("can withdraw what withdrawals left, fees included, until nothing is left", () => {
    const resolved: Escrow = {
      ...escrow,
      amount: 100n,
      status: "Rejected",
      resolvedTx: RESOLVE_TX,
      resolvedAt: 2_000n,
    };
    expect(toView({ ...resolved, withdrawn: 60n }, 3_000n)).toMatchObject({
      withdrawn: "60",
      withdrawable: "40",
      canWithdraw: true,
    });
    expect(toView({ ...resolved, withdrawn: 100n }, 3_000n)).toMatchObject({
      withdrawn: "100",
      withdrawable: "0",
      canWithdraw: false,
    });
  });

  it("serializes for JSON: uint256 as strings, checksummed addresses, unix seconds as numbers", () => {
    const resolved: Escrow = {
      ...escrow,
      id: maxUint256,
      amount: maxUint256,
      withdrawn: maxUint256 - 1n,
      status: "Released",
      resolvedTx: RESOLVE_TX,
      resolvedAt: 2_000n,
      withdrawals: [
        { txHash: WITHDRAW_TX, withdrawnAt: 2_500n, debited: maxUint256 - 1n, received: 7n },
      ],
    };
    expect(toView(resolved, 3_000n)).toEqual({
      id: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      sender: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      beneficiary: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      withdrawn: "115792089237316195423570985008687907853269984665640564039457584007913129639934",
      withdrawable: "1",
      createdAt: 1_000,
      cancelDeadline: 8_200,
      expiresAt: 605_800,
      onchainStatus: "Released",
      status: "Released",
      holder: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      canCancel: false,
      canConfirm: false,
      canReject: false,
      canRecover: false,
      canWithdraw: true,
      createdTx: CREATE_TX,
      resolvedTx: RESOLVE_TX,
      resolvedAt: 2_000,
      withdrawals: [
        {
          txHash: WITHDRAW_TX,
          withdrawnAt: 2_500,
          debited: "115792089237316195423570985008687907853269984665640564039457584007913129639934",
          received: "7",
        },
      ],
      now: 3_000,
    });
  });
});
