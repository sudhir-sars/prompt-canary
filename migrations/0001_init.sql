-- prompt-canary schema.
--
-- Design rule: this database is append-only for anything that constitutes
-- history. Versions are never edited, eval events are never updated, and a
-- rollback writes a NEW deployment row pointing back at the one it restored
-- rather than mutating or deleting the bad one. The live routing state that
-- changes constantly lives in the Durable Object, not here.

CREATE TABLE prompts (
  id          TEXT PRIMARY KEY,           -- slug, e.g. "support-agent"
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Immutable. A "change" to a prompt is always a new row with sequence + 1.
CREATE TABLE versions (
  id          TEXT PRIMARY KEY,
  prompt_id   TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  sequence    INTEGER NOT NULL,
  content     TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (prompt_id, sequence)
);
CREATE INDEX versions_by_prompt ON versions (prompt_id, sequence DESC);

-- Immutable log of every routing-config change, including rollbacks.
-- `config` is [{ versionId, traffic }] summing to 100.
CREATE TABLE deployments (
  id              TEXT PRIMARY KEY,
  prompt_id       TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  config          TEXT NOT NULL,
  reason          TEXT NOT NULL,          -- 'manual' | 'rollout_phase' | 'auto_rollback' | 'promote'
  rolled_back_to  TEXT REFERENCES deployments(id),
  rollout_id      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX deployments_by_prompt ON deployments (prompt_id, created_at DESC);

-- One row per progressive-delivery run.
CREATE TABLE rollouts (
  id                   TEXT PRIMARY KEY,
  prompt_id            TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  candidate_version_id TEXT NOT NULL REFERENCES versions(id),
  baseline_version_id  TEXT NOT NULL REFERENCES versions(id),
  status               TEXT NOT NULL,     -- 'running' | 'promoted' | 'rolled_back' | 'aborted'
  phase                INTEGER NOT NULL DEFAULT 0,
  workflow_id          TEXT,
  outcome_reason       TEXT,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER
);
CREATE INDEX rollouts_by_prompt ON rollouts (prompt_id, started_at DESC);

-- Immutable. One row per chat turn served. This is the raw signal the SLO
-- gate aggregates over; the DO keeps only a bounded in-memory window.
CREATE TABLE eval_events (
  id            TEXT PRIMARY KEY,
  prompt_id     TEXT NOT NULL,
  version_id    TEXT NOT NULL,
  rollout_id    TEXT,
  session_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,

  -- hard signals
  ok            INTEGER NOT NULL,         -- 1 = generation succeeded
  error_kind    TEXT,
  latency_ms    INTEGER NOT NULL,
  schema_valid  INTEGER NOT NULL,         -- 1 = obeyed the output contract

  -- judge signals (null when the judge itself failed)
  judge_score   REAL,                     -- composite 0-1
  relevance     INTEGER,                  -- 1-5
  instruction   INTEGER,                  -- 1-5
  judge_note    TEXT
);
CREATE INDEX eval_events_by_version ON eval_events (version_id, created_at DESC);
CREATE INDEX eval_events_by_rollout ON eval_events (rollout_id, created_at DESC);
