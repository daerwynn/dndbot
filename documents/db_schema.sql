-- =====================================================================
-- DB_SCHEMA.sql
-- Canonical schema for the D&D GM Bot project.
-- This file contains DDL for BOTH databases used by the bot:
--   1) rules.db  (read-only at runtime) — adventures/embeddings
--   2) party.db  (read-write)           — parties, sessions, logs, stash, etc.
-- Run the relevant section against the correct SQLite file.
-- =====================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;


-- =====================================================================
-- 1) rules.db  — Adventure graph + embeddings (read-only in production)
--    Mirrors the tables created by ingest-adventure.js and ingest.js
-- =====================================================================

-- List of known adventures (metadata)
CREATE TABLE IF NOT EXISTS adventures (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,       -- e.g. "ditlcot"
  title         TEXT NOT NULL,
  src_path      TEXT,                       -- path to the source JSON file
  pages         INTEGER,
  raw_json      TEXT,                       -- original adventure JSON
  verified_title INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER,
  updated_at    INTEGER
);

-- Per-adventure content nodes
CREATE TABLE IF NOT EXISTS adv_nodes (
  adventure_id  INTEGER NOT NULL,
  node_key      TEXT    NOT NULL,
  role          TEXT    NOT NULL,           -- section|encounter|lore|handout|…
  title         TEXT,
  body          TEXT,                        -- normalized/clean content
  raw_json      TEXT,                        -- raw node JSON
  search_text   TEXT,
  PRIMARY KEY (adventure_id, node_key)
);
CREATE INDEX IF NOT EXISTS idx_adv_nodes_adv_role
  ON adv_nodes(adventure_id, role);

-- Directed graph edges (within an adventure)
CREATE TABLE IF NOT EXISTS adv_edges (
  adventure_id  INTEGER NOT NULL,
  from_key      TEXT    NOT NULL,
  to_key        TEXT    NOT NULL,
  kind          TEXT,                      -- next|choice|link|secret|…
  cond_json     TEXT,                      -- optional condition blob
  UNIQUE (adventure_id, from_key, to_key, kind)
);
CREATE INDEX IF NOT EXISTS idx_adv_edges_from
  ON adv_edges(adventure_id, from_key);
CREATE INDEX IF NOT EXISTS idx_adv_edges_to
  ON adv_edges(adventure_id, to_key);

-- Extracted encounters from nodes
CREATE TABLE IF NOT EXISTS adv_encounters (
  id            INTEGER PRIMARY KEY,
  adventure_id  INTEGER NOT NULL,
  node_key      TEXT    NOT NULL,
  name          TEXT,
  kind          TEXT,                      -- combat|trap|social|…
  cr            REAL,
  xp            INTEGER,
  env           TEXT,                      -- environment/biome tags
  encounter_json TEXT,                     -- raw encounter blob
  foes_json     TEXT,                      -- structured foes
  assets_json   TEXT                       -- references to assets
);
CREATE INDEX IF NOT EXISTS idx_adv_encounters_adv_node
  ON adv_encounters(adventure_id, node_key);

-- Assets (maps, images, audio, etc.)
CREATE TABLE IF NOT EXISTS adv_assets (
  id            INTEGER PRIMARY KEY,
  adventure_id  INTEGER NOT NULL,
  node_key      TEXT,
  type          TEXT,
  name          TEXT,
  url           TEXT,
  meta_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_adv_assets_adv_node
  ON adv_assets(adventure_id, node_key);

-- Simple cron-ish bookkeeping used by ingesters
CREATE TABLE IF NOT EXISTS adv_triggers (
  code          TEXT PRIMARY KEY,           -- e.g. "embed:adv_nodes"
  run_at        TEXT,                       -- ISO timestamp
  last_run_ms   INTEGER
);

-- Chunked text + vector embeddings from ingest.js
CREATE TABLE IF NOT EXISTS docs (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL,              -- adventure code / book path
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding     TEXT NOT NULL               -- serialized vector
);


-- =====================================================================
-- 2) party.db  — Party/session state, GM logs, notes, reputation, stash
-- =====================================================================

-- Parties are scoped to a Discord guild+channel and have a human name
CREATE TABLE IF NOT EXISTS parties (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  adventure_code  TEXT,                      -- optional default adventure
  current_node_key TEXT,                     -- optional current adv node
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (guild_id, channel_id, name)
);
CREATE INDEX IF NOT EXISTS idx_parties_active
  ON parties(guild_id, channel_id, is_active);

