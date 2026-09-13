export const SCHEMA_V1 = `
CREATE TABLE usage (
  message_id     TEXT    NOT NULL,
  request_id     TEXT    NOT NULL DEFAULT '',
  kind           TEXT    NOT NULL CHECK (kind IN ('primary', 'advisor', 'fallback_attempt')),
  seq            INTEGER NOT NULL DEFAULT 0,
  session_id     TEXT    NOT NULL,
  agent_id       TEXT,
  is_sidechain   INTEGER NOT NULL CHECK (is_sidechain IN (0, 1)),
  model          TEXT    NOT NULL,
  speed          TEXT    NOT NULL DEFAULT 'standard' CHECK (speed IN ('standard', 'fast')),
  ts             INTEGER NOT NULL,
  local_day      TEXT    NOT NULL,
  input          INTEGER NOT NULL DEFAULT 0,
  output         INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, request_id, kind, seq)
);
CREATE INDEX usage_day_model ON usage (local_day, model);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  project_path   TEXT,
  project_id     TEXT,
  project_source TEXT CHECK (project_source IN ('main', 'sidechain')),
  project_ts     INTEGER,
  title          TEXT,
  first_ts       INTEGER,
  last_ts        INTEGER
);
CREATE INDEX sessions_project ON sessions (project_id);

CREATE TABLE file_state (
  path        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime_ms    REAL    NOT NULL,
  read_offset INTEGER NOT NULL
);

CREATE TABLE prices (
  price_key       TEXT PRIMARY KEY,
  input           REAL NOT NULL,
  output          REAL NOT NULL,
  cache_write_5m  REAL NOT NULL,
  cache_write_1h  REAL NOT NULL,
  cache_read      REAL NOT NULL,
  fast_multiplier REAL NOT NULL DEFAULT 1,
  source          TEXT NOT NULL CHECK (source IN ('litellm', 'snapshot')),
  fetched_at      INTEGER NOT NULL
);

CREATE TABLE model_price_map (
  model       TEXT PRIMARY KEY,
  price_key   TEXT,
  resolved_at INTEGER NOT NULL
);

CREATE VIEW usage_costed AS
SELECT
  b.*,
  b.input * b.p_input * b.mult AS cost_input,
  b.output * b.p_output * b.mult AS cost_output,
  b.cache_read * b.p_cache_read * b.mult AS cost_cache_read,
  (b.cache_write_5m * b.p_cache_write_5m + b.cache_write_1h * b.p_cache_write_1h) * b.mult AS cost_cache_write,
  (b.input * b.p_input + b.output * b.p_output + b.cache_read * b.p_cache_read
    + b.cache_write_5m * b.p_cache_write_5m + b.cache_write_1h * b.p_cache_write_1h) * b.mult AS cost
FROM (
  SELECT
    u.*,
    s.project_id AS project_id,
    s.project_path AS project_path,
    s.title AS session_title,
    CASE WHEN p.price_key IS NULL THEN 0 ELSE 1 END AS priced,
    COALESCE(p.input, 0) AS p_input,
    COALESCE(p.output, 0) AS p_output,
    COALESCE(p.cache_read, 0) AS p_cache_read,
    COALESCE(p.cache_write_5m, 0) AS p_cache_write_5m,
    COALESCE(p.cache_write_1h, 0) AS p_cache_write_1h,
    CASE WHEN u.speed = 'fast' THEN COALESCE(p.fast_multiplier, 1) ELSE 1 END AS mult
  FROM usage u
  LEFT JOIN sessions s ON s.session_id = u.session_id
  LEFT JOIN model_price_map m ON m.model = u.model
  LEFT JOIN prices p ON p.price_key = m.price_key
) b;
`;

/** Anthropic's server-side web search fee, USD per request; SCHEMA_V2 writes it into the costing view. */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

/**
 * Schema v2, one migration for every storage change of this release:
 * - usage is keyed by (message_id, kind, seq) and keeps request_id as data. Rows that collide under the new key
 *   collapse by the repository's upsert rule: main over sidechain, then more tokens; a tie keeps the earlier row.
 * - usage gains web_search_requests and web_fetch_requests.
 * - sessions lose first_ts and last_ts; the sessions query derives both from usage.
 * - file_state gains the head fingerprint, NULL until the file is read again.
 * - usage_costed adds cost_web_search, and cost includes it whether or not the model has a token price.
 * The view goes first and comes back last: SQLite refuses to rename a table while a view names the table it replaces.
 * A released migration is frozen. Changing WEB_SEARCH_USD_PER_REQUEST later does not reprice an existing database;
 * that needs a new migration that recreates the view.
 */
