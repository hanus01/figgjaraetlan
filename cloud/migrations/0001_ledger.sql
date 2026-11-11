CREATE TABLE ledger_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

INSERT INTO ledger_meta (singleton, revision) VALUES (1, 0);

CREATE TABLE ledger_records (
  kind TEXT NOT NULL CHECK (kind IN ('category', 'month', 'transaction')),
  record_key TEXT NOT NULL,
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  PRIMARY KEY (kind, record_key)
) STRICT;

-- Keep a receipt for each accepted operation so a delayed retry stays harmless.
CREATE TABLE ledger_operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  attempt_token TEXT NOT NULL
) STRICT;

INSERT INTO ledger_records (kind, record_key, record_json) VALUES
  ('category', 'rent', '{"id":"rent","label":"Húsaleiga","kind":"fixed"}'),
  ('category', 'phone', '{"id":"phone","label":"Telefon","kind":"fixed"}'),
  ('category', 'utilities', '{"id":"utilities","label":"El og hiti","kind":"fixed"}'),
  ('category', 'subscriptions', '{"id":"subscriptions","label":"Hald","kind":"fixed"}'),
  ('category', 'groceries', '{"id":"groceries","label":"Matvørur","kind":"variable"}'),
  ('category', 'transport', '{"id":"transport","label":"Ferðsla","kind":"variable"}'),
  ('category', 'dining', '{"id":"dining","label":"Matstovur","kind":"variable"}'),
  ('category', 'household', '{"id":"household","label":"Húsarhald","kind":"variable"}'),
  ('category', 'leisure', '{"id":"leisure","label":"Frítíð","kind":"variable"}'),
  ('category', 'gifts', '{"id":"gifts","label":"Gávur","kind":"variable"}'),
  ('category', 'other', '{"id":"other","label":"Annað","kind":"variable"}');
