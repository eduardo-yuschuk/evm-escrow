-- Withdrawals. Resolving an escrow assigns its balance to the holder (the beneficiary if Released, the
-- sender otherwise), who takes it out with one or more withdrawals, each one an EscrowWithdrawn event.

-- What withdrawals took out of the contract for each escrow, fees charged to the contract included.
ALTER TABLE escrows
  ADD COLUMN withdrawn uint256 NOT NULL DEFAULT 0,
  -- Never more than the amount, and nothing while Pending.
  ADD CHECK (withdrawn <= amount),
  ADD CHECK (status <> 'Pending' OR withdrawn = 0);

-- One row per EscrowWithdrawn. Same key as events: a withdrawal is counted once.
CREATE TABLE withdrawals (
  tx_hash bytes32 NOT NULL,
  log_index integer NOT NULL,
  escrow_id uint256 NOT NULL REFERENCES escrows (id),
  debited uint256 NOT NULL,
  received uint256 NOT NULL,
  block_number bigint NOT NULL,
  withdrawn_at bigint NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- The view of an escrow lists its withdrawals in chain order.
CREATE INDEX withdrawals_escrow_idx ON withdrawals (escrow_id, block_number, log_index);
