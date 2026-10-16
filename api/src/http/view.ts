import { getAddress, type Address, type Hash } from "viem";

import type { EscrowStatus } from "../indexer/projector.js";

/** A withdrawal from an escrow, as projected from its EscrowWithdrawn event. */
export interface Withdrawal {
  txHash: Hash;
  withdrawnAt: bigint;
  debited: bigint;
  received: bigint;
}

/** An escrow as projected from the events. Addresses and hashes are lowercase. */
export interface Escrow {
  id: bigint;
  sender: Address;
  beneficiary: Address;
  token: Address;
  amount: bigint;
  withdrawn: bigint;
  createdAt: bigint;
  cancelDeadline: bigint;
  expiresAt: bigint;
  status: EscrowStatus;
  createdTx: Hash;
  resolvedTx: Hash | null;
  resolvedAt: bigint | null;
  /** In chain order. */
  withdrawals: Withdrawal[];
}

/** The on-chain status, except that a Pending escrow is ExpiredRecoverable from expiresAt on. */
export type EffectiveStatus = EscrowStatus | "ExpiredRecoverable";

export const EFFECTIVE_STATUSES = [
  "Pending",
  "ExpiredRecoverable",
  "Released",
  "Rejected",
  "CancelledBySender",
  "Expired",
] as const satisfies readonly EffectiveStatus[];

export interface WithdrawalView {
  txHash: Hash;
  withdrawnAt: number;
  debited: string;
  received: string;
}

/** An escrow as the API returns it. */
export interface EscrowView {
  /** uint256 values are strings: they do not fit in a JSON number. */
  id: string;
  /** EIP-55 checksummed. */
  sender: Address;
  beneficiary: Address;
  token: Address;
  amount: string;
  /** What withdrawals took out of the contract, fees charged to the contract included. */
  withdrawn: string;
  /** What the holder can still withdraw: nothing while Pending, `amount - withdrawn` once resolved. */
  withdrawable: string;
  /** Unix seconds. */
  createdAt: number;
  cancelDeadline: number;
  expiresAt: number;
  onchainStatus: EscrowStatus;
  status: EffectiveStatus;
  /** Who can withdraw: the beneficiary if Released, the sender if resolved otherwise, nobody while Pending. */
  holder: Address | null;
  canCancel: boolean;
  canConfirm: boolean;
  canReject: boolean;
  canRecover: boolean;
  canWithdraw: boolean;
  createdTx: Hash;
  resolvedTx: Hash | null;
  resolvedAt: number | null;
  withdrawals: WithdrawalView[];
  /** The timestamp of the latest block, which the derived fields were computed with. */
  now: number;
}

/**
 * The escrow with the state derived from `now`, the timestamp of the latest block. Same rules as
 * the contract: `cancelDeadline` and `expiresAt` are the first second at which cancelling, and
 * confirming or rejecting, are no longer accepted, and recovering is accepted from `expiresAt` on.
 * Withdrawing does not depend on time: the holder can withdraw whatever is left once resolved.
 * Pure. The SQL filter by effective status in queries.ts follows the same rule.
 */
export function toView(escrow: Escrow, now: bigint): EscrowView {
  const pending = escrow.status === "Pending";
  const expired = now >= escrow.expiresAt;
  const withdrawable = pending ? 0n : escrow.amount - escrow.withdrawn;
  return {
    id: escrow.id.toString(),
    sender: getAddress(escrow.sender),
    beneficiary: getAddress(escrow.beneficiary),
    token: getAddress(escrow.token),
    amount: escrow.amount.toString(),
    withdrawn: escrow.withdrawn.toString(),
    withdrawable: withdrawable.toString(),
    createdAt: Number(escrow.createdAt),
    cancelDeadline: Number(escrow.cancelDeadline),
    expiresAt: Number(escrow.expiresAt),
    onchainStatus: escrow.status,
    status: pending && expired ? "ExpiredRecoverable" : escrow.status,
    holder: pending
      ? null
      : getAddress(escrow.status === "Released" ? escrow.beneficiary : escrow.sender),
    canCancel: pending && now < escrow.cancelDeadline,
    canConfirm: pending && !expired,
    canReject: pending && !expired,
    canRecover: pending && expired,
    canWithdraw: withdrawable > 0n,
    createdTx: escrow.createdTx,
    resolvedTx: escrow.resolvedTx,
    resolvedAt: escrow.resolvedAt === null ? null : Number(escrow.resolvedAt),
    withdrawals: escrow.withdrawals.map((withdrawal) => ({
      txHash: withdrawal.txHash,
      withdrawnAt: Number(withdrawal.withdrawnAt),
      debited: withdrawal.debited.toString(),
      received: withdrawal.received.toString(),
    })),
    now: Number(now),
  };
}