export const SCHEMA_V2 = `
DROP VIEW usage_costed;

CREATE TABLE usage_v2 (
  message_id          TEXT    NOT NULL,
  request_id          TEXT    NOT NULL DEFAULT '',
  kind                TEXT    NOT NULL CHECK (kind IN ('primary', 'advisor', 'fallback_attempt')),
  seq                 INTEGER NOT NULL DEFAULT 0,
  session_id          TEXT    NOT NULL,
  agent_id            TEXT,
  is_sidechain        INTEGER NOT NULL CHECK (is_sidechain IN (0, 1)),
  model               TEXT    NOT NULL,
  speed               TEXT    NOT NULL DEFAULT 'standard' CHECK (speed IN ('standard', 'fast')),
  ts                  INTEGER NOT NULL,
  local_day           TEXT    NOT NULL,
  input               INTEGER NOT NULL DEFAULT 0,
  output              INTEGER NOT NULL DEFAULT 0,
  cache_read          INTEGER NOT NULL DEFAULT 0,
  cache_write_5m      INTEGER NOT NULL DEFAULT 0,
  cache_write_1h      INTEGER NOT NULL DEFAULT 0,
  web_search_requests INTEGER NOT NULL DEFAULT 0,
  web_fetch_requests  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, kind, seq)
);

-- WHERE true is required: right after INSERT ... SELECT, SQLite would read ON as the start of a join constraint.
-- ORDER BY rowid replays the rows in their original insert order, so a tie keeps the earlier row.
INSERT INTO usage_v2 (message_id, request_id, kind, seq, session_id, agent_id, is_sidechain, model, speed,
                      ts, local_day, input, output, cache_read, cache_write_5m, cache_write_1h)
SELECT message_id, request_id, kind, seq, session_id, agent_id, is_sidechain, model, speed,
       ts, local_day, input, output, cache_read, cache_write_5m, cache_write_1h
FROM usage WHERE true ORDER BY rowid
ON CONFLICT (message_id, kind, seq) DO UPDATE SET
  request_id = excluded.request_id, session_id = excluded.session_id, agent_id = excluded.agent_id,
  is_sidechain = excluded.is_sidechain, model = excluded.model, speed = excluded.speed, ts = excluded.ts,
  local_day = excluded.local_day, input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
  cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h
WHERE usage_v2.is_sidechain > excluded.is_sidechain
   OR (usage_v2.is_sidechain = excluded.is_sidechain
       AND excluded.input + excluded.output + excluded.cache_read + excluded.cache_write_5m + excluded.cache_write_1h
         > usage_v2.input + usage_v2.output + usage_v2.cache_read + usage_v2.cache_write_5m + usage_v2.cache_write_1h);

DROP TABLE usage;
ALTER TABLE usage_v2 RENAME TO usage;
CREATE INDEX usage_day_model ON usage (local_day, model);

ALTER TABLE sessions DROP COLUMN first_ts;
ALTER TABLE sessions DROP COLUMN last_ts;

ALTER TABLE file_state ADD COLUMN fingerprint TEXT;

CREATE VIEW usage_costed AS
SELECT
  b.*,
  b.input * b.p_input * b.mult AS cost_input,
  b.output * b.p_output * b.mult AS cost_output,
  b.cache_read * b.p_cache_read * b.mult AS cost_cache_read,
  (b.cache_write_5m * b.p_cache_write_5m + b.cache_write_1h * b.p_cache_write_1h) * b.mult AS cost_cache_write,
  b.web_search_requests * ${WEB_SEARCH_USD_PER_REQUEST} AS cost_web_search,
  (b.input * b.p_input + b.output * b.p_output + b.cache_read * b.p_cache_read
    + b.cache_write_5m * b.p_cache_write_5m + b.cache_write_1h * b.p_cache_write_1h) * b.mult
    + b.web_search_requests * ${WEB_SEARCH_USD_PER_REQUEST} AS cost
FROM (
  SELECT
    u.*,
    s.project_id AS project_id,
    s.project_path AS project_path,
    s.title AS session_title,
    CASE WHEN p.price_key IS NULL THEN 0 ELSE 1 END AS priced,
    COALESCE(p.input, 0) AS p_input,
    COALESCE(p.output, 0) AS p_output,
    COALESCE(p.cache_read, 0) AS p_cache_read,
    COALESCE(p.cache_write_5m, 0) AS p_cache_write_5m,
    COALESCE(p.cache_write_1h, 0) AS p_cache_write_1h,
    CASE WHEN u.speed = 'fast' THEN COALESCE(p.fast_multiplier, 1) ELSE 1 END AS mult
  FROM usage u
  LEFT JOIN sessions s ON s.session_id = u.session_id
  LEFT JOIN model_price_map m ON m.model = u.model
  LEFT JOIN prices p ON p.price_key = m.price_key
) b;
`;
