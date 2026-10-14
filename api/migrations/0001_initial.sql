-- Projection of the Escrow contract events.
-- Addresses and hashes are stored as lowercase 0x-prefixed hex, uint256 values as numeric and
-- timestamps as unix seconds. The domains enforce those formats.

CREATE DOMAIN address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN bytes32 AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
CREATE DOMAIN uint256 AS numeric(78, 0) CHECK (
  VALUE >= 0
  AND VALUE < 115792089237316195423570985008687907853269984665640564039457584007913129639936
);

-- Single row: the chain and contract being indexed, and the last block fully processed.
-- The guard compares chain_id, contract_address and start_block_hash with the deployment on startup.
CREATE TABLE indexer_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  chain_id bigint NOT NULL,
  contract_address address NOT NULL,
  start_block bigint NOT NULL,
  start_block_hash bytes32 NOT NULL,
  last_indexed_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Raw contract events, one row per log. The key makes reprocessing a block range a no-op.
CREATE TABLE events (
  tx_hash bytes32 NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash bytes32 NOT NULL,
  block_timestamp bigint NOT NULL,
  name text NOT NULL,
  args jsonb NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- Current state of each escrow, as of last_indexed_block.
CREATE TABLE escrows (
  id uint256 PRIMARY KEY,
  sender address NOT NULL,
  beneficiary address NOT NULL,
  token address NOT NULL,
  amount uint256 NOT NULL,
  created_at bigint NOT NULL,
  cancel_deadline bigint NOT NULL,
  expires_at bigint NOT NULL,
  status text NOT NULL CHECK (
    status IN ('Pending', 'Released', 'Rejected', 'CancelledBySender', 'Expired')
  ),
  created_tx bytes32 NOT NULL,
  resolved_tx bytes32,
  resolved_at bigint,
  -- The resolution is recorded exactly when the escrow leaves Pending.
  CHECK (
    CASE
      WHEN status = 'Pending' THEN resolved_tx IS NULL AND resolved_at IS NULL
      ELSE resolved_tx IS NOT NULL AND resolved_at IS NOT NULL
    END
  )
);

-- Listings filter by party or status and sort by id.
CREATE INDEX escrows_sender_idx ON escrows (sender, id);
CREATE INDEX escrows_beneficiary_idx ON escrows (beneficiary, id);
CREATE INDEX escrows_status_idx ON escrows (status, id);
-- The effective status splits Pending into Pending and ExpiredRecoverable by expires_at.
CREATE INDEX escrows_pending_expires_at_idx ON escrows (expires_at) WHERE status = 'Pending';
