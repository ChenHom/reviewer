CREATE TABLE IF NOT EXISTS authority_current (
  repository TEXT PRIMARY KEY NOT NULL,
  head_key TEXT NOT NULL,
  head_json TEXT NOT NULL,
  context_json TEXT,
  candidate_digest TEXT,
  candidate_json TEXT,
  updated_at TEXT NOT NULL
);
