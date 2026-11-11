-- Track the latest accepted operation on a row so Undo cannot revive a
-- transaction deleted again by another device or a later restore.
ALTER TABLE ledger_records ADD COLUMN last_operation TEXT;