-- Individual characters/NPCs belonging to a party
CREATE TABLE IF NOT EXISTS party_members (
  guild_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  party_id          INTEGER NOT NULL,
  character_name    TEXT NOT NULL,
  player_user       TEXT,                     -- Discord user id
  is_npc            INTEGER NOT NULL DEFAULT 0,
  -- Basics
  ancestry          TEXT,
  background        TEXT,
  class             TEXT,
  level             INTEGER,
  prof_bonus        INTEGER,
  -- Combat stats
  ac                INTEGER,
  hp_current        INTEGER,
  hp_max            INTEGER,
  init_mod          INTEGER,
  speed             INTEGER,
  -- Perception & misc
  pp                INTEGER,                  -- passive perception
  resistances       TEXT,
  senses            TEXT,
  -- Links
  sheet_url         TEXT,
  -- JSON blobs
  abilities_json    TEXT,                      -- {STR:{score,mod},...}
  saves_json        TEXT,
  skills_json       TEXT,
  attacks_json      TEXT,
  data_json         TEXT,                      -- full vsheet payload
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id, party_id, character_name)
);
CREATE INDEX IF NOT EXISTS idx_party_members_party
  ON party_members(guild_id, channel_id, party_id);

-- Play sessions (one active at a time per party; enforced in code)
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  party_id      INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,                      -- NULL = active
  started_by    TEXT,                          -- Discord user id
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_party
  ON sessions(guild_id, channel_id, party_id, ended_at);

-- Append-only event stream for GM-visible history/audit
CREATE TABLE IF NOT EXISTS gm_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  party_id        INTEGER,
  session_id      INTEGER,
  category        TEXT NOT NULL,              -- e.g. rep:add, stash:remove
  content         TEXT NOT NULL,
  tags            TEXT,                       -- space-separated #tags
  related_adv_code TEXT,
  related_node_key TEXT,
  visibility      TEXT DEFAULT 'gm',          -- 'gm'|'players'|...
  allow_roles     TEXT,                       -- reserved for RBAC
  allow_users     TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gm_logs_party
  ON gm_logs(guild_id, channel_id, party_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gm_logs_session
  ON gm_logs(guild_id, channel_id, session_id, created_at DESC);

-- Durable GM notes (optionally pinned, optionally session-scoped)
CREATE TABLE IF NOT EXISTS party_notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  party_id        INTEGER NOT NULL,
  session_id      INTEGER,
  scope           TEXT DEFAULT 'party',       -- party|character:<name>|faction:<name>
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  pinned          INTEGER DEFAULT 0,
  visibility      TEXT DEFAULT 'gm',
  allow_roles     TEXT,
  allow_users     TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_by      TEXT,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_party_notes_party
  ON party_notes(guild_id, channel_id, party_id, created_at DESC);

-- Faction/city/etc. reputation per party
CREATE TABLE IF NOT EXISTS party_reputation (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  party_id        INTEGER NOT NULL,
  faction         TEXT NOT NULL,
  score           INTEGER NOT NULL DEFAULT 0,
  trend           TEXT,                        -- improving|declining|stable
  notes           TEXT,
  visibility      TEXT DEFAULT 'players',
  allow_roles     TEXT,
  allow_users     TEXT,
  updated_by      TEXT,
  updated_at      INTEGER NOT NULL,
  UNIQUE (guild_id, channel_id, party_id, faction)
);
CREATE INDEX IF NOT EXISTS idx_party_rep_party
  ON party_reputation(guild_id, channel_id, party_id);

-- Shared loot/currency stash
CREATE TABLE IF NOT EXISTS party_stash (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  party_id        INTEGER NOT NULL,
  item            TEXT NOT NULL,
  qty             REAL NOT NULL DEFAULT 1,
  unit            TEXT DEFAULT '',             -- empty string means no unit
  gp_value        REAL,
  notes           TEXT,
  visibility      TEXT DEFAULT 'players',
  allow_roles     TEXT,
  allow_users     TEXT,
  updated_by      TEXT,
  updated_at      INTEGER NOT NULL
);
-- Normalize NULL units to '' (run once if migrating)
UPDATE party_stash SET unit = '' WHERE unit IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_party_stash
  ON party_stash(guild_id, channel_id, party_id, item, unit);
CREATE INDEX IF NOT EXISTS idx_party_stash_party
  ON party_stash(guild_id, channel_id, party_id);

-- =====================================================================
-- End of schema
-- =====================================================================
