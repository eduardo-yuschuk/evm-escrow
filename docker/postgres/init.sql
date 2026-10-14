-- Runs once, when the pgdata volume is created. The stack uses the escrow database (POSTGRES_DB);
-- the API tests use this one, so they never touch the stack's data.
CREATE DATABASE escrow_test;
