require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Partials,
  MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ComponentType
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const EPH = MessageFlags.Ephemeral;
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
// Ask-the-table command for roster dump (Avrae ignores bots, so we ask a human to run it)
const INIT_LIST_CMD = process.env.AVRAE_INIT_LIST_CMD || '!init list';
// near your top: const { REST, Routes, SlashCommandBuilder } = require('discord.js');
//const { registerGuildSlashCommandsSafe } = require('./slash-register-safe'); // adjust path


// Avoid spamming the request every message
const rosterPromptAt = new Map(); // chId -> ts
const ROSTER_PROMPT_COOLDOWN_MS = 30_000;

// --- Embed safety helpers (avoid empty strings & overlong text) ---
const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
};

console.time('boot');
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e));
process.on('uncaughtException',  (e) => console.error('[UNCAUGHT]', e));

function nowMs() { return Date.now(); }
const fmtTime = (msOrSec) => {
  const unix = String(msOrSec).length > 10 ? Math.floor(msOrSec / 1000) : msOrSec;
  return `<t:${unix}:f>`;
};

// Debug markers
function mark(msg) { console.log(`[boot] ${msg}`); }


const _clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const _clamp = (s, max) => (s && s.length > max ? s.slice(0, max - 1) + '…' : s || '');

function setTitleSafe(embed, text) {
  const t = _clamp(_clean(text) || 'Untitled', EMBED_LIMITS.title);
  embed.setTitle(t);
}
function setDescSafe(embed, text, fallback = '—') {
  const d = _clamp(_clean(text) || fallback, EMBED_LIMITS.description);
  embed.setDescription(d);
}
function addFieldSafe(embed, name, value, inline = false) {
  const n = _clamp(_clean(name) || '—', EMBED_LIMITS.fieldName);
  const v = _clamp(_clean(value) || '—', EMBED_LIMITS.fieldValue);
  embed.addFields({ name: n, value: v, inline });
}

// --- Safe guild command registration wrapper -------------------------------
const crypto = require('crypto');
const { setTimeout: sleep } = require('node:timers/promises');

function stableStringify(value) {
  // deterministic stringify (sorts object keys recursively)
  const seen = new WeakSet();
  const sort = (v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null; // guard against cycles (shouldn't happen)
      seen.add(v);
      if (Array.isArray(v)) return v.map(sort);
      return Object.keys(v).sort().reduce((o, k) => { o[k] = sort(v[k]); return o; }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function restWithTimeout(restFn, timeoutMs) {
  // restFn must be a function returning a promise (e.g. () => rest.put(...))
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs).unref();
  try {
    return await restFn(ac.signal);
  } finally {
    clearTimeout(to);
  }
}

/**
 * Safely upserts guild slash commands if and only if they changed.
 *
 * @param {object} opts
 * @param {import('@discordjs/rest').REST} opts.rest
 * @param {string} opts.applicationId
 * @param {string} opts.guildId
 * @param {Array<object>} opts.commands - raw JSON (e.g. builders.map(c=>c.toJSON()))
 * @param {number} [opts.timeoutMs=120000]
 * @param {string} [opts.cacheDir='.cache']
 * @param {string} [opts.mode=process.env.SLASH_REGISTER || 'auto'] // 'auto'|'skip'|'force'
 * @param {(msg:string)=>void} [opts.log=console.log]
 */
async function registerGuildSlashCommandsSafe({
  rest,
  applicationId,
  guildId,
  commands,
  timeoutMs = 120000,
  cacheDir = '.cache',
  mode = process.env.SLASH_REGISTER || 'auto',
  log = console.log,
}) {
  if (!applicationId || !guildId) throw new Error('applicationId and guildId are required');
  if (!Array.isArray(commands)) throw new Error('commands must be an array of JSON command objects');

  // Make a content hash that is stable across key order
  const payload = stableStringify(commands);
  const hash = sha256(payload);
  const cachePath = path.join(process.cwd(), cacheDir);
  const file = path.join(cachePath, `slash-${applicationId}-${guildId}.json`);

  if (!fs.existsSync(cachePath)) fs.mkdirSync(cachePath, { recursive: true });

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  if (mode === 'skip') {
    log('[slash] skip requested (SLASH_REGISTER=skip)');
    return { skipped: true, reason: 'mode=skip' };
  }
  if (mode !== 'force' && prev && prev.hash === hash) {
    log('[slash] unchanged — skipping registration');
    return { skipped: true, reason: 'unchanged' };
  }

  // One bulk overwrite (no pre-delete). Longer timeout. Single retry on timeout/429.
  const doPut = async (signal) => {
    return await rest.put(
      Routes.applicationGuildCommands(applicationId, guildId),
      { body: commands, signal }
    );
  };

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await restWithTimeout(doPut, timeoutMs);
      const saved = { hash, count: Array.isArray(commands) ? commands.length : 0, updatedAt: Date.now() };
      fs.writeFileSync(file, JSON.stringify(saved, null, 2));
      log(`[slash] guild overwrite OK (${saved.count} cmd)`);
      return { ok: true, count: saved.count, attempt };
    } catch (err) {
      const isAbort = String(err?.name || '').includes('AbortError');
      const msg = err?.message || String(err);
      const code = err?.status ?? err?.code ?? 'ERR';

      log(`[slash] overwrite failed (attempt ${attempt}): ${code} ${msg}`);

      // Backoff & single retry on timeout/429-ish failures
      if (attempt < 2 && (isAbort || code === 429)) {
        await sleep(5000 + Math.random() * 2000);
        continue;
      }
      // Give up without deleting existing commands
      return { ok: false, error: err, attempt };
    }
  }
}

module.exports = { registerGuildSlashCommandsSafe };

/* =========================
   NEW PARTY SYSTEM (party_id–scoped)
========================= */

// ---- Pending !vsheet requests (by channel + character) ----
// key: `${channelId}::${charName.toLowerCase()}`
const pendingVsheet = new Map();
mark('opening Party DB');
// === Party DB (read–write) =================================
const PARTY_DB_PATH = process.env.PARTY_DB || path.join(process.cwd(), 'party.db');
const partyDb = new Database(PARTY_DB_PATH, { timeout: 5000 });
try { partyDb.pragma('journal_mode = WAL'); } catch {}
try { partyDb.pragma('synchronous = NORMAL'); } catch {}

/** Create/upgrade schema and migrate any legacy rows that lack party_id. */
function ensurePartySchema(db) {
  // Base tables (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      adventure_code TEXT,
      current_node_key TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (guild_id, channel_id, name)
    );

    CREATE TABLE IF NOT EXISTS party_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      party_id INTEGER,                 -- NULL in legacy DBs; we will backfill
      character_name TEXT NOT NULL,
      player_user TEXT,
      is_npc INTEGER NOT NULL DEFAULT 0,

      ancestry TEXT,
      background TEXT,
      class TEXT,
      level INTEGER,
      prof_bonus INTEGER,

      ac INTEGER,
      hp_current INTEGER,
      hp_max INTEGER,
      init_mod INTEGER,
      speed INTEGER,

      pp INTEGER,
      resistances TEXT,
      senses TEXT,

      sheet_url TEXT,

      abilities_json TEXT,
      saves_json TEXT,
      skills_json TEXT,
      attacks_json TEXT,
      data_json TEXT,

      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_parties_active
      ON parties(guild_id, channel_id, is_active);

    CREATE INDEX IF NOT EXISTS idx_party_members_party
      ON party_members(guild_id, channel_id, party_id);

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_party_member
      ON party_members(guild_id, channel_id, party_id, character_name);
  `);

  // Add any missing columns on older DBs
  const haveCols = new Set(db.prepare(`PRAGMA table_info('party_members')`).all().map(r => r.name));
  const addCol = (name, ddl) => db.exec(`ALTER TABLE party_members ADD COLUMN ${name} ${ddl};`);

  const neededCols = {
    party_id:           'INTEGER',
    player_user:        'TEXT',
    is_npc:             'INTEGER DEFAULT 0',
    ancestry:           'TEXT',
    background:         'TEXT',
    class:              'TEXT',
    level:              'INTEGER',
    prof_bonus:         'INTEGER',
    ac:                 'INTEGER',
    hp_current:         'INTEGER',
    hp_max:             'INTEGER',
    init_mod:           'INTEGER',
    speed:              'INTEGER',
    pp:                 'INTEGER',
    resistances:        'TEXT',
    senses:             'TEXT',
    sheet_url:          'TEXT',
    abilities_json:     'TEXT',
    saves_json:         'TEXT',
    skills_json:        'TEXT',
    attacks_json:       'TEXT',
    data_json:          'TEXT',
    updated_at:         'INTEGER'
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [col, ddl] of Object.entries(neededCols)) {
      if (!haveCols.has(col)) addCol(col, ddl);
    }
    // Legacy aliases → current columns
    if (!haveCols.has('init_mod') && haveCols.has('initiative')) {
      try { addCol('init_mod', 'INTEGER'); } catch {}
      db.exec(`UPDATE party_members SET init_mod = initiative WHERE init_mod IS NULL`);
    }
    if (!haveCols.has('pp') && haveCols.has('passive_perception')) {
      try { addCol('pp', 'INTEGER'); } catch {}
      db.exec(`UPDATE party_members SET pp = passive_perception WHERE pp IS NULL`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Backfill party_id for legacy rows (one default active party per guild+channel)
  const needPartyId = db.prepare(`
    SELECT DISTINCT guild_id, channel_id
    FROM party_members
    WHERE party_id IS NULL OR party_id = ''
  `).all();

  if (needPartyId.length) {
    const selActive = db.prepare(`
      SELECT id FROM parties
      WHERE guild_id=? AND channel_id=? AND is_active=1
      ORDER BY id DESC LIMIT 1
    `);
    const deactivateAll = db.prepare(`UPDATE parties SET is_active=0 WHERE guild_id=? AND channel_id=?`);
    const insertParty = db.prepare(`
      INSERT INTO parties (guild_id, channel_id, name, is_active)
      VALUES (?, ?, ?, 1)
    `);
    const setPartyId = db.prepare(`
      UPDATE party_members SET party_id=?
      WHERE guild_id=? AND channel_id=? AND (party_id IS NULL OR party_id='')
    `);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of needPartyId) {
        let p = selActive.get(row.guild_id, row.channel_id);
        if (!p) {
          deactivateAll.run(row.guild_id, row.channel_id);
          insertParty.run(row.guild_id, row.channel_id, 'Party');
          p = selActive.get(row.guild_id, row.channel_id);
        }
        if (p?.id) setPartyId.run(p.id, row.guild_id, row.channel_id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
mark('ensuring Party schemas');
ensurePartySchema(partyDb);

// --- Session schema (with future-proofed permission fields) ---
function ensureSessionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS party_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,

      /* Session basics */
      title TEXT,
      adv_code TEXT,
      node_key TEXT,
      goals TEXT,
      notes_gm TEXT,
      log_mode TEXT DEFAULT 'auto+review',   -- auto | auto+review | manual
      conf_min REAL DEFAULT 0.7,
      post_channel_id TEXT,
      log_channel_id TEXT,
      xp_mode TEXT,                           -- milestone | xp

      /* Lifecycle */
      started_by TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_by TEXT,
      ended_at TEXT,
      recap_text TEXT,

      /* Participants at start (seed) */
      participants_json TEXT,                 -- JSON array [{character_name, player_user}]

      /* Permissions (future-proof, unused for now) */
      created_by TEXT,                        -- who started
      created_role_ids TEXT,                  -- CSV or JSON of role IDs
      allowed_role_ids TEXT,                  -- who can view
      allowed_user_ids TEXT,                  -- who can view
      write_role_ids TEXT,                    -- who can edit/end
      write_user_ids TEXT,
      visibility TEXT DEFAULT 'public',       -- public|party|private
      locked_by TEXT,
      locked_at TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_party_open
      ON party_sessions(party_id, ended_at);

    CREATE INDEX IF NOT EXISTS idx_sessions_guild_chan
      ON party_sessions(guild_id, channel_id);
  `);

  // Optional: link current session on parties (nice to have; not required)
  const cols = new Set(db.prepare(`PRAGMA table_info('parties')`).all().map(r => r.name));
  if (!cols.has('current_session_id')) {
    try { db.exec(`ALTER TABLE parties ADD COLUMN current_session_id INTEGER`); } catch {}
    db.exec(`CREATE INDEX IF NOT EXISTS idx_parties_current_session ON parties(current_session_id)`);
  }
}
mark('ensuring Session schemas');
// Ensure session schema
ensureSessionSchema(partyDb);

function ensurePartyLogSchema(db) {
  // gm_logs: append-only event stream
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      party_id   INTEGER,
      session_id INTEGER,
      category   TEXT NOT NULL,
      content    TEXT NOT NULL,
      tags       TEXT,
      related_adv_code TEXT,
      related_node_key TEXT,
      visibility TEXT DEFAULT 'gm',
      allow_roles TEXT,
      allow_users TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gm_logs_party   ON gm_logs(guild_id, channel_id, party_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gm_logs_session ON gm_logs(guild_id, channel_id, session_id, created_at DESC);
  `);

  // party_notes: durable GM notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS party_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      party_id   INTEGER NOT NULL,
      session_id INTEGER,
      scope      TEXT DEFAULT 'party',
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      pinned     INTEGER DEFAULT 0,
      visibility TEXT DEFAULT 'gm',
      allow_roles TEXT,
      allow_users TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_by TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_party_notes_party ON party_notes(guild_id, channel_id, party_id, created_at DESC);
  `);

  // party_reputation: faction disposition
  db.exec(`
    CREATE TABLE IF NOT EXISTS party_reputation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      party_id   INTEGER NOT NULL,
      faction    TEXT NOT NULL,
      score      INTEGER NOT NULL DEFAULT 0,
      trend      TEXT,
      notes      TEXT,
      visibility TEXT DEFAULT 'players',
      allow_roles TEXT,
      allow_users TEXT,
      updated_by TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE (guild_id, channel_id, party_id, faction)
    );
    CREATE INDEX IF NOT EXISTS idx_party_rep_party ON party_reputation(guild_id, channel_id, party_id);
  `);

  // party_stash: shared loot / currency
  db.exec(`
    CREATE TABLE IF NOT EXISTS party_stash (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      party_id   INTEGER NOT NULL,
      item       TEXT NOT NULL,
      qty        REAL NOT NULL DEFAULT 1,
      unit       TEXT DEFAULT '',               -- normalize to empty string (not NULL)
      gp_value   REAL,
      notes      TEXT,
      visibility TEXT DEFAULT 'players',
      allow_roles TEXT,
      allow_users TEXT,
      updated_by TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_party_stash_party ON party_stash(guild_id, channel_id, party_id);
  `);

  // ---- Light migrations / backfills ----
  const haveCols2 = (tbl) => new Set(db.prepare(`PRAGMA table_info('${tbl}')`).all().map(r => r.name));
  const addCol2   = (tbl, col, ddl) => { try { db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${ddl}`); } catch {} };

  // Ensure permission columns exist (future-ready)
  for (const tbl of ['gm_logs','party_notes','party_reputation','party_stash']) {
    const cols = haveCols2(tbl);
    if (!cols.has('visibility'))  addCol2(tbl, 'visibility',  "TEXT DEFAULT 'gm'");
    if (!cols.has('allow_roles')) addCol2(tbl, 'allow_roles', "TEXT");
    if (!cols.has('allow_users')) addCol2(tbl, 'allow_users', "TEXT");
  }

  // Normalize party_stash.unit away from NULL to '' so uniqueness works
  db.exec(`UPDATE party_stash SET unit = '' WHERE unit IS NULL`);

  // Enforce uniqueness without expressions (use a UNIQUE INDEX)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_party_stash
      ON party_stash(guild_id, channel_id, party_id, item, unit)
  `);
}
mark('ensuring Party Log schemas');
// Ensure once at startup
ensurePartyLogSchema(partyDb);

// ---------- helpers ----------
function normTags(s) {
  if (!s) return null;
  // turn arbitrary CSV/space list into "#tag #two" style
  const raw = s.replace(/[,\s]+/g,' ').trim().split(' ').filter(Boolean);
  const uniq = [...new Set(raw.map(t => t.replace(/^#/,'').toLowerCase()))];
  return uniq.length ? uniq.map(t => `#${t}`).join(' ') : null;
}
function getActiveSessionIdSafe(guildId, channelId) {
  try {
    const row = partyDb.prepare(`
      SELECT s.id
      FROM parties p
      JOIN party_sessions s ON s.party_id = p.id
      WHERE p.guild_id=? AND p.channel_id=? AND p.is_active=1
        AND s.ended_at IS NULL
      ORDER BY s.id DESC
      LIMIT 1
    `).get(guildId, channelId);
    return row?.id || null;
  } catch {
    return null;
  }
}

// helper: unix seconds
const now = () => Math.floor(Date.now() / 1000);

// ── gm_logs: 14 columns (excluding id)
const insGmLog = partyDb.prepare(`
  INSERT INTO gm_logs (
    guild_id, channel_id, party_id, session_id,
    category, content, tags,
    related_adv_code, related_node_key,
    visibility, allow_roles, allow_users,
    created_by, created_at
  ) VALUES (?,?,?,?, ?,?,?, ?,?, ?,?, ?,?, ?)
`);

const listRecentLogs = partyDb.prepare(`
  SELECT id, category, content, tags, created_by, created_at
  FROM gm_logs
  WHERE guild_id=? AND channel_id=? AND party_id=?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

// Search gm_logs by content/tags (include unscoped + party-scoped)
const searchLogs = partyDb.prepare(`
  SELECT
    'log' AS kind,
    id,
    category,
    content,
    IFNULL(tags, '') AS tags,
    created_at,
    NULL AS title,
    NULL AS body
  FROM gm_logs
  WHERE guild_id = ?
    AND channel_id = ?
    AND (party_id IS NULL OR party_id = ?)
    AND (content LIKE ? OR IFNULL(tags,'') LIKE ?)
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

// Search party_notes by title/body (party-scoped)
const searchNotes = partyDb.prepare(`
  SELECT
    'note' AS kind,
    id,
    NULL AS category,
    body AS content,
    ''   AS tags,
    updated_at AS created_at,
    title,
    body
  FROM party_notes
  WHERE guild_id = ?
    AND channel_id = ?
    AND party_id = ?
    AND (title LIKE ? OR body LIKE ?)
  ORDER BY pinned DESC, updated_at DESC
  LIMIT ? OFFSET ?
`);


// --- gmlog: NOTES helpers ---
const selActiveSessionId = partyDb.prepare(`
  SELECT id
  FROM party_sessions
  WHERE guild_id=? AND channel_id=? AND party_id=? AND ended_at IS NULL
  ORDER BY id DESC
  LIMIT 1
`);

const insNote = partyDb.prepare(`
  INSERT INTO party_notes(
    guild_id, channel_id, party_id, session_id,
    scope, title, body, pinned, visibility,
    allow_roles, allow_users,
    created_by, created_at, updated_by, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updNote = partyDb.prepare(`
  UPDATE party_notes
  SET scope=?, title=?, body=?, visibility=?, updated_by=?, updated_at=?
  WHERE id=? AND guild_id=? AND channel_id=? AND party_id=?
`);

const setNotePinned = partyDb.prepare(`
  UPDATE party_notes
  SET pinned=?, updated_by=?, updated_at=?
  WHERE id=? AND guild_id=? AND channel_id=? AND party_id=?
`);

const delNote = partyDb.prepare(`
  DELETE FROM party_notes
  WHERE id=? AND guild_id=? AND channel_id=? AND party_id=?
`);

const getNote = partyDb.prepare(`
  SELECT * FROM party_notes
  WHERE id=? AND guild_id=? AND channel_id=? AND party_id=?
`);

const listNotesStmt = partyDb.prepare(`
  SELECT id, scope, title, visibility, pinned, updated_at
  FROM party_notes
  WHERE guild_id=? AND channel_id=? AND party_id=?
  ORDER BY pinned DESC, updated_at DESC
  LIMIT ? OFFSET ?
`);

const countNotesStmt = partyDb.prepare(`
  SELECT COUNT(*) AS c
  FROM party_notes
  WHERE guild_id=? AND channel_id=? AND party_id=?
`);
//end GMlogNotes Helpers

// ---- Reputation helpers ----
function normFaction(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z])/g, (m, c) => c.toUpperCase()); // Title Case-ish
}

const getRepOneCI = partyDb.prepare(`
  SELECT faction, score, trend, notes
  FROM party_reputation
  WHERE guild_id=? AND channel_id=? AND party_id=? AND faction LIKE ? COLLATE NOCASE
  LIMIT 1
`);

// Use placeholders for visibility/allow_* so run() can pass 12 args cleanly
const upsertReputation = partyDb.prepare(`
  INSERT INTO party_reputation (
    guild_id, channel_id, party_id,
    faction, score, trend, notes,
    visibility, allow_roles, allow_users,
    updated_by, updated_at
  ) VALUES (?,?,?,?,?,?,?, ?,?, ?,?, ?)
  ON CONFLICT(guild_id, channel_id, party_id, faction) DO UPDATE SET
    score       = excluded.score,
    trend       = COALESCE(excluded.trend, party_reputation.trend),
    notes       = COALESCE(excluded.notes, party_reputation.notes),
    visibility  = COALESCE(excluded.visibility, party_reputation.visibility),
    allow_roles = COALESCE(excluded.allow_roles, party_reputation.allow_roles),
    allow_users = COALESCE(excluded.allow_users, party_reputation.allow_users),
    updated_by  = excluded.updated_by,
    updated_at  = excluded.updated_at
`);

// --- Reputation helpers ---
const listReps = partyDb.prepare(`
  SELECT faction, score, trend, notes
  FROM party_reputation
  WHERE guild_id=? AND channel_id=? AND party_id=?
  ORDER BY faction COLLATE NOCASE ASC
`);

// ---------- STASH HELPERS (replace your existing stash helpers) ----------

// Canonicalize item/unit
function normItem(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
function normUnit(s) { return String(s || '').trim().toLowerCase(); }

// ADD (merge) — keep old gp_value unless explicitly provided; keep old notes unless new provided
const upsertStashAdd = partyDb.prepare(`
  INSERT INTO party_stash (
    guild_id, channel_id, party_id, item, unit, qty, gp_value, notes,
    visibility, allow_roles, allow_users, updated_by, updated_at
  ) VALUES (?,?,?,?,?,?, ?, ?, 'players', NULL, NULL, ?, ?)
  ON CONFLICT(guild_id, channel_id, party_id, item, unit)
  DO UPDATE SET
    qty        = party_stash.qty + excluded.qty,
    gp_value   = COALESCE(excluded.gp_value, party_stash.gp_value),
    notes      = CASE
                   WHEN excluded.notes IS NOT NULL AND excluded.notes <> ''
                   THEN excluded.notes
                   ELSE party_stash.notes
                 END,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
`);

// REMOVE (clamped) — subtract, never below 0
const stashClampRemove = partyDb.prepare(`
  UPDATE party_stash
  SET qty = CASE WHEN qty - ? < 0 THEN 0 ELSE qty - ? END,
      updated_by = ?,
      updated_at = ?
  WHERE guild_id=? AND channel_id=? AND party_id=? AND item=? AND unit=?
`);

// If qty hits zero, delete the row
const stashDeleteRowIfZero = partyDb.prepare(`
  DELETE FROM party_stash
  WHERE guild_id=? AND channel_id=? AND party_id=? AND item=? AND unit=? AND qty <= 0
`);

// List stash
const listStashByParty = partyDb.prepare(`
  SELECT item, unit, qty, gp_value, notes
  FROM party_stash
  WHERE guild_id=? AND channel_id=? AND party_id=?
  ORDER BY LOWER(item), unit
`);

// Canonical find for existing units for an item (case-insensitive match on item)
const findUnitsForItem = partyDb.prepare(`
  SELECT item, unit
  FROM party_stash
  WHERE guild_id=? AND channel_id=? AND party_id=? AND item COLLATE NOCASE = ?
`);

// Current qty for a specific (item, unit)
const getQtyForRow = partyDb.prepare(`
  SELECT qty FROM party_stash
  WHERE guild_id=? AND channel_id=? AND party_id=? AND item=? AND unit=?
`);

// What units exist for an item (case-insensitive), and the canonical stored item text
const listDistinctUnitsForItem = partyDb.prepare(`
  SELECT unit, item
  FROM party_stash
  WHERE guild_id=? AND channel_id=? AND party_id=? AND LOWER(item)=LOWER(?)
`);
//old listDinstinctUnitsForItem
/*
function listDistinctUnitsForItem(guildId, channelId, partyId, itemRaw) {
  const rows = findUnitsForItem.all(guildId, channelId, partyId, itemRaw);
  const units = Array.from(new Set(rows.map(r => (r.unit || '').toLowerCase())));
  const canonItem = rows[0]?.item || normItem(itemRaw);
  return { units, canonItem };
}*/
//end of Stash helpers

// Active session for the active party
const selActivePartySession = partyDb.prepare(`
  SELECT s.*
  FROM parties p
  JOIN party_sessions s ON s.party_id = p.id
  WHERE p.guild_id=? AND p.channel_id=? AND p.is_active=1 AND s.ended_at IS NULL
  ORDER BY s.id DESC LIMIT 1
`);

const selActiveSessionByParty = partyDb.prepare(`
  SELECT * FROM party_sessions
  WHERE party_id=? AND ended_at IS NULL
  ORDER BY id DESC LIMIT 1
`);

const insertSession = partyDb.prepare(`
  INSERT INTO party_sessions (
    party_id, guild_id, channel_id,
    title, adv_code, node_key, goals, notes_gm, log_mode, conf_min,
    post_channel_id, log_channel_id, xp_mode,
    started_by, participants_json,
    created_by, created_role_ids, allowed_role_ids, allowed_user_ids,
    write_role_ids, write_user_ids, visibility
  )
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const endSessionById = partyDb.prepare(`
  UPDATE party_sessions
  SET ended_by=?, ended_at=datetime('now'), recap_text=?, updated_at=datetime('now')
  WHERE id=?
`);

const setPartyCurrentSession = partyDb.prepare(`
  UPDATE parties SET current_session_id=? WHERE id=?
`);

// Small helper: ensure we have an active party and no open session
function requireActiveParty(guildId, channelId) {
  const party = selActiveParty.get(guildId, channelId);
  return party || null;
}

// --- Parties (create/activate/list/end) ---
const selActiveParty = partyDb.prepare(`
  SELECT * FROM parties
  WHERE guild_id=? AND channel_id=? AND is_active=1
  ORDER BY id DESC LIMIT 1
`);
const selPartyByName = partyDb.prepare(`
  SELECT * FROM parties
  WHERE guild_id=? AND channel_id=? AND name=? LIMIT 1
`);
const deactivateAllParties = partyDb.prepare(`
  UPDATE parties SET is_active=0 WHERE guild_id=? AND channel_id=?
`);
const insertParty = partyDb.prepare(`
  INSERT INTO parties (guild_id, channel_id, name, adventure_code, is_active)
  VALUES (?, ?, ?, ?, 1)
`);
const activatePartyById = partyDb.prepare(`UPDATE parties SET is_active=1 WHERE id=?`);
const endPartyById = partyDb.prepare(`UPDATE parties SET is_active=0 WHERE id=?`);
const listParties = partyDb.prepare(`
  SELECT id, name, is_active, adventure_code, created_at
  FROM parties
  WHERE guild_id=? AND channel_id=?
  ORDER BY is_active DESC, id DESC
`);

// --- Members (party-scoped) ---
const listMembersByParty = partyDb.prepare(`
  SELECT *
  FROM party_members
  WHERE guild_id=? AND channel_id=? AND party_id=?
  ORDER BY is_npc ASC, character_name COLLATE NOCASE
`);
const getMemberByParty = partyDb.prepare(`
  SELECT *
  FROM party_members
  WHERE guild_id=? AND channel_id=? AND party_id=? AND character_name COLLATE NOCASE=?
  LIMIT 1
`);
const removeMemberByParty = partyDb.prepare(`
  DELETE FROM party_members
  WHERE guild_id=? AND channel_id=? AND party_id=? AND character_name COLLATE NOCASE=?
`);

// Set owner only (used by /party add); scoped to party_id
const setPlayerOnly = partyDb.prepare(`
  INSERT INTO party_members (guild_id, channel_id, party_id, character_name, player_user, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, channel_id, party_id, character_name)
  DO UPDATE SET player_user=excluded.player_user, updated_at=excluded.updated_at
`);

// Upsert full vsheet payload; scoped to party_id
const upsertMemberFromVsheet = partyDb.prepare(`
  INSERT INTO party_members (
    guild_id, channel_id, party_id, character_name, player_user,
    class, level, prof_bonus, ac, hp_current, hp_max,
    init_mod, speed, pp, resistances, senses, sheet_url,
    abilities_json, saves_json, skills_json, attacks_json,
    ancestry, background, data_json, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(guild_id, channel_id, party_id, character_name) DO UPDATE SET
    player_user    = excluded.player_user,
    class          = excluded.class,
    level          = excluded.level,
    prof_bonus     = excluded.prof_bonus,
    ac             = excluded.ac,
    hp_current     = excluded.hp_current,
    hp_max         = excluded.hp_max,
    init_mod       = excluded.init_mod,
    speed          = excluded.speed,
    pp             = excluded.pp,
    resistances    = excluded.resistances,
    senses         = excluded.senses,
    sheet_url      = excluded.sheet_url,
    abilities_json = excluded.abilities_json,
    saves_json     = excluded.saves_json,
    skills_json    = excluded.skills_json,
    attacks_json   = excluded.attacks_json,
    ancestry       = excluded.ancestry,
    background     = excluded.background,
    data_json      = excluded.data_json,
    updated_at     = excluded.updated_at
`);

// Active-party aware getters (drop-in replacements for your old ones)
const getMember = partyDb.prepare(`
  SELECT pm.*
  FROM party_members pm
  JOIN parties p
    ON p.id = pm.party_id
   AND p.guild_id = pm.guild_id
   AND p.channel_id = pm.channel_id
   AND p.is_active = 1
  WHERE pm.guild_id = ? AND pm.channel_id = ? AND pm.character_name COLLATE NOCASE = ?
  LIMIT 1
`);

const getMemberFull = partyDb.prepare(`
  SELECT
    pm.character_name,
    pm.player_user,
    pm.class,
    pm.level,
    pm.prof_bonus,
    pm.ac,
    pm.hp_current AS hp_cur,
    pm.hp_max,
    pm.init_mod,
    pm.speed,
    pm.pp,
    pm.resistances,
    pm.senses,
    pm.sheet_url,
    pm.abilities_json,
    pm.saves_json,
    pm.skills_json,
    pm.attacks_json,
    pm.ancestry,
    pm.background,
    pm.updated_at
  FROM party_members pm
  JOIN parties p
    ON p.id = pm.party_id
   AND p.guild_id = pm.guild_id
   AND p.channel_id = pm.channel_id
   AND p.is_active = 1
  WHERE pm.guild_id = ? AND pm.channel_id = ? AND pm.character_name COLLATE NOCASE = ?
  LIMIT 1
`);

// ---- Events queries (gm_logs with category 'event:*') ----
const listEventsAny = partyDb.prepare(`
  SELECT category, content, tags,
         related_adv_code AS adv, related_node_key AS node,
         created_at
  FROM gm_logs
  WHERE guild_id=? AND channel_id=? AND party_id=? AND category LIKE 'event:%'
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const listEventsByType = partyDb.prepare(`
  SELECT category, content, tags,
         related_adv_code AS adv, related_node_key AS node,
         created_at
  FROM gm_logs
  WHERE guild_id=? AND channel_id=? AND party_id=? AND category = ?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const searchEventsAny = partyDb.prepare(`
  SELECT category, content, tags,
         related_adv_code AS adv, related_node_key AS node,
         created_at
  FROM gm_logs
  WHERE guild_id=? AND channel_id=? AND party_id=? AND category LIKE 'event:%'
    AND (content LIKE ? OR tags LIKE ?)
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

// Also search by event type (partial match), e.g. 'event:%com%'
const searchEventsByCategoryLike = partyDb.prepare(`
  SELECT category, content, tags,
         related_adv_code AS adv, related_node_key AS node,
         created_at
  FROM gm_logs
  WHERE guild_id=? AND channel_id=? AND party_id=? 
    AND category LIKE 'event:%'
    AND category LIKE ?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const searchEventsByType = partyDb.prepare(`
  SELECT category, content, tags,
         related_adv_code AS adv, related_node_key AS node,
         created_at
  FROM gm_logs
  WHERE guild_id=? AND channel_id=? AND party_id=? AND category = ?
    AND (content LIKE ? OR tags LIKE ?)
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);


// Ensure there is an active party; create a default one if needed.
function ensureActiveParty(guildId, channelId, fallbackName = 'Party') {
  let active = selActiveParty.get(guildId, channelId);
  if (active) return active;
  partyDb.exec('BEGIN IMMEDIATE');
  try {
    deactivateAllParties.run(guildId, channelId);
    insertParty.run(guildId, channelId, fallbackName, null);
    active = selActiveParty.get(guildId, channelId);
    partyDb.exec('COMMIT');
  } catch (e) {
    partyDb.exec('ROLLBACK');
    throw e;
  }
  return active;
}

// ---- Small format helpers used by /party show ----
function fmtMod(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const v = parseInt(n, 10);
  return v >= 0 ? `+${v}` : `${v}`;
}
function canonFaction(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/["'‘’“”`]/g, '')   // strip quotes
    .replace(/\s+/g, ' ')        // collapse spaces
    .trim();
}
function snippet(s, n = 160) {
  const txt = String(s || '');
  if (txt.length <= n) return txt;
  const cut = txt.slice(0, n - 1);
  return cut.replace(/\s+\S*$/, '') + '…';
}
function abilitiesLine(abilities) {
  if (!abilities || typeof abilities !== 'object') return '—';
  const order = ['STR','DEX','CON','INT','WIS','CHA'];
  return order.map(k => {
    const a = abilities[k] || {};
    const score = (a.score != null) ? a.score : '—';
    const mod   = (a.mod   != null) ? fmtMod(a.mod) : '—';
    return `**${k}**: ${score} (${mod})`;
  }).join('  ');
}
function mapToCommaList(obj) {
  if (!obj || typeof obj !== 'object') return '—';
  const entries = Object.entries(obj);
  if (!entries.length) return '—';
  return entries.map(([k,v]) => `${k} ${fmtMod(v)}`).join(', ');
}
function arrayOrCSV(s) {
  if (!s) return '—';
  if (Array.isArray(s)) return s.join(', ');
  return String(s);
}
function attacksBlock(attacks) {
  const arr = Array.isArray(attacks) ? attacks : [];
  if (!arr.length) return '—';
  return arr.map(a => {
    const toHit = (a.toHit != null) ? fmtMod(a.toHit) : '—';
    const dmg   = a.damage ? a.damage : '—';
    return `**${a.name}**: ${toHit} to hit; ${dmg}.`;
  }).join('\n');
}

// ---- Persist a parsed !vsheet payload into the ACTIVE party ----
// Supports both call styles:
//   saveParsedVsheet(guildId, channelId, charName, parsed, playerId?)
//   saveParsedVsheet(parsed, { guildId, channelId, characterName, playerId })
function saveParsedVsheet(...args) {
  let guildId, channelId, characterName, playerId, parsed;

  if (typeof args[0] === 'string') {
    [guildId, channelId, characterName, parsed, playerId] = args;
  } else {
    parsed = args[0] || {};
    const opt = args[1] || {};
    guildId = opt.guildId;
    channelId = opt.channelId;
    characterName = opt.characterName;
    playerId = opt.playerId ?? null;
  }

  const name = (characterName || parsed?.name || '').trim();
  if (!name) {
    console.warn('saveParsedVsheet: missing charName; skipping update');
    return false;
  }

  // Resolve active party (creates default if none)
  const party = ensureActiveParty(guildId, channelId);
  const partyId = party.id;

  const num = (v) => (v === '' || v == null ? null : Number(v));
  const csv = (arr) => {
    if (!arr) return null;
    if (Array.isArray(arr)) return arr.join(', ') || null;
    return String(arr).trim() || null;
  };

  const abilitiesJson = JSON.stringify(parsed.abilities || {});
  const savesJson     = JSON.stringify(parsed.saves || {});
  const skillsJson    = JSON.stringify(parsed.skills || {});
  const attacksJson   = JSON.stringify(parsed.attacks || []);
  const dataJson      = JSON.stringify(parsed || {});

  const resistances = csv(parsed.resistances);
  const senses      = csv(parsed.senses);

  const updatedAt = Date.now();

  upsertMemberFromVsheet.run(
    guildId,
    channelId,
    partyId,
    name,
    playerId || null,

    parsed.class || null,
    num(parsed.level),
    num(parsed.prof),

    num(parsed.ac),
    num(parsed.hpCur),
    num(parsed.hpMax),

    num(parsed.init),
    num(parsed.speed),
    num(parsed.passivePerception),

    resistances,
    senses,
    parsed.sheetUrl || null,

    abilitiesJson,
    savesJson,
    skillsJson,
    attacksJson,

    parsed.ancestry || null,
    parsed.background || null,
    dataJson,
    updatedAt
  );

  return true;
}


/* -----------------------------------------------------
   Avrae !vsheet parsing + detection (drop-in helpers)
   NOTE: assumes you already have a global `pendingVsheet` Map.
------------------------------------------------------*/

// Strip markdown/smart punctuation and normalize spaces
function stripMd(s) {
  if (!s) return '';
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    // remove common markdown markers
    .replace(/\*\*|__|[_*`~]/g, '')
    // remove zero-widths and NBSP
    .replace(/[\u200B\u2060\u00A0]/g, ' ')
    // normalize whitespace
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Gather all visible text (message content + embeds)
function collectAvraeText(message) {
  const chunks = [];
  if (message?.content) chunks.push(message.content);
  if (Array.isArray(message?.embeds)) {
    for (const e of message.embeds) {
      if (e.title) chunks.push(e.title);
      if (e.description) chunks.push(e.description);
      if (Array.isArray(e.fields)) {
        for (const f of e.fields) {
          if (f.name)  chunks.push(f.name);
          if (f.value) chunks.push(f.value);
        }
      }
      if (e.footer?.text) chunks.push(e.footer.text);
    }
  }
  return chunks.join('\n').trim();
}

// Looser detector (bot-agnostic) that ignores bare "!vsheet"
function isLikelyVsheetMessage(message) {
  if (!message) return false;
  // ignore our own messages
  if (message.author?.id && message.client?.user?.id && message.author.id === message.client.user.id) {
    return false;
  }

  const raw = collectAvraeText(message);
  const t = stripMd(raw);
  if (!t) return false;

  // Ignore just the command
  if (/^!vsheet\s*$/i.test(t)) return false;

  // Heuristics: look for several labels typical of vsheet
  const clues = [
    /(^|\n)Class:\s*/i,
    /(^|\n)Character Level:\s*\d+/i,
    /(^|\n)Proficiency Bonus:\s*[+-]?\d+/i,
    /(^|\n)AC:\s*\d+/i,
    /(^|\n)HP:\s*\d+\s*\/\s*\d+/i,
    /(^|\n)Attacks\b/i,
    /(^|\n)!vsheet v\d/i,
    /(^|\n)Character Sheet URL:/i
  ];
  const hits = clues.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return hits >= 3; // needs multiple signals
}

// Small numeric helpers
const intOrNull = (x) => {
  if (x == null) return null;
  const m = String(x).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
};
const plusInt = (x) => {
  const n = intOrNull(x);
  return n == null ? null : n;
};

// Robust parser for Avrae’s markdowny vsheet dump
function parseVsheetText(rawInput) {
  const t = stripMd(rawInput);
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);

  const out = {
    name: null,
    class: null,
    level: null,
    prof: null,
    spellAttackBonus: null,
    spellSaveDC: null,
    ac: null,
    hpCur: null,
    hpMax: null,
    init: null,
    speed: null,
    abilities: {},         // {STR:{score,mod}, ...}
    saves: {},             // {Wisdom:+3, ...}
    skills: {},            // {Athletics:+6, ...}
    passivePerception: null,
    resistances: [],
    senses: [],
    attacks: [],           // [{name,toHit,damage}]
    sheetUrl: null,
  };

  if (!lines.length) return out;

  // First line is usually the character name in your samples
  out.name = lines[0];

  const findLine = (re) => lines.findIndex(l => re.test(l));
  const getLine  = (re) => lines.find(l => re.test(l));

  // Core labels (markdown-safe)
  const classLine = getLine(/^Class:\s*/i);
  if (classLine) out.class = classLine.replace(/^Class:\s*/i, '').trim();

  const lvlLine = getLine(/^Character Level:\s*/i);
  if (lvlLine) {
    const m = lvlLine.match(/^Character Level:\s*(\d+)/i);
    if (m) out.level = intOrNull(m[1]);
  }

  const pbLine = getLine(/^Proficiency Bonus:\s*/i);
  if (pbLine) out.prof = plusInt(pbLine.replace(/^Proficiency Bonus:\s*/i, ''));

  const sabLine = getLine(/^Spell Attack Bonus:\s*/i);
  if (sabLine) out.spellAttackBonus = plusInt(sabLine.replace(/^Spell Attack Bonus:\s*/i, ''));

  const sdcLine = getLine(/^Spell Save DC:\s*/i);
  if (sdcLine) out.spellSaveDC = intOrNull(sdcLine.replace(/^Spell Save DC:\s*/i, ''));

  const acLine = getLine(/^AC:\s*/i);
  if (acLine) out.ac = intOrNull(acLine.replace(/^AC:\s*/i, ''));

  const hpLine = getLine(/^HP:\s*/i);
  if (hpLine) {
    const m = hpLine.match(/^HP:\s*(\d+)\s*\/\s*(\d+)/i);
    if (m) { out.hpCur = intOrNull(m[1]); out.hpMax = intOrNull(m[2]); }
  }

  const initLine = getLine(/^Initiative:\s*/i);
  if (initLine) out.init = plusInt(initLine.replace(/^Initiative:\s*/i, ''));

  const speedLine = getLine(/^Speed:\s*/i);
  if (speedLine) out.speed = intOrNull(speedLine.replace(/^Speed:\s*/i, ''));

    // Abilities (often printed across two lines)
  // e.g. line N:   "STR: 18 (+4) DEX: 11 (+0) CON: 15 (+2)"
  //      line N+1: "INT: 11 (+0) WIS: 12 (+1) CHA: 16 (+3)"
  const abilStart = findLine(/^(?:STR|DEX|CON):\s*\d+/i);
  if (abilStart !== -1) {
    const re = /\b(STR|DEX|CON|INT|WIS|CHA):\s*(\d+)\s*\(([-+]\d+)\)/gi;

    const mergeAbilitiesFromLine = (line) => {
      if (!line) return;
      let m;
      while ((m = re.exec(line)) !== null) {
        const key = m[1].toUpperCase();
        const score = intOrNull(m[2]);
        const mod   = intOrNull(m[3]);
        if (score != null) out.abilities[key] = { score, mod };
      }
    };

    // Parse the first line
    mergeAbilitiesFromLine(lines[abilStart]);

    // Parse any immediately-following lines that continue the pattern
    let i = abilStart + 1;
    while (i < lines.length && /^(?:STR|DEX|CON|INT|WIS|CHA):\s*\d+/i.test(lines[i])) {
      mergeAbilitiesFromLine(lines[i]);
      i++;
    }
  }

  // Saves
  const saveLine = getLine(/^Saving Throw Proficiencies:\s*/i);
  if (saveLine) {
    const payload = saveLine.replace(/^Saving Throw Proficiencies:\s*/i, '').trim();
    payload.split(/\s*,\s*/).forEach(pair => {
      const mm = pair.match(/^([A-Za-z ]+)\s*([+-]?\d+)$/);
      if (mm) out.saves[mm[1].trim()] = intOrNull(mm[2]);
    });
  }

  // Skills
  const skillLine = getLine(/^Skill Proficiencies:\s*/i);
  if (skillLine) {
    const payload = skillLine.replace(/^Skill Proficiencies:\s*/i, '').trim();
    payload.split(/\s*,\s*/).forEach(pair => {
      const mm = pair.match(/^([A-Za-z ']+)\s*([+-]?\d+)$/);
      if (mm) out.skills[mm[1].trim()] = intOrNull(mm[2]);
    });
  }

  // Resistances
  const resLine = getLine(/^Resistances:\s*/i);
  if (resLine) {
    const payload = resLine.replace(/^Resistances:\s*/i, '').trim();
    if (payload) out.resistances = payload.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  }

  // Senses (grab passive Perception)
  const sensesLine = getLine(/^Senses:\s*/i);
  if (sensesLine) {
    const payload = sensesLine.replace(/^Senses:\s*/i, '').trim();
    out.senses = payload ? [payload] : [];
    const ppm = payload.match(/\bpassive\s+Perception\s+(\d+)\b/i);
    if (ppm) out.passivePerception = intOrNull(ppm[1]);
  }

  // Attacks section
  const atkHdr = findLine(/^Attacks\b/i);
  if (atkHdr !== -1) {
    for (let i = atkHdr + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) break;
      if (/^Character Sheet URL:/i.test(line)) break;
      // "Longsword: +6 to hit; 1d8+4 slashing damage."
      const m = line.match(/^([^:]+):\s*([+-]?\d+)\s*to hit;?\s*(.+?)\.?$/i);
      if (m) {
        out.attacks.push({
          name: m[1].trim(),
          toHit: intOrNull(m[2]),
          damage: m[3].trim()
        });
      } else {
        // stop at first non-attack looking line
        if (/^[A-Z][A-Za-z ]+:/.test(line)) break;
      }
    }
  }

  // Sheet URL
  const urlIdx = findLine(/^Character Sheet URL:/i);
  if (urlIdx !== -1 && lines[urlIdx + 1]) {
    const url = lines[urlIdx + 1].trim();
    if (/^https?:\/\//i.test(url)) out.sheetUrl = url;
  } else {
    // fallback: any dicecloud link in text
    const um = t.match(/\bhttps?:\/\/\S*dicecloud\S+/i);
    if (um) out.sheetUrl = um[0];
  }

  // Improve name if we spotted a later plain line that looks like a name
  for (const l of lines) {
    if (/^(class|character\s+level|proficiency\s+bonus|spell\s+attack|spell\s+save|ac|hp|initiative|speed|str:|dex:|con:|int:|wis:|cha:|saving\s+throw|skill\s+proficiencies|background|resistances|senses|attacks|character\s+sheet\s+url)/i.test(l)) continue;
    if (!/^https?:/i.test(l)) { out.name = out.name || l; }
  }

  return out;
}


/* =========================
   Discord client
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // toggle ON in Dev Portal
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel,Partials.Message],
});

/* =========================
   Persistent Monster Registry
========================= */
const MOVES_DB_PATH = process.env.MOVES_DB_PATH || 'monster_moves.sqlite';
let movesDb = null;
try {
  movesDb = new Database(MOVES_DB_PATH);
  movesDb.exec(`
    CREATE TABLE IF NOT EXISTS actor_moves (
      channel_id TEXT NOT NULL,
      exact_name TEXT NOT NULL,
      base_name  TEXT NOT NULL,
      kind       TEXT NOT NULL,  -- 'action' | 'bonus' | 'reaction'
      move_name  TEXT NOT NULL,
      PRIMARY KEY (channel_id, exact_name, kind, move_name)
    );
    CREATE INDEX IF NOT EXISTS idx_actor_moves_base
      ON actor_moves(channel_id, base_name);
  `);
  console.log('Moves DB ready:', MOVES_DB_PATH);
} catch (e) {
  console.warn('Moves DB open failed:', e.message);
}


/* =========================
   OpenAI client + model config
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Allowed models (edit to match what your account has access to)
const ALLOWED_MODELS = ['gpt-5', 'gpt-5-mini', 'o4-mini', 'gpt-4.1', 'gpt-4.1-mini'];

// Default model for the server if none selected via /model set
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

// “fast lane” model the GM can switch to automatically for short/simple turns
const FAST_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-5-mini';

// Runtime behavior defaults (can override via .env or slash options)
const NARRATE_ONLY_DEFAULT     = (process.env.NARRATE_ONLY_DEFAULT     || 'true' ).toLowerCase() === 'true';
const INCLUDE_RULES_DEFAULT    = (process.env.INCLUDE_RULES_DEFAULT    || 'false').toLowerCase() === 'true';
const ACT_NOW_DEFAULT          = (process.env.ACT_NOW_DEFAULT          || 'false').toLowerCase() === 'true';

// Defaults for sources display (can override via .env)
const SHOW_SOURCES_DEFAULT = (process.env.SHOW_SOURCES_DEFAULT || 'true').toLowerCase() === 'true';
const SOURCES_EPHEMERAL_DEFAULT = (process.env.SOURCES_EPHEMERAL_DEFAULT || 'true').toLowerCase() === 'true';

// Embeddings / RAG config
mark('opening rules.db...');
const RAG_DB_PATH = process.env.RAG_DB || 'rules.db';
const RAG_TOPK = parseInt(process.env.RAG_TOPK || '6', 10);
const RAG_EMBED_MODEL = process.env.RAG_EMBED_MODEL || 'text-embedding-3-large';

/* =========================
   AVRAE / Auto-GM config
========================= */

// Avrae identity
const AVRAE_NAME = process.env.AVRAE_NAME || 'Avrae';
const AVRAE_ID = process.env.AVRAE_ID || ''; // optional, safer than name

// Auto-GM defaults and timing
const AUTO_GM_DEFAULT = (process.env.AUTO_GM_DEFAULT || 'false').toLowerCase() === 'true';
const AUTO_COOLDOWN_MS = parseInt(process.env.AUTO_COOLDOWN_MS || '5000', 10);

// Known PC names (CSV)
const PC_NAMES = new Set(
  (process.env.PC_NAMES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// Monster hint regex (broad safety net — used only if abbreviation pattern doesn’t match)
const MONSTER_HINTS = new RegExp(
  process.env.MONSTER_HINTS ||
    '(goblin|ogre|bandit|skeleton|zombie|wolf|cultist|kobold|gnoll|orc|troll|golem|ghoul|wight|hobgoblin|bugbear|lich|vampire|imp|quasit|worg|drake|wyrm|slime|gelatinous|ooze)',
  'i'
);

// Auto-GM mode: 'narrate_only' | 'include_rules' | 'act_now' | 'act_now_rules'
const AUTO_MODE_DEFAULT = (process.env.AUTO_MODE_DEFAULT || 'act_now').toLowerCase();
const autoMode = new Map(); // channelId -> mode

function modeToSettings(style) {
  switch ((style || '').toLowerCase()) {
    case 'include_rules':   return { includeRules: true,  actNow: false };
    case 'act_now':         return { includeRules: false, actNow: true  };
    case 'act_now_rules':   return { includeRules: true,  actNow: true  };
    case 'narrate_only':
    default:                return { includeRules: false, actNow: false };
  }
}
function getAutoMode(channelId) {
  return autoMode.get(channelId) || AUTO_MODE_DEFAULT;
}

// Silent PC turns (no narration/commands on player turns)
const AUTO_SILENT_PC_TURNS_DEFAULT =
  (process.env.AUTO_SILENT_PC_TURNS_DEFAULT || 'false').toLowerCase() === 'true';
const silentPcTurns = new Map(); // channelId -> boolean
function getSilentPcTurns(channelId) {
  return silentPcTurns.has(channelId)
    ? silentPcTurns.get(channelId)
    : AUTO_SILENT_PC_TURNS_DEFAULT;
}

// GM-ops channel (for auto button posts)
const GM_OPS_CHANNEL_ID = process.env.GM_OPS_CHANNEL_ID || '';

/* =========================
   Per-guild model selection
========================= */
const guildModel = new Map();
const getModel = (guildId) => guildModel.get(guildId) || DEFAULT_MODEL;

/* =========================
   Smart routing: pick big vs fast model
========================= */
function chooseModelForGM({ baseModel, miniModel, transcriptChars, retrievedChars, complexityHint }) {
  const big = baseModel || 'gpt-5';
  const mini = miniModel || FAST_MODEL;
  const size = (transcriptChars || 0) + (retrievedChars || 0);
  const longContext = size > 12000; // rough heuristic on chars
  const complex = /\b(boss|lair|legendary|puzzle|social|downtime plan|heist|complex|multi-attack)\b/i.test(
    complexityHint || ''
  );
  return (longContext || complex) ? big : mini;
}

/* =========================
   Registered game channels (from .env)
   - Accept threads whose PARENT is registered
========================= */
const GAME_CHANNEL_IDS = new Set(
  (process.env.GAME_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function isRegisteredGameChannel(channelOrId) {
  const id = typeof channelOrId === 'string' ? channelOrId : channelOrId?.id;
  if (id && GAME_CHANNEL_IDS.has(String(id))) return true;

  // If this is a thread, allow it when the parent is registered
  const ch = typeof channelOrId === 'string' ? null : channelOrId;
  if (ch && typeof ch.isThread === 'function' && ch.isThread() && ch.parentId) {
    return GAME_CHANNEL_IDS.has(String(ch.parentId));
  }
  return false;
}

/* =========================
   Transcript capture (players + Avrae)
========================= */
const transcript = new Map(); // channelId -> [strings]
function pushTranscript(channelId, text, max = 30) {
  const arr = transcript.get(channelId) || [];
  arr.push(text);
  while (arr.length > max) arr.shift();
  transcript.set(channelId, arr);
}
function summarizeMessage(msg) {
  const author = msg.author?.username || 'Unknown';
  const base = msg.cleanContent || '';
  const embeds = (msg.embeds || [])
    .map((e) =>
      [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)]
        .filter(Boolean)
        .join('\n')
    )
    .filter(Boolean)
    .join('\n');
  const text = [base, embeds].filter(Boolean).join('\n').trim();
  if (!text) return null;
  return `[${author}] ${text}`.slice(0, 1800);
}

/* =========================
   Auto-GM turn detection
========================= */
const autoGMEnabled = new Map(); // channelId -> boolean
const autoState = new Map();     // channelId -> { lastTurn: string, lastTs: number }

function isFromAvrae(msg) {
  const idOk = AVRAE_ID && String(msg.author?.id) === String(AVRAE_ID);
  const nameOk = msg.author?.bot && new RegExp(`^${AVRAE_NAME}$`, 'i').test(msg.author?.username || '');
  return !!(idOk || nameOk);
}
function sanitizeName(s) {
  return (s || '').replace(/[*_`~<>]/g, '').trim();
}
function extractTurnName(msg) {
  if (!isFromAvrae(msg)) return null;

  // normalize: strip code fences/backticks/markdown emphasis
  let text = msg.cleanContent || '';
  text = text.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, inner) => inner || '');
  text = text.replace(/[`*_~]/g, '');
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);

  // "Initiative 22 (round 2): NAME (@someone)"
  for (const line of lines) {
    const m = line.match(/Initiative\s+\d+(?:\s*\(round\s*\d+\))?\s*:\s*([^\n:(<]+?)(?=\s*(?:\(|<|$))/i);
    if (m) return sanitizeName(m[1]);
  }
  // "It is now NAME's turn"
  const m2 = text.match(/(?:^|\b)it(?:'s| is| is now)\s+(.+?)'s turn\b/i);
  if (m2) return sanitizeName(m2[1]);

  // Fallback: "NAME <Healthy>"
  for (let i = lines.length - 1; i >= 0; i--) {
    const mm = lines[i].match(/^([A-Za-z0-9.'_\- ]{2,})\s*<[^>]+>\s*$/);
    if (mm) return sanitizeName(mm[1]);
  }

  // Embeds (very rare with Avrae default)
  for (const e of (msg.embeds || [])) {
    const f = (e.fields || []).find(f => /^turn$/i.test(f.name));
    if (f?.value) return sanitizeName(f.value);
    if (e.description) {
      const d = e.description.replace(/[`*_~]/g, '');
      const mA = d.match(/Initiative\s+\d+(?:\s*\(round\s*\d+\))?\s*:\s*([^\n:(<]+?)(?=\s*(?:\(|<|$))/i);
      if (mA) return sanitizeName(mA[1]);
      const mB = d.match(/(?:^|\b)it(?:'s| is| is now)\s+(.+?)'s turn\b/i);
      if (mB) return sanitizeName(mB[1]);
    }
  }
  return null;
}
function classifyCombatant(rawName) {
  const name = (rawName || '').trim();
  const lower = name.toLowerCase();
  if (!name) return { isMonster: false, reason: 'empty' };

  // Exact PC list wins
  if (typeof PC_NAMES !== 'undefined' && PC_NAMES.has(lower)) {
    return { isMonster: false, reason: 'pc_list' };
  }

  // Common Avrae monster style: GO1, GoFF2, HW10, etc.
  if (/^[A-Za-z][A-Za-z]*\d{1,4}$/.test(name)) {
    return { isMonster: true, reason: 'digits_suffix' };
  }

  // Regex hints (from your env MONSTER_HINTS)
  if (typeof MONSTER_HINTS !== 'undefined' && MONSTER_HINTS.test(lower)) {
    return { isMonster: true, reason: 'regex_hint' };
  }

  return { isMonster: false, reason: 'no_match' };
}

function looksLikeMonster(name) {
  return classifyCombatant(name).isMonster;
}

async function maybeAutoResumeAfterRoster(msg, parsed) {
  const chId = msg.channel.id;

  // Auto-GM must be on
  const autoOn = autoGMEnabled.has(chId) ? autoGMEnabled.get(chId) : AUTO_GM_DEFAULT;
  if (!autoOn) { console.log('Auto-resume: autoGM OFF'); return; }

  // Who's up?
  const actor = (parsed && parsed.current) || (autoState.get(chId)?.lastTurn) || '';
  if (!actor) { console.log('Auto-resume: no current actor'); return; }

  // Do we have a complete roster yet?
  const snap = buildCombatSnapshot(chId, actor);
  if (snap.pcs.length === 0 || snap.monsters.length === 0) {
    console.log('Auto-resume: roster still incomplete', { pcs: snap.pcs.length, mons: snap.monsters.length });
    return;
  }

  // Cooldown guard
  const st = autoState.get(chId) || { lastTurn: '', lastTs: 0 };
  if (st.lastTurn === actor && Date.now() - st.lastTs < AUTO_COOLDOWN_MS) {
    console.log('Auto-resume: cooldown');
    return;
  }

  // Mode & PC/monster handling
  const mode = getAutoMode(chId);
  const base = modeToSettings(mode);
  const isMonster = classifyCombatant(actor).isMonster;
  const silentPC  = getSilentPcTurns(chId);

  // If it's a PC turn and you want silence, do nothing.
  if (!isMonster && silentPC) {
    console.log('Auto-resume: PC turn (silent), skipping.', { actor });
    autoState.set(chId, { lastTurn: actor, lastTs: Date.now() });
    return;
  }

  // Decide flags for run
  const includeRules = base.includeRules;
  const actNow = isMonster ? base.actNow : false;   // never act on PC turns
  const silentPublic = !isMonster && silentPC ? true : false;

  console.log('Auto-resume: running GM for', { actor, isMonster, includeRules, actNow, silentPublic });

  try {
    await runGMForChannel(
      msg.channel,
      `Resuming ${actor}'s turn after roster list.`,
      { actNow, includeRules, actor, silentPublic }
    );
    autoState.set(chId, { lastTurn: actor, lastTs: Date.now() });
    setLastActiveGameChannel(msg.channel);
  } catch (e) {
    console.error('Auto resume after roster failed:', e);
  }
}

/* =========================
   Known actions memory (with kinds)
   chId -> key -> { actions:Set, bonus:Set, reactions:Set }
   keys = exact actor (e.g., "Goblin Hexer1") and base prefix (e.g., "Goblin Hexer")
========================= */
const knownActions = new Map();

function getActorBase(name) {
  // "Goblin Hexer 1" -> "Goblin Hexer", "GoFF3" -> "GoFF"
  return (name || '').replace(/[\s#_\-]*\d+\s*$/, '').trim();
}

function ensureActionBucket(chId, key) {
  let m = knownActions.get(chId);
  if (!m) { m = new Map(); knownActions.set(chId, m); }
  let b = m.get(key);
  if (!b) { b = { actions: new Set(), bonus: new Set(), reactions: new Set() }; m.set(key, b); }
  return b;
}

/** entries: [{ name, kind }] where kind ∈ 'action' | 'bonus' | 'reaction' */
function rememberActorActions(chId, actor, entries = []) {
  if (!chId || !actor || !entries?.length) return;
  const base = getActorBase(actor);
  const keys = new Set([actor, base]);
  for (const k of keys) {
    const bucket = ensureActionBucket(chId, k);
    for (const e of entries) {
      const nm = (e?.name || '').trim();
      const kind = (e?.kind || 'action').toLowerCase();
      if (!nm) continue;
      if (kind === 'bonus') bucket.bonus.add(nm);
      else if (kind === 'reaction') bucket.reactions.add(nm);
      else bucket.actions.add(nm);
    }
  }
  console.log(`Learned moves for ${actor} (base "${base}") @ ${chId}:`, entries.map(x => `${x.kind}:${x.name}`));
}

function getActorActions(chId, actor) {
  const m = knownActions.get(chId);
  if (!m || !actor) return { actions: [], bonus: [], reactions: [] };
  const base = getActorBase(actor);
  const exact = m.get(actor);
  const pref  = m.get(base);
  const out = { actions:new Set(), bonus:new Set(), reactions:new Set() };
  for (const b of [pref, exact]) if (b) {
    b.actions.forEach(x => out.actions.add(x));
    b.bonus.forEach(x => out.bonus.add(x));
    b.reactions.forEach(x => out.reactions.add(x));
  }
  return {
    actions: Array.from(out.actions),
    bonus: Array.from(out.bonus),
    reactions: Array.from(out.reactions),
  };
}

function persistActorActions(chId, actor, entries=[]) {
  if (!movesDb || !chId || !actor || !entries.length) return;
  const base = getActorBase(actor);
  const insert = movesDb.prepare(`
    INSERT OR IGNORE INTO actor_moves(channel_id, exact_name, base_name, kind, move_name)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = movesDb.transaction((list) => {
    for (const e of list) insert.run(chId, actor, base, (e.kind||'action'), e.name);
  });
  try { tx(entries); } catch(e) { console.warn('persistActorActions failed:', e.message); }
}

function hydrateKnownActionsFromDB(chId, actor) {
  if (!movesDb || !chId || !actor) return;
  const base = getActorBase(actor);
  const sel = movesDb.prepare(`
    SELECT kind, move_name FROM actor_moves
    WHERE channel_id = ? AND (exact_name = ? OR base_name = ?)
  `);
  const rows = sel.all(chId, actor, base);
  if (!rows.length) return;
  const entries = rows.map(r => ({ kind: r.kind, name: r.move_name }));
  rememberActorActions(chId, actor, entries);
}

// On startup, optional: pre-hydrate for your channels
for (const id of GAME_CHANNEL_IDS) { /* nothing to do now; we hydrate on demand */ }


/* =========================
   Last active game channel (for /teach default)
========================= */
const lastActiveGameChannel = new Map(); // guildId -> channelId
function setLastActiveGameChannel(channel) {
  const g = channel?.guildId || channel?.guild?.id;
  if (g && channel?.id) lastActiveGameChannel.set(g, channel.id);
}
function getDefaultTeachChannelId(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return null;
  return lastActiveGameChannel.get(guildId) || null;
}


/* =========================
   Avrae "attack list" detector + extractor
========================= */
function extractAttackNamesFromText(raw) {
  // Strip code fences, keep inner text
  let t = (raw || '').replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, inner) => inner || '');
  t = t.replace(/\r/g, '');
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const out = new Set();

  for (const line of lines) {
    // Heuristic: lines that look like attack entries (typical SRD/Avrae descriptors)
    if (!/(to hit|on a hit|hit:|melee|ranged|reach|range)/i.test(line)) continue;

    // Pull the leading "name" token before punctuation/paren
    // Examples it catches: "Scimitar. Melee Weapon Attack: +4 to hit ..."
    //                       "- Bite (Melee Weapon Attack): +5 to hit ..."
    //                       "• Shortbow — Ranged Weapon Attack: +4 to hit ..."
    const m =
      line.match(/^[\-\*\u2022]?\s*("?)([A-Za-z][A-Za-z0-9 '\/\-]+?)\1\s*(?=[(.:—-])/)
      || line.match(/^[\-\*\u2022]?\s*("?)([A-Za-z][A-Za-z0-9 '\/\-]+?)\1\s+(?:Melee|Ranged)/i);

    if (m && m[2]) out.add(m[2].trim());
  }

  return Array.from(out);
}

function looksLikeAttackListMessage(msg) {
  const text = msg.cleanContent || '';
  // Avrae often includes "Attacks:" OR recognizable statblock phrasing
  return (
    /attacks?:/i.test(text) ||
    /(melee|ranged)\s+weapon\s+attack/i.test(text) ||
    /to hit/i.test(text)
  );
}

// Target sanitizer (force PC-only, leave remembering to caller)
function sanitizeTargetsInModelText(modelText, snapshot) {
  const n = modelText.match(/<NARRATION>([\s\S]*?)<\/NARRATION>/i)?.[1] ?? '';
  const a = modelText.match(/<AVRAE>([\s\S]*?)<\/AVRAE>/i)?.[1] ?? '';
  const pcs = new Set(snapshot.pcs.map(p => (p.name || '').toLowerCase()));
  const fallback = pickDefaultTarget(snapshot);

  const lines = a
    ? a.split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => {
          // Match -t "Name" or -target 'Name'
          const m = line.match(/-(?:t|target)\s+["']([^"']+)["']/i);
          if (m) {
            const want = m[1];
            if (!pcs.has((want || '').toLowerCase()) && fallback) {
              // Replace only that -t/-target segment with a safe PC fallback
              return line.replace(m[0], `-t "${fallback}"`);
            }
          }
          return line;
        })
    : [];

  // Extract the (possibly corrected) first target used, for the caller to remember
  const mLast = lines.join('\n').match(/-(?:t|target)\s+["']([^"']+)["']/i);

  const rebuilt =
    (n ? `<NARRATION>\n${n}\n</NARRATION>\n` : '') +
    (lines.length ? `<AVRAE>\n${lines.join('\n')}\n</AVRAE>\n` : '');

  return { text: rebuilt || modelText, avraeTargets: mLast?.[1] || null };
}


/* =========================
   Combat state (per channel) + Avrae parsers
========================= */
const combatState = new Map(); // chId -> { roster: Map(name->{type,hp,maxhp,ac,conditions,lastSeenTs}), round, lastActor }
const lastTargets = new Map(); // chId -> Map(actor -> lastPcName)

function getCS(chId) {
  let cs = combatState.get(chId);
  if (!cs) { cs = { roster: new Map(), round: 0, lastActor: '' }; combatState.set(chId, cs); }
  return cs;
}
function setLastTarget(chId, actor, pcName) {
  if (!actor || !pcName) return;
  let m = lastTargets.get(chId);
  if (!m) { m = new Map(); lastTargets.set(chId, m); }
  m.set(actor, pcName);
}
function getLastTarget(chId, actor) {
  const m = lastTargets.get(chId);
  return m ? m.get(actor) : null;
}

function upsertCombatant(cs, name, data) {
  const now = Date.now();
  const prev = cs.roster.get(name) || {};
  cs.roster.set(name, { ...prev, ...data, lastSeenTs: now });
}

function classifyType(name) {
  // use your existing PC_NAMES + monster regex
  if (PC_NAMES.has((name || '').toLowerCase())) return 'pc';
  return looksLikeMonster(name) ? 'monster' : 'pc';
}

// Robustly strip code fences; leave inner text
function unfence(raw) {
  return (raw || '').replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, inner) => inner || '');
}

// Parse Avrae status/initiative blobs to update roster/round
function ingestAvraeForCombat(msg) {
  if (!isFromAvrae(msg)) return;
  const chId = msg.channel.id;
  const cs = getCS(chId);

  let text = unfence(msg.cleanContent || '').replace(/\r/g, '');
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);

  // 0) Full roster dump from !init list
  if (/Current initiative:/i.test(text)) {
    const parsed = parseInitListText(text);
    if (parsed) {
      if (parsed.round) cs.round = parsed.round;
      if (parsed.current) cs.lastActor = parsed.current;

      for (const e of parsed.entries) {
        upsertCombatant(cs, e.name, {
          type: classifyType(e.name),
          hp: Number.isFinite(e.hp) ? e.hp : undefined,
          maxhp: Number.isFinite(e.maxhp) ? e.maxhp : undefined,
          ac: Number.isFinite(e.ac) ? e.ac : undefined
        });
      }

      // DEBUG: show what we learned
      const pcs = [], monsters = [];
      for (const e of parsed.entries) {
        (classifyType(e.name) === 'monster' ? monsters : pcs).push(e.name);
      }
      console.log('INIT LIST parsed:', {
        round: cs.round,
        current: cs.lastActor,
        pcs,
        monsters
      });

      // Clear the roster prompt cooldown so we don't nag again
      try { rosterPromptAt.set(msg.channel.id, 0); } catch {}

      // Immediately resume current turn once we have a roster
      // (fire-and-forget to keep the message handler simple)
      maybeAutoResumeAfterRoster(msg, parsed).catch(() => {});
    }
  }

  // Round + actor (e.g., "Initiative 19 (round 2): OG1 (@Aegis)")
  for (const line of lines) {
    const m = line.match(/Initiative\s+\d+(?:\s*\(round\s*(\d+)\))?\s*:\s*([^\n:(<]+?)(?=\s*(?:\(|<|$))/i);
    if (m) {
      if (m[1]) cs.round = parseInt(m[1], 10) || cs.round;
      cs.lastActor = (m[2] || '').trim();
      break;
    }
  }

  // Roster lines like: "Aegis <20/20 HP> (AC 15)" or "OG1 <Healthy>" (no numbers sometimes)
  for (const line of lines) {
    // hp/ac style
    let m = line.match(/^([A-Za-z0-9.'_\- ]{2,})\s*<\s*(\d+)\s*\/\s*(\d+)\s*HP\s*>\s*(?:\(AC\s*(\d+)\))?/i);
    if (m) {
      const name = m[1].trim();
      const hp = parseInt(m[2], 10), maxhp = parseInt(m[3], 10), ac = m[4] ? parseInt(m[4], 10) : undefined;
      upsertCombatant(cs, name, { type: classifyType(name), hp, maxhp, ac });
      continue;
    }
    // health word only (e.g., "<Healthy>") — keep the name in roster at least
    m = line.match(/^([A-Za-z0-9.'_\- ]{2,})\s*<[^>]+>\s*$/);
    if (m) {
      const name = m[1].trim();
      upsertCombatant(cs, name, { type: classifyType(name) });
    }
  }
}

function parseInitListText(raw) {
  const text = unfence(raw || '').replace(/\r/g, '');
  if (!/Current initiative:/i.test(text)) return null;

  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const header = lines.find(l => /Current initiative:/i.test(l));
  if (!header) return null;

  const roundMatch = header.match(/Current initiative:\s*\d+\s*\(round\s*(\d+)\)/i);
  const round = roundMatch ? parseInt(roundMatch[1], 10) : null;

  const entries = [];
  let current = null;

  // "# 12: Goblin Hexer3 <Healthy>"
  // "   8: Aegis <20/20 HP> (AC 15)"
  const re = /^#?\s*(\d+):\s*([A-Za-z0-9.'_\- ]+?)\s*<([^>]+)>\s*(?:\(AC\s*(\d+)\))?\s*$/i;

  for (const line of lines) {
    if (/^=+$/i.test(line)) continue;
    const starred = line.startsWith('#');
    const m = line.match(re);
    if (!m) continue;

    const init = parseInt(m[1], 10);
    const name = m[2].trim();
    const inside = m[3].trim();
    const ac = m[4] ? parseInt(m[4], 10) : undefined;

    let hp = null, maxhp = null;
    const hpMatch = inside.match(/(\d+)\s*\/\s*(\d+)\s*hp/i);
    if (hpMatch) { hp = parseInt(hpMatch[1], 10); maxhp = parseInt(hpMatch[2], 10); }
    if (starred) current = name;

    entries.push({ init, name, ac, hp, maxhp, status: hpMatch ? null : inside });
  }

  return { round, current, entries };
}


function buildCombatSnapshot(chId, actor) {
  const cs = getCS(chId);
  const pcs = [], monsters = [];
  cs.roster.forEach((v, k) => {
    const entry = {
      name: k,
      hp: Number.isFinite(v.hp) ? v.hp : null,
      maxhp: Number.isFinite(v.maxhp) ? v.maxhp : null,
      ac: Number.isFinite(v.ac) ? v.ac : null,
      conditions: v.conditions || []
    };
    (v.type === 'monster' ? monsters : pcs).push(entry);
  });
  const pct = (x, m) => (Number.isFinite(x) && Number.isFinite(m) && m > 0) ? (x / m) : 1;
  const suggestedTargets = pcs
    .slice()
    .sort((a, b) => (pct(a.hp, a.maxhp) - pct(b.hp, b.maxhp)) || ((a.hp ?? 9999) - (b.hp ?? 9999)));
  return {
    round: cs.round,
    actor,
    pcs,
    monsters,
    suggestedTargets,
    lastTarget: getLastTarget(chId, actor) || null
  };
}

function pickDefaultTarget(snapshot) {
  return snapshot.lastTarget || snapshot.suggestedTargets[0]?.name || null;
}

/* =========================
   Parse Avrae DM "Actions" paste
========================= */
function stripFences(raw) {
  return (raw || '').replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, inner) => inner || '');
}

/** Returns { actor, entries:[{name, kind}] } with kind ∈ 'action' | 'bonus' | 'reaction' */
function parseTeachPaste(raw) {
  let compact = stripFences(raw).replace(/\r/g, '').replace(/\s+/g, ' ').trim();

  // Actor: "<Actor>'s Actions"
  const actorMatch = compact.match(/([^\n:]+?)['’]s\s+Actions\b/i);
  const actor = actorMatch ? actorMatch[1].trim() : null;

  // Mark sections so we can infer kind
  compact = compact
    .replace(/\bBonus Actions?\b/gi, ' <<<KIND:bonus>>> ')
    .replace(/\bReactions?\b/gi,     ' <<<KIND:reaction>>> ')
    .replace(/\bActions?\b/gi,       ' <<<KIND:action>>> ');

  const markerRe = /<<<KIND:(action|bonus|reaction)>>>/gi;
  const markers = [];
  let mk;
  while ((mk = markerRe.exec(compact)) !== null) {
    markers.push({ idx: mk.index, kind: mk[1].toLowerCase() });
  }
  const kindAt = (pos) => {
    let k = 'action';
    for (const m of markers) { if (m.idx <= pos) k = m.kind; else break; }
    return k;
  };

  const entries = [];
  let m;

  // A) Name: Attack / Melee / Ranged ...
  const reA = /(?:^|[\s.;])("?)([A-Za-z][A-Za-z0-9 '\/\-]+?)\1\s*:\s*(?:Attack|Melee|Ranged)\b/gi;
  while ((m = reA.exec(compact)) !== null) {
    const name = m[2].trim();
    const kind = kindAt(m.index);
    if (!/^(actions?|reactions?)$/i.test(name)) entries.push({ name, kind });
  }

  // B) Name (Melee Weapon Attack): ...
  const reB = /(?:^|[\s.;])("?)([A-Za-z][A-Za-z0-9 '\/\-]+?)\1\s*\((?:Melee|Ranged)[^)]+\)\s*:/gi;
  while ((m = reB.exec(compact)) !== null) {
    const name = m[2].trim();
    const kind = kindAt(m.index);
    if (!/^(actions?|reactions?)$/i.test(name)) entries.push({ name, kind });
  }

  // C) Reactions/saves: "Name: DC 13 ..." / "Name: Reaction ..."
  const reC = /(?:^|[\s.;])("?)([A-Za-z][A-Za-z0-9 '\/\-]+?)\1\s*:\s*(?:DC\b|Save\b|Reaction\b|Trigger\b)/gi;
  while ((m = reC.exec(compact)) !== null) {
    const name = m[2].trim();
    const kind = kindAt(m.index);
    if (!/^(actions?|reactions?)$/i.test(name)) entries.push({ name, kind });
  }

  // Dedup
  const seen = new Set();
  const uniq = [];
  for (const e of entries) {
    const key = `${e.kind}|${e.name.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(e); }
  }

  return { actor, entries: uniq }; // ← always defined
}




/* =========================
   RAG: DB open + retrieval
========================= */
let ragDb = null;
try {
  ragDb = new Database(RAG_DB_PATH, { fileMustExist: true,readonly: true, timeout: 10000 });
  ragDb.prepare('SELECT 1').get();
  console.log('RAG DB loaded:', RAG_DB_PATH);
} catch (e) {
  console.warn('RAG DB not found/failed to open. Run `node ingest.js` if you want retrieval.', e.message);
  ragDb = null;
}

async function embedQuery(text) {
  const res = await openai.embeddings.create({ model: RAG_EMBED_MODEL, input: text });
  return res.data[0].embedding;
}
function* iterateDocs() {
  if (!ragDb) return;
  const stmt = ragDb.prepare('SELECT path, chunk_index, text, embedding FROM docs');
  for (const row of stmt.iterate()) {
    yield { path: row.path, chunk_index: row.chunk_index, text: row.text, embedding: JSON.parse(row.embedding) };
  }
}
async function retrieveContext(query, opts = {}) {
  if (!ragDb) return [];
  const topK = (opts.topK || RAG_TOPK);
  const mustTerms = (opts.mustTerms || []).map(s => s.toLowerCase());
  const preferTerms = (opts.preferTerms || []).map(s => s.toLowerCase());

  // Pre-filter by mustTerms
  const stmt = ragDb.prepare('SELECT path, chunk_index, text, embedding FROM docs');
  const allRows = Array.from(stmt.iterate());
  const pool = mustTerms.length
    ? allRows.filter(r => mustTerms.every(w => (r.text || '').toLowerCase().includes(w)))
    : allRows;

  // Score with cosine + small keyword boost for preferTerms
  const qEmb = await embedQuery(query);
  const scored = pool.map(r => {
    const emb = JSON.parse(r.embedding);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < qEmb.length; i++) { const a = qEmb[i], b = emb[i]; dot += a*b; na += a*a; nb += b*b; }
    const cos = dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
    const prefHits = preferTerms.length ? preferTerms.reduce((acc, w) => acc + ((r.text || '').toLowerCase().includes(w) ? 1 : 0), 0) : 0;
    const boost = Math.min(0.10 * prefHits, 0.30);
    return { score: cos + boost, path: r.path, idx: r.chunk_index, text: r.text };
  }).sort((a,b) => b.score - a.score).slice(0, topK);

  return scored.map((p, i) => ({
    rank: i + 1,
    path: p.path,
    idx: p.idx,
    score: p.score,
    text: p.text,
    formatted: `[#${i + 1} • ${p.path} • chunk ${p.idx} • sim ${p.score.toFixed(3)}]\n${p.text}`
  }));
}
/* =========================
   /ask source sessions (for clickable citations)
========================= */
const askSourceSessions = new Map(); // key -> { items:[{path, idx, text, score}], ts }
const ASK_SRC_TTL_MS = 10 * 60 * 1000;

function makeAskSrcKey() { return Math.random().toString(36).slice(2); }

function saveAskSrcSession(key, items) {
  askSourceSessions.set(key, { items: Array.isArray(items) ? items : [], ts: Date.now() });
  setTimeout(() => {
    const s = askSourceSessions.get(key);
    if (s && Date.now() - s.ts >= ASK_SRC_TTL_MS) askSourceSessions.delete(key);
  }, ASK_SRC_TTL_MS + 500);
}

function getAskSrcSession(key) {
  const s = askSourceSessions.get(key);
  if (!s) return null;
  if (Date.now() - s.ts > ASK_SRC_TTL_MS) { askSourceSessions.delete(key); return null; }
  return s;
}

function buildAskSrcButtons(key, items) {
  const rows = [];
  let row = new ActionRowBuilder();
  for (let i = 0; i < Math.min(items.length, 10); i++) {
    const btn = new ButtonBuilder()
      .setCustomId(`asksrc:${key}:${i}`)   // handled in button handler below
      .setLabel(String(i + 1))
      .setStyle(ButtonStyle.Secondary);
    row.addComponents(btn);
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  }
  if (row.components.length) rows.push(row);
  return rows;
}

// Expand a retrieved doc with neighbor chunks for context
function expandDocWithNeighbors(pathStr, idx, radius = 1) {
  if (!ragDb) return null;
  const ns = String(pathStr).replace(/\/\d+$/,'/'); // e.g., 'book:book-xphb/' from 'book:book-xphb/76'
  const min = Math.max(0, (idx|0) - radius);
  const max = (idx|0) + radius;
  const rows = ragDb.prepare(
    `SELECT path, chunk_index, text
       FROM docs
      WHERE path LIKE ? AND chunk_index BETWEEN ? AND ?
      ORDER BY chunk_index ASC`
  ).all(`${ns}%`, min, max);
  if (!rows?.length) return null;
  return rows.map(r => r.text).join('\n\n');
}

/* =========================
   /ask RAG helpers
========================= */

// Prefer 2024 books (xPHB / xDMG / xMM, etc.) over 2014 (PHB/DMG/MM)
function boost2024ForPath(pathStr = '') {
  const p = String(pathStr).toLowerCase();
  // 2024 books look like: book:book-xphb/..., book:book-xdmg/..., book:book-xmm/...
  if (/^book:book-x[a-z]+\/\d+$/i.test(pathStr)) return 0.08; // small boost for any x- prefixed 2024 core book
  // tiny de-preference for 2014 core when a 2024 exists
  if (/^book:book-(phb|dmg|mm)\/\d+$/i.test(pathStr)) return -0.02;
  return 0;
}

function rerankPrefer2024(results = []) {
  return results
    .map(r => ({ ...r, score: r.score + boost2024ForPath(r.path) }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// Quick “is this addressed by DB?” check:
//  - high similarity on the top hit OR
//  - top few contain multiple query keywords
function isAddressedByContext(query, results = []) {
  if (!results.length) return false;
  const top = results[0]?.score || 0;
  if (top >= 0.35) return true; // heuristic threshold

  const kws = (String(query).toLowerCase().match(/[a-z]{4,}/g) || [])
    .filter((w, i, a) => a.indexOf(w) === i);
  if (!kws.length) return top >= 0.30;

  const top3 = results.slice(0, 3);
  let hits = 0;
  for (const r of top3) {
    const t = (r.text || '').toLowerCase();
    const matchCount = kws.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    if (matchCount >= 2) hits++;
  }
  return hits >= 1;
}

// Build a strict context block for the model with inline priority tags for 2024
function buildContextBlock(results = [], maxSources = 6) {
  const use = results.slice(0, maxSources);
  const lines = use.map((r, i) => {
    const priority = boost2024ForPath(r.path) > 0 ? 'PRIORITY: 2024' : '';
    return `[${i + 1}] (${r.path}${priority ? ` • ${priority}` : ''})\n${r.text}`;
  });
  return { text: lines.join('\n\n'), used: use };
}

/* =========================
   Reference packs (book JSON)
========================= */
/* =========================
   /ref — rules & lore search sessions
========================= */
const refSessions = new Map(); // userId -> { key, q, results:[{path, idx, score, text}], page, pageSize, ts }
const REF_TTL_MS = 3 * 60 * 1000;
function refMakeKey() { return Math.random().toString(36).slice(2); }
function setRefSession(userId, data) {
  refSessions.set(userId, { ...data, ts: Date.now() });
  setTimeout(() => {
    const s = refSessions.get(userId);
    if (s && Date.now() - s.ts >= REF_TTL_MS) refSessions.delete(userId);
  }, REF_TTL_MS + 1000);
}
function getRefSession(userId) {
  const s = refSessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.ts >= REF_TTL_MS) { refSessions.delete(userId); return null; }
  return s;
}

// Tiny excerpt helper focused on query terms
function refMakeKeywords(query) {
  const base = (query || '').toLowerCase();
  const words = Array.from(new Set(base.match(/[a-z]{4,}/g) || []));
  const priority = ['opportunity','grapple','prone','concentration','cover','reaction','bonus','hide','stealth','exhaustion','rest','spell','attack'];
  const merged = [...new Set([...priority.filter(p => words.includes(p)), ...words])];
  return merged.slice(0, 8);
}
function refBestExcerpt(text, query, maxLen = 240) {
  const t = (text || '').replace(/\s+/g, ' ');
  if (!t) return '';
  const kws = refMakeKeywords(query);
  let pos = -1;
  for (const k of kws) { const i = t.toLowerCase().indexOf(k); if (i !== -1) { pos = i; break; } }
  if (pos === -1) return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
  const half = Math.floor(maxLen / 2);
  const start = Math.max(0, pos - half);
  const end = Math.min(t.length, start + maxLen);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

// DB fetch for a specific chunk and its neighbors
function parseBookNs(pathStr) {
  // 'book:xphb/76' -> { ns:'book:xphb/', ix: 75 } because chunk_index is 0-based in DB
  const m = (pathStr || '').match(/^(book:[^/]+)\/(\d+)$/i);
  if (!m) return null;
  const ns = m[1] + '/';
  const human = parseInt(m[2], 10) || 1;
  return { ns, humanIndex: human, zeroIndex: human - 1 };
}
function getDocRange(ns, startIdx, endIdx) {
  if (!ragDb) return [];
  const sel = ragDb.prepare(`SELECT chunk_index, text FROM docs WHERE path LIKE ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index`);
  return sel.all(`${ns}%`, startIdx, endIdx);
}

function renderRefPage(sess) {
  const pageSize = Math.max(1, sess.pageSize || 5);
  const total = sess.results.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(sess.page, 0), totalPages - 1);
  const start = page * pageSize;
  const items = sess.results.slice(start, start + pageSize);

  const lines = items.map((it, i) =>
    `**${it.path}**  (sim ${it.score.toFixed(3)})\n${refBestExcerpt(it.text, sess.q, 240)}`
  );
  const header = `Results for **${sess.q}** — page ${page + 1}/${totalPages} • ${total} match${total === 1 ? '' : 'es'}`;
  const content = [header, lines.join('\n\n') || '_No results on this page._'].join('\n\n');

  const components = [];
  // Row(s) of "Open #"
  if (items.length) {
    let row = new ActionRowBuilder();
    for (let i = 0; i < items.length; i++) {
      const globalIdx = start + i; // index into full results
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ref_open:${sess.key}:${globalIdx}`)
          .setLabel(`Open ${i + 1}`)
          .setStyle(ButtonStyle.Secondary)
      );
      if (row.components.length === 5) { components.push(row); row = new ActionRowBuilder(); }
    }
    if (row.components.length) components.push(row);
  }
  // Pagination row
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ref_page:${sess.key}:prev`)
          .setLabel('Prev')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`ref_page:${sess.key}:next`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= totalPages - 1),
      )
    );
  }
  return { content, components };
}

/* =========================
   Bestiary packs (local JSON) — loader + search (5etools-aware)
   Looks in resources/bestiary for *.json packs, recursively.

   Normalized monster shape we keep:
     { name, actions:[], bonus:[], reactions:[], multiattack: string|null, source, raw }
========================= */

const BESTIARY_DIR = process.env.BESTIARY_DIR
  || path.join(process.cwd(), 'resources', 'bestiary');

// Pack index:
//  - bestiaryPacks: Map<packFile, monsters[]>  (monsters are normalized objects)
//  - bestiaryByName: Map<normalizedName, Array<{ pack, idx, monster }>>
const bestiaryPacks = new Map();
const bestiaryByName = new Map();

// Compat alias for any code that used "bestiaryIndexByName"
const bestiaryIndexByName = bestiaryByName;

function normName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^\w\s]/g, '')         // rm punctuation
    .replace(/\s+/g, ' ')
    .trim();
}
// Strip trailing numbers in monster tokens for base matching (“Goblin Hexer 2” → “Goblin Hexer”)
function baseName(s) {
  return (s || '').replace(/[\s#_\-]*\d+\s*$/, '').trim();
}

// 5etools uses "monster" (singular) at top-level. Support other shapes too.
function safeArrayFromAny(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    if (Array.isArray(x.monster))   return x.monster;    // 5etools
    if (Array.isArray(x.monsters))  return x.monsters;   // alt packs
    if (Array.isArray(x.creatures)) return x.creatures;  // alt packs
    if (x.name) return [x];
  }
  return [];
}

// Remove 5etools inline tags like {@atk mw} etc., keep readable text
function strip5eTags(s) {
  return String(s || '').replace(/\{@[^}]+}/g, '').replace(/\s+/g, ' ').trim();
}

// Extract display names from action/bonus/reaction arrays
function extractNames(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    const nm = (it && it.name) ? String(it.name).trim() : '';
    if (!nm) continue;
    // Skip Multiattack entry here; we expose it separately
    if (/^multiattack\b/i.test(nm)) continue;
    out.push(nm);
  }
  return out;
}

// Find the Multiattack text (if any)
function getMultiattackText(arr) {
  if (!Array.isArray(arr)) return null;
  const m = arr.find(it => it && it.name && /^multiattack\b/i.test(it.name));
  if (!m) return null;
  const entries = Array.isArray(m.entries) ? m.entries : [];
  const text = entries.map(strip5eTags).filter(Boolean).join(' ');
  return text || 'Multiattack.';
}

// Normalize a raw 5etools monster-ish object to our shape
// --- helpers (re-use your existing strip5eTags if you already have it) ---
function entriesToText(entries) {
  if (!entries) return '';
  const arr = Array.isArray(entries) ? entries : [entries];
  return arr
    .map(e => sbExpand5eInline(typeof e === 'string' ? e : (e?.toString?.() || '')))
    .filter(Boolean)
    .join(' ');
}

function normalizeActionArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    const name = it?.name ? String(it.name).trim() : '';
    if (!name) continue;
    const text = entriesToText(it.entries);
    out.push({ name, text });
  }
  return out;
}
function extractNames(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    const nm = (it && it.name) ? String(it.name).trim() : '';
    if (!nm) continue;
    if (/^multiattack\b/i.test(nm)) continue; // handled separately
    out.push(nm);
  }
  return out;
}
function getMultiattackText(arr) {
  if (!Array.isArray(arr)) return null;
  const m = arr.find(it => it && it.name && /^multiattack\b/i.test(it.name));
  if (!m) return null;
  const txt = entriesToText(m.entries);
  return txt || 'Multiattack.';
}
// spell list helpers
const ORD = (n) => (['0th','1st','2nd','3rd'][n] || `${n}th`).replace(/^0th$/,'Cantrips');
function cleanSpellName(s) {
  // turns '{@spell darkness}' into 'darkness'
  return String(s || '').replace(/\{@spell\s+([^}|]+)(?:\|[^}]+)?}/gi, '$1').trim();
}
function listSpells(arr) {
  return (arr || []).map(cleanSpellName).filter(Boolean).join(', ');
}
function pullDC(text) {
  const m = String(text || '').match(/\bDC\s*(\d{1,2})\b/i);
  return m ? parseInt(m[1], 10) : null;
}
function normalizeSpellcastingBlocks(scArr) {
  if (!Array.isArray(scArr)) return [];
  const out = [];
  for (const sc of scArr) {
    const name = sc.name || 'Spellcasting';
    const header = entriesToText(sc.headerEntries);
    const ability = (sc.ability || '').toString().toUpperCase() || null;
    const dc = pullDC(header);

    const lines = [];

    // Innate “at will”
    if (Array.isArray(sc.will) && sc.will.length) {
      lines.push(`At will: ${listSpells(sc.will)}`);
    }
    // Innate “daily/weekly/etc.”
    const freqMaps = ['daily','weekly','monthly','yearly'];
    for (const key of freqMaps) {
      const bucket = sc[key];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [k, arr] of Object.entries(bucket)) {
        // 5etools uses "1" vs "1e" (each). Show both nicely.
        const each = /e$/i.test(k) ? ' each' : '';
        const count = k.replace(/e$/i, '');
        lines.push(`${count}/day${each}: ${listSpells(arr)}`);
      }
    }
    // Prepared/known spells object
    if (sc.spells && typeof sc.spells === 'object') {
      for (const [lvl, spec] of Object.entries(sc.spells)) {
        const spells = listSpells(spec?.spells || []);
        if (!spells) continue;
        if (lvl === '0') {
          lines.push(`Cantrips (at will): ${spells}`);
        } else {
          const slots = spec?.slots ? ` (${spec.slots} slot${spec.slots === 1 ? '' : 's'})` : '';
          lines.push(`${ORD(Number(lvl))}${slots}: ${spells}`);
        }
      }
    }

    out.push({
      name,
      header,
      ability,
      dc,
      lines,            // human-friendly bullets like “At will: …”, “1/day each: …”
      raw: sc
    });
  }
  return out;
}

function normalizeMonster(raw) {
  const name = raw?.name || '';

  // full text arrays
  const traitsFull    = normalizeActionArray(raw?.trait);
  const actionsFull   = normalizeActionArray(raw?.action);
  const bonusFull     = normalizeActionArray(raw?.bonus || raw?.bonusActions);
  const reactionsFull = normalizeActionArray(raw?.reaction || raw?.reactions);

  // quick lists
  const actions   = extractNames(raw?.action);
  const bonus     = extractNames(raw?.bonus || raw?.bonusActions);
  const reactions = extractNames(raw?.reaction || raw?.reactions);
  const multiattack = getMultiattackText(raw?.action);

  // spellcasting
  const spellcasting = normalizeSpellcastingBlocks(raw?.spellcasting);

  return {
    name,
    actions, bonus, reactions, multiattack,
    traitsFull, actionsFull, bonusFull, reactionsFull,
    spellcasting,
    source: raw?.source || raw?._source || null,
    page: raw?.page || null,
    size: raw?.size || null,
    type: raw?.type || null,
    alignment: raw?.alignment || null,
    ac: raw?.ac || null,
    hp: raw?.hp || null,
    speed: raw?.speed || null,
    str: raw?.str, dex: raw?.dex, con: raw?.con, int: raw?.int, wis: raw?.wis, cha: raw?.cha,
    save: raw?.save || null,
    skill: raw?.skill || null,
    senses: raw?.senses || null,
    passive: raw?.passive || null,
    languages: raw?.languages || null,
    cr: raw?.cr || null,
    raw
  };
}


function indexMonster(packPath, monster, idx) {
  const name = monster?.name || '';
  if (!name) return;
  const keyExact = normName(name);
  const keyBase  = normName(baseName(name));

  const push = (key) => {
    if (!key) return;
    if (!bestiaryByName.has(key)) bestiaryByName.set(key, []);
    bestiaryByName.get(key).push({ pack: packPath, idx, monster });
  };
  push(keyExact);
  if (keyBase !== keyExact) push(keyBase);

  // Also index any aliases present in the *raw* object
  const raw = monster.raw || {};
  if (Array.isArray(raw.aliases)) {
    for (const a of raw.aliases) push(normName(a));
  }
}

function walkJsonFiles(dir) {
  const out = [];
  function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && /\.json$/i.test(ent.name)) out.push(p);
    }
  }
  walk(dir);
  return out;
}

function loadBestiary() {
  bestiaryPacks.clear();
  bestiaryByName.clear();

  const files = walkJsonFiles(BESTIARY_DIR);
  let packCount = 0, monCount = 0;

  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const json = JSON.parse(raw);
      const arr = safeArrayFromAny(json);
      const normalized = arr.map(normalizeMonster);

      const packKey = path.basename(f);
      bestiaryPacks.set(packKey, normalized);
      normalized.forEach((m, idx) => indexMonster(packKey, m, idx));

      packCount++;
      monCount += normalized.length;
    } catch (e) {
      console.warn('Bestiary load failed for', f, '-', e.message);
    }
  }

  console.log(`Bestiary loaded: ${packCount} pack(s), ${monCount} monster(s).`);
}


// ------- 2024 preference helpers (XMM/XPHB > MM/PHB) -------

function _srcPackCodes(entry) {
  const src  = String(entry?.monster?.source || entry?.monster?.raw?.source || '').toUpperCase();
  const pack = String(entry?.pack || '').toLowerCase();
  return { src, pack };
}

/** Higher score means "prefer this more". We heavily prefer 2024 (XMM/XPHB). */
function sourcePriorityScore(entry) {
  const { src, pack } = _srcPackCodes(entry);
  let s = 0;

  // Strongly prefer 2024
  if (src === 'XMM'  || src === 'XPHB') s += 100;
  if (pack.includes('xmm') || pack.includes('xphb')) s += 90;

  // Mild preference for 2014 core if nothing 2024 exists
  if (src === 'MM'   || src === 'PHB')  s += 20;
  if (pack.includes('mm')  || pack.includes('phb'))  s += 10;

  return s;
}

function pickPreferredBy2024(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.slice().sort((a, b) => {
    const pref = sourcePriorityScore(b) - sourcePriorityScore(a);
    if (pref) return pref;
    // Stable tie-breakers
    const na = a?.monster?.name || '';
    const nb = b?.monster?.name || '';
    return na.localeCompare(nb)
      || String(a.pack || '').localeCompare(String(b.pack || ''))
      || ((a.idx ?? 0) - (b.idx ?? 0));
  })[0];
}

// Ranked search that DOES NOT dedup by name — it returns every matching pack entry
function searchBestiaryRanked(query, offset = 0, limit = 10) {
  const q = normName(query);
  if (!q) return { total: 0, page: [] };

  const candidates = [];

  // bestiaryByName: Map<normalizedName, Array<{ pack, idx, monster }>>
  for (const [key, arr] of bestiaryByName.entries()) {
    if (!key.includes(q)) continue;

    for (const it of arr) {
      const mName = it?.monster?.name || '';
      const n = normName(mName);

      // match score + match category (for UI)
      let matchScore = 0;
      let category = 'contains';
      if (n === q) { matchScore = 300; category = 'exact'; }
      else if (n.startsWith(q)) { matchScore = 200; category = 'starts'; }
      else { matchScore = 100; category = 'contains'; }

      // Prefer 2024 (XMM/XPHB) strongly over 2014 (MM/PHB)
      const srcPref = sourcePriorityScore(it);

      const srcStr = String(it?.monster?.source || it?.monster?.raw?.source || '');

      candidates.push({
        name: mName,
        pack: it.pack,
        idx: it.idx,
        monster: it.monster,
        source: srcStr,
        category,
        score: matchScore + srcPref,
      });
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    a.name.localeCompare(b.name) ||
    (a.source || '').localeCompare(b.source || '') ||
    (a.pack || '').localeCompare(b.pack || '') ||
    (a.idx ?? 0) - (b.idx ?? 0)
  );

  const total = candidates.length;
  const page = candidates.slice(offset, offset + limit);
  return { total, page };
}



function getBestiaryMonster(name) {
  const q = normName(name);
  let arr = bestiaryByName.get(q) || [];
  if (arr.length) return pickPreferredBy2024(arr) || arr[0];

  // Try base form (e.g., "Oni 2" -> "Oni")
  const base = normName(baseName(name));
  arr = bestiaryByName.get(base) || [];
  return arr.length ? (pickPreferredBy2024(arr) || arr[0]) : null;
}

function getBestiaryMonsterByPackIdx(pack, idx) {
  const list = bestiaryPacks.get(pack);
  if (!list) return null;
  const m = list[idx];
  return m ? { pack, idx, monster: m } : null;
}

function formatMonsterBrief(m, withPack = true) {
  if (!m) return '_Not found_';
  const obj = m.monster || m; // normalized
  const parts = [];
  parts.push(`**${obj.name || 'Unknown'}**`);
  if (withPack) parts.push(`*Pack:* \`${path.basename(m.pack || '')}\``);
  if (obj.multiattack) parts.push(`*Multiattack:* ${obj.multiattack}`);

  const list = (label, arr) => arr && arr.length ? `**${label}:** ${arr.map(x => `“${x}”`).join(', ')}` : null;
  const a = list('Actions',   obj.actions || []);
  const b = list('Bonus',     obj.bonus || []);
  const r = list('Reactions', obj.reactions || []);
  [a,b,r].forEach(x => x && parts.push(x));
  return parts.join('\n');
}

//-----------screenshot-like statblock helpers (5etools-aware) ---------------
// --- Expand 5etools attack macros into readable text ---
function sbExpand5eInline(s) {
  let t = String(s || '');

  // 1) Expand the real 5etools tags first
  t = t.replace(/\{@atk\s+([^}]+)\}/gi, (_, code) => {
    const parts = code.toLowerCase().split(/\s*,\s*/);
    const map = {
      mw: 'Melee Weapon Attack',
      rw: 'Ranged Weapon Attack',
      ms: 'Melee Spell Attack',
      rs: 'Ranged Spell Attack',
      m:  'Melee Attack',
      r:  'Ranged Attack',
    };
    const label = parts.map(p => map[p] || p).join(' or ');
    return `${label}:`;
  });
  t = t.replace(/\{@hit\s+([+-]?\d{1,2})\}/gi, (_, n) => {
    const num = parseInt(n, 10);
    return `${num >= 0 ? `+${num}` : num} to hit`;
  });
  t = t.replace(/\{@h\}/gi, 'Hit: ');
  t = t.replace(/\{@damage\s+([^}]+)\}/gi, (_, dmg) => dmg.trim());
  t = t.replace(/\{@dc\s+(\d{1,2})\}/gi, (_, n) => `DC ${n}`);
  t = t
    .replace(/\{@spell\s+([^}|]+)(?:\|[^}]+)?}/gi, '$1')
    .replace(/\{@item\s+([^}|]+)(?:\|[^}]+)?}/gi, '$1')
    .replace(/\{@condition\s+([^}|]+)(?:\|[^}]+)?}/gi, '$1');
  // Fallback: strip any remaining {@...}
  t = t.replace(/\{@[^}]+}/g, m => m.replace(/^\{@[^ |}]+(?:\s+)?/, '').replace(/}$/, ''));

  // 2) If the {@atk ...} tag was already stripped to "m", "mw", "m,r", etc.,
  //    upgrade that shorthand to a full label when it appears at the start.
  t = t.replace(
    /^(?:[-•]\s*)?((?:mw|rw|ms|rs|m|r)(?:\s*,\s*(?:mw|rw|ms|rs|m|r))*)\s*([+\-−]?\d{1,2}\s*to hit\b)/i,
    (_, codes, tohit) => {
      const map = {
        mw: 'Melee Weapon Attack',
        rw: 'Ranged Weapon Attack',
        ms: 'Melee Spell Attack',
        rs: 'Ranged Spell Attack',
        m:  'Melee Attack',
        r:  'Ranged Attack',
      };
      const label = codes.split(/\s*,\s*/).map(c => map[c.toLowerCase()] || c).join(' or ');
      return `${label}: ${tohit}`;
    }
  );

  return t.replace(/\s+/g, ' ').trim();
}


function sbStrip(s) {
  return String(s || '')
    .replace(/\{@[^}]+}/g, m => m.replace(/^\{@[^ ]+ /, '').replace(/}$/, ''))
    .replace(/\s+/g, ' ')
    .trim();
}
function sbAbilityMod(n){ if(typeof n!=='number')return ''; const m=Math.floor((n-10)/2); return m>=0?`+${m}`:`${m}`; }
function sbFormatAC(ac){
  if(Array.isArray(ac)&&ac.length){
    const a=ac[0];
    if(typeof a==='number') return String(a);
    if(a&&typeof a==='object'){
      if(typeof a.ac==='number') return String(a.ac);
      if(Array.isArray(a.ac)) return String(a.ac[0]??'');
    }
  } else if(typeof ac==='number') return String(ac);
  return '—';
}
function sbFormatHP(hp){
  if(!hp) return '—';
  const avg = typeof hp.average==='number'?hp.average:null;
  const formula = hp.formula?` (${hp.formula})`:'';
  if(avg!==null) return `${avg}${formula}`;
  if(hp.special) return hp.special;
  return formula||'—';
}
function sbFormatSpeed(sp){
  if(!sp) return '—';
  const parts=[];
  const push=(k,val)=>{
    if(val==null) return;
    const n = typeof val==='object'&&val.number!=null?`${val.number}`:`${val}`;
    const c = typeof val==='object'&&val.condition?` ${val.condition}`:'';
    parts.push(`${k} ${n} ft.${c}`);
  };
  push('walk', sp.walk); push('burrow', sp.burrow); push('climb', sp.climb);
  push('fly', sp.fly);   push('swim', sp.swim);
  return parts.length?parts.join(', '):'—';
}
function sbFormatAbilities(raw){
  const P=[['STR',raw.str],['DEX',raw.dex],['CON',raw.con],['INT',raw.int],['WIS',raw.wis],['CHA',raw.cha]];
  return P.map(([k,v])=> typeof v==='number' ? `**${k}** ${v} (${sbAbilityMod(v)})` : `**${k}** —`).join('  ');
}
function sbFormatSaves(save){
  if(!save||typeof save!=='object') return '';
  const order=['str','dex','con','int','wis','cha'], L={str:'STR',dex:'DEX',con:'CON',int:'INT',wis:'WIS',cha:'CHA'};
  const out=[]; for(const k of order) if(save[k]) out.push(`${L[k]} ${save[k]}`);
  return out.join(', ');
}
function sbTitleCase(s){ return s.replace(/\b\w/g,c=>c.toUpperCase()); }
function sbFormatSkills(skill){
  if(!skill||typeof skill!=='object') return '';
  return Object.entries(skill).map(([k,v])=>`${sbTitleCase(k)} ${v}`).join(', ');
}
function sbFormatSenses(arr, passive){
  const list=Array.isArray(arr)?arr.slice():[];
  if(passive!=null) list.push(`Passive Perception ${passive}`);
  return list.join(', ');
}
function sbFormatLangs(l){ if(!l) return ''; return Array.isArray(l)?l.join(', '):String(l); }
function sbFormatCR(cr){ if(!cr) return ''; if(typeof cr==='string'||typeof cr==='number') return String(cr); if(cr.cr) return String(cr.cr); return ''; }
function sbExtractEntries(e){
  if (!e) return [];
  const arr = Array.isArray(e) ? e : [e];
  return arr.map(sbExpand5eInline);
}

function sbFormatNamedEntries(arr){
  if(!Array.isArray(arr)||!arr.length) return '';
  return arr.map(it=>{
    const nm=it?.name?sbStrip(it.name):'';
    const body=sbExtractEntries(it?.entries).join(' ');
    if(!nm&&!body) return '';
    return nm?`• **${nm}.** ${body}`:`• ${body}`;
  }).filter(Boolean).join('\n');
}
function sbGetMultiattackText(actions){
  if(!Array.isArray(actions)) return '';
  const m=actions.find(a=>a?.name && /^multiattack\b/i.test(a.name));
  return m? sbExtractEntries(m.entries).join(' ') : '';
}
function sbFilterOutMultiattack(actions){
  if(!Array.isArray(actions)) return [];
  return actions.filter(a=>!(a?.name && /^multiattack\b/i.test(a.name)));
}
function sbFormatSpellcastingBlocks(blocks){
  if(!Array.isArray(blocks)||!blocks.length) return '';
  const out=[];
  for(const sc of blocks){
    const name = sc?.name?sbStrip(sc.name):'Spellcasting';
    const ability = sc?.ability ? sc.ability.toString().toUpperCase() : null;
    const header = Array.isArray(sc.headerEntries)?sc.headerEntries.map(sbStrip).join(' '):'';

    const lines=[];
    const list=(label,arr)=>{ if(arr&&arr.length) lines.push(`${label}: ${arr.map(sbStrip).join(', ')}`); };

    if(sc.will) list('At will', sc.will);
    if(sc.daily){
      for(const [freq, spells] of Object.entries(sc.daily)){
        const label = freq.replace(/e$/, '/day each').replace(/(\d)/,'$1/day');
        list(label, spells);
      }
    }
    if(sc.weekly){
      for(const [freq, spells] of Object.entries(sc.weekly)){
        list(`${freq}/week each`, spells);
      }
    }
    if(sc.spells){
      for(const [lvl, obj] of Object.entries(sc.spells)){
        const slots = obj.slots!=null?` (${obj.slots} slots)`:''; 
        const spells=(obj.spells||[]).map(sbStrip).join(', ');
        if(spells) lines.push(`${lvl}${slots}: ${spells}`);
      }
    }

    const title = ability ? `**Spellcasting — ${name} (${ability})**` : `**Spellcasting — ${name}**`;
    const body  = [header, ...lines].filter(Boolean).join('\n');
    out.push(`${title}\n${body}`);
  }
  return out.join('\n\n');
}
function formatMonsterRich(m){
  const raw = m?.monster?.raw || m?.raw || m;
  if(!raw) return '_No data_';
  const title = `${raw.name || 'Unknown'} — ${raw.source || raw._source || ''}${raw.page?` p${raw.page}`:''}`.trim();

  const ac   = sbFormatAC(raw.ac);
  const hp   = sbFormatHP(raw.hp);
  const spd  = sbFormatSpeed(raw.speed);
  const abil = sbFormatAbilities(raw);

  const saves  = sbFormatSaves(raw.save);
  const skills = sbFormatSkills(raw.skill);
  const senses = sbFormatSenses(raw.senses, raw.passive);
  const langs  = sbFormatLangs(raw.languages);
  const cr     = sbFormatCR(raw.cr);

  const traits = sbFormatNamedEntries(raw.trait);
  const sc     = sbFormatSpellcastingBlocks(raw.spellcasting);

  const multi  = sbGetMultiattackText(raw.action);
  const acts   = sbFormatNamedEntries(sbFilterOutMultiattack(raw.action));
  const bonus  = sbFormatNamedEntries(raw.bonus || raw.bonusActions);
  const react  = sbFormatNamedEntries(raw.reaction || raw.reactions);

  const footer = `${raw.source || ''}${raw.page?` p${raw.page}`:''}`;

  const lines=[];
  lines.push(`**${title}**`);
  lines.push('');
  lines.push(`**AC** ${ac} • **HP** ${hp} • **Speed** ${spd}`);
  lines.push('');
  lines.push(`**Abilities**`);
  lines.push(abil);
  lines.push('');
  lines.push(`**Info**`);
  if(saves)  lines.push(`**Saves:** ${saves}`);
  if(skills) lines.push(`**Skills:** ${skills}`);
  if(senses) lines.push(`**Senses:** ${senses}`);
  if(langs)  lines.push(`**Languages:** ${langs}`);
  if(cr)     lines.push(`**CR:** ${cr}`);
  lines.push('');
  if(traits){ lines.push(`**Traits**`); lines.push(traits); lines.push(''); }
  if(sc){ lines.push(sc); lines.push(''); }
  if(multi){ lines.push(`**Multiattack**`); lines.push(multi); lines.push(''); }
  lines.push(`**Actions**`);
  lines.push(acts || '_None_');
  if(bonus){ lines.push(''); lines.push(`**Bonus Actions**`); lines.push(bonus); }
  if(react){ lines.push(''); lines.push(`**Reactions**`); lines.push(react); }
  lines.push('');
  lines.push(`_${footer}_`);
  return lines.join('\n');
}

//end of screenshot-like statblock helpers

// ---------- Rich statblock helpers (5etools-aware) ----------

function _asArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }
function _join(arr, sep=', ') { return (arr || []).filter(Boolean).join(sep); }
function _stripTags(s) { return String(s || '').replace(/\{@[^}]+}/g, '').replace(/\s+/g, ' ').trim(); }
function _firstSentence(s) {
  const t = _stripTags(s);
  const i = t.indexOf('. ');
  return i >= 0 ? t.slice(0, i + 1) : t;
}
function _abilityMod(score) {
  if (typeof score !== 'number') return '';
  const m = Math.floor((score - 10) / 2);
  return (m >= 0 ? `+${m}` : `${m}`);
}
function _fmtAbilityRow(raw) {
  const stats = ['str','dex','con','int','wis','cha'];
  return stats.map(k => {
    const v = raw?.[k];
    if (typeof v !== 'number') return `${k.toUpperCase()} —`;
    return `${k.toUpperCase()} ${v} (${_abilityMod(v)})`;
  }).join('   ');
}
function _fmtAC(raw) {
  const ac = _asArray(raw?.ac)[0];
  if (typeof ac === 'number') return String(ac);
  if (ac && typeof ac === 'object') {
    if (ac.ac) {
      const from = ac.from ? ` (${_asArray(ac.from).map(_stripTags).join(', ')})` : '';
      return `${ac.ac}${from}`;
    }
    if (ac.special) return _stripTags(ac.special);
  }
  return _asArray(raw?.ac).map(a => typeof a === 'number' ? a : (a?.ac ?? _stripTags(a?.special))).filter(Boolean).join(', ');
}
function _fmtHP(raw) {
  const hp = raw?.hp || {};
  if (hp.average && hp.formula) return `${hp.average} (${hp.formula})`;
  if (hp.average) return String(hp.average);
  if (hp.special) return _stripTags(hp.special);
  return '—';
}
function _fmtSpeed(raw) {
  const sp = raw?.speed || {};
  const parts = [];
  const order = ['walk','fly','climb','swim','burrow'];
  for (const k of order) {
    if (sp[k] == null) continue;
    if (typeof sp[k] === 'number') parts.push(`${k} ${sp[k]} ft.`);
    else if (typeof sp[k] === 'object') {
      const n = sp[k].number ?? sp[k].speed ?? sp[k].base ?? sp[k];
      const cond = sp[k].condition ? ` ${sp[k].condition}` : '';
      parts.push(`${k} ${n} ft.${cond}`);
    }
  }
  if (sp.canHover) {
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('fly ') && !/hover\)/i.test(parts[i])) parts[i] += ' (hover)';
    }
  }
  return _join(parts, ', ') || '—';
}
function _fmtSaves(raw) {
  const sv = raw?.save || {};
  const keys = Object.keys(sv);
  if (!keys.length) return null;
  return keys.map(k => `${k.toUpperCase()} ${sv[k]}`).join(', ');
}
function _fmtSkills(raw) {
  const sk = raw?.skill || {};
  const keys = Object.keys(sk);
  if (!keys.length) return null;
  return keys.map(k => `${k[0].toUpperCase()}${k.slice(1)} ${sk[k]}`).join(', ');
}
function _fmtSenses(raw) {
  const arr = _asArray(raw?.senses).map(_stripTags);
  const pp  = raw?.passive != null ? `Passive Perception ${raw.passive}` : null;
  return _join([...arr, pp].filter(Boolean), ', ') || null;
}
function _fmtLang(raw) {
  const arr = _asArray(raw?.languages).map(_stripTags);
  return _join(arr, ', ') || null;
}
function _flattenDamageList(v) {
  // entries can be ["cold"] or [{ resist:["fire","thunder"], note:"(Air only)"}]
  const flat = [];
  _asArray(v).forEach(x => {
    if (typeof x === 'string') flat.push(x);
    else if (x && typeof x === 'object') {
      const list = _asArray(x.resist || x.immune || x.vulnerable || []);
      const note = x.note ? ` ${x.note}` : (x.cond ? ' (conditional)' : '');
      flat.push(`${_join(list, ', ')}${note}`);
    }
  });
  return flat;
}
function _fmtResImm(raw) {
  const res = _flattenDamageList(raw?.resist);
  const imm = _flattenDamageList(raw?.immune);
  const vul = _flattenDamageList(raw?.vulnerable);
  return {
    res: res.length ? _join(res, ', ') : null,
    imm: imm.length ? _join(imm, ', ') : null,
    vul: vul.length ? _join(vul, ', ') : null,
  };
}
function _fmtTypeSizeAlign(raw) {
  const sizeMap = { T:'Tiny', S:'Small', M:'Medium', L:'Large', H:'Huge', G:'Gargantuan' };
  const size = _asArray(raw?.size).map(s => sizeMap[s] || s).join('/');
  const type = typeof raw?.type === 'string' ? raw.type
              : (raw?.type?.type || 'creature');
  const align = _asArray(raw?.alignment).map(a => {
    if (typeof a === 'string') return a;
    // 5etools sometimes stores codes; treat simply
    return (a?.alignment || a?.special || '').toString();
  }).join(' ');
  return { size, type, align };
}
function _fmtCR(raw) {
  const cr = raw?.cr;
  return typeof cr === 'object' ? (cr.cr ?? cr.xp ?? '') : (cr ?? '');
}
function _getEntriesText(arr, { firstSentenceOnly=false } = {}) {
  const texts = [];
  for (const it of _asArray(arr)) {
    if (!it) continue;
    const name = it.name ? `**${_stripTags(it.name)}.** ` : '';
    const bodyArr = _asArray(it.entries);
    const body = bodyArr.map(e => typeof e === 'string' ? e : (e?.entry || e?.entries || ''))
                        .flat().map(String).map(_stripTags).join(' ');
    const text = name + (firstSentenceOnly ? _firstSentence(body) : body);
    if (text.trim()) texts.push(text.trim());
  }
  return texts;
}
function _fmtInnateSpellcasting(raw) {
  const blocks = _asArray(raw?.spellcasting).filter(b => (b?.type || '').toLowerCase().includes('innate'));
  if (!blocks.length) return null;
  const out = [];
  for (const b of blocks) {
    const header = _asArray(b.headerEntries).map(_stripTags).join(' ');
    const will = _asArray(b.will).map(_stripTags);
    const daily = b.daily || {};
    const lines = [];
    if (header) lines.push(header);
    if (will.length) lines.push(`• At will: ${_join(will, ', ')}`);
    for (const k of Object.keys(daily)) {
      const label = k.replace(/e$/, '').replace(/^(\d)/, '$1/Day');
      lines.push(`• ${label}: ${_join(_asArray(daily[k]).map(_stripTags), ', ')}`);
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

/** Build a Discord embed that looks like a compact statblock. */
function buildMonsterEmbed(picked) {
  const m = picked?.monster || picked;
  const src = m.source ? `${m.source}${m.page ? ` p${m.page}` : ''}` : '';
  const title = m.name || 'Unknown Creature';

  const e = new EmbedBuilder()
    .setTitle(title + (src ? ` — ${src}` : ''))
    .setColor(0x5865F2);

  // --- Top line summary (AC / HP / Speed) ---
  const acStr = (() => {
    if (!m.ac) return '';
    if (Array.isArray(m.ac)) {
      const a0 = m.ac[0];
      if (typeof a0 === 'number') return String(a0);
      if (a0?.ac) return String(a0.ac);
    } else if (typeof m.ac === 'number') return String(m.ac);
    return '';
  })();
  const hpStr = (() => {
    if (!m.hp) return '';
    if (typeof m.hp.average === 'number') return `HP ${m.hp.average} (${m.hp.formula || ''})`.trim();
    if (typeof m.hp === 'object' && m.hp.formula) return `HP (${m.hp.formula})`;
    return '';
  })();
  const speedStr = (() => {
    const sp = m.speed || {};
    if (typeof sp === 'string') return sp;
    const parts = [];
    if (sp.walk) parts.push(`Walk ${sp.walk} ft.`);
    if (sp.fly)  parts.push(`Fly ${sp.fly.number || sp.fly} ft.${sp.fly?.condition ? ` ${sp.fly.condition}` : ''}`);
    if (sp.swim) parts.push(`Swim ${sp.swim.number || sp.swim} ft.`);
    if (sp.burrow) parts.push(`Burrow ${sp.burrow.number || sp.burrow} ft.`);
    if (sp.climb) parts.push(`Climb ${sp.climb.number || sp.climb} ft.`);
    return parts.join(', ');
  })();

  const line1 = [
    `**AC** ${acStr || '?'}`,
    hpStr ? `**${hpStr}**` : '',
    speedStr ? `**Speed** ${speedStr}` : ''
  ].filter(Boolean).join(' • ');
  e.setDescription(line1 || '\u200b');

  // --- quick stat line & misc ---
  const abilityRow = (['STR','DEX','CON','INT','WIS','CHA']
    .map(k => m[k.toLowerCase()] != null ? `${k} ${String(m[k.toLowerCase()]).padStart(2,' ')}` : null)
    .filter(Boolean)
    .join('  '));
  if (abilityRow) e.addFields({ name: 'Abilities', value: abilityRow, inline: false });

  const miscA = [];
  if (m.skill) {
    const s = Object.entries(m.skill).map(([k,v]) => `${k[0].toUpperCase()+k.slice(1)} ${v}`).join(', ');
    if (s) miscA.push(`**Skills:** ${s}`);
  }
  if (m.senses && m.senses.length) miscA.push(`**Senses:** ${m.senses.join(', ')}`);
  if (m.passive != null) miscA.push(`**Passive Perception:** ${m.passive}`);
  if (m.languages && m.languages.length) miscA.push(`**Languages:** ${m.languages.join(', ')}`);
  if (m.cr) miscA.push(`**CR:** ${typeof m.cr === 'string' ? m.cr : JSON.stringify(m.cr)}`);
  if (miscA.length) e.addFields({ name: 'Info', value: miscA.join('\n') });

  // helper to chunk long fields (Discord embed field value limit ~1024)
  const addChunked = (name, text) => {
    if (!text) return;
    const chunks = [];
    let t = String(text);
    while (t.length > 0) {
      chunks.push(t.slice(0, 1000));
      t = t.slice(1000);
    }
    chunks.forEach((c,i) => e.addFields({ name: i===0 ? name : `${name} (cont.)`, value: c }));
  };

  // --- Traits ---
  if (Array.isArray(m.traitsFull) && m.traitsFull.length) {
    const body = m.traitsFull.map(t => `**${t.name}.** ${t.text}`).join('\n');
    addChunked('Traits', body);
  }

  // --- Spellcasting (full) ---
  if (Array.isArray(m.spellcasting) && m.spellcasting.length) {
    for (const sc of m.spellcasting) {
      const headBits = [];
      if (sc.ability) headBits.push(sc.ability);
      if (sc.dc) headBits.push(`DC ${sc.dc}`);
      const header = headBits.length ? ` (${headBits.join(', ')})` : '';
      const lines = [];
      if (sc.header) lines.push(sc.header);
      for (const ln of sc.lines) lines.push(ln);
      addChunked(`Spellcasting — ${sc.name}${header}`, lines.join('\n'));
    }
  }

  // --- Actions (includes Multiattack + Change Shape etc.) ---
  if (m.multiattack) {
    addChunked('Multiattack', m.multiattack);
  }
  if (Array.isArray(m.actionsFull) && m.actionsFull.length) {
    const body = m.actionsFull.map(a => `**${a.name}.** ${a.text}`).join('\n');
    addChunked('Actions', body);
  }

  // --- Bonus Actions ---
  if (Array.isArray(m.bonusFull) && m.bonusFull.length) {
    const body = m.bonusFull.map(a => `**${a.name}.** ${a.text}`).join('\n');
    addChunked('Bonus Actions', body);
  }

  // --- Reactions ---
  if (Array.isArray(m.reactionsFull) && m.reactionsFull.length) {
    const body = m.reactionsFull.map(a => `**${a.name}.** ${a.text}`).join('\n');
    addChunked('Reactions', body);
  }

  return e;
}


//-----end 5etools rich statblock helpers----

//IMPLEMENTING ADVENTURES HANDLERS AND HELPERS
// ===== /adv scaffolding =====

const advDb = new Database(RAG_DB_PATH, { fileMustExist: true,readonly: true, timeout: 10000 });

// channel-scoped state: which adventure + node the channel is “on”
const ADV_STATE = new Map(); // channelId -> { code, advId, order }

// ---------- DB helpers ----------
function getAdventureByCodeOrTitle(q) {
  const codeExact = advDb.prepare(`SELECT * FROM adventures WHERE code = ?`).get(q);
  if (codeExact) return codeExact;
  // fuzzy by code or title
  const like = `%${q}%`;
  const row = advDb.prepare(`
    SELECT * FROM adventures
    WHERE code LIKE ? OR title LIKE ?
    ORDER BY CASE WHEN code LIKE ? THEN 0 ELSE 1 END, title ASC
    LIMIT 1
  `).get(like, like, like);
  return row || null;
}

function getFirstNode(advId) {
  return advDb.prepare(`
    SELECT * FROM adv_nodes WHERE adventure_id = ? ORDER BY order_index ASC LIMIT 1
  `).get(advId);
}

function getNodeByOrder(advId, orderIndex) {
  return advDb.prepare(`
    SELECT * FROM adv_nodes WHERE adventure_id = ? AND order_index = ?
  `).get(advId, orderIndex);
}

function getNodeByKey(advId, nodeKey) {
  return advDb.prepare(`
    SELECT * FROM adv_nodes WHERE adventure_id = ? AND node_key = ?
  `).get(advId, nodeKey);
}

function getNextNode(advId, curOrder, steps = 1) {
  // OFFSET is (steps-1) from > curOrder
  return advDb.prepare(`
    SELECT * FROM adv_nodes
    WHERE adventure_id = ? AND order_index > ?
    ORDER BY order_index ASC
    LIMIT 1 OFFSET ?
  `).get(advId, curOrder, Math.max(0, steps - 1));
}

function getPrevNode(advId, curOrder, steps = 1) {
  return advDb.prepare(`
    SELECT * FROM adv_nodes
    WHERE adventure_id = ? AND order_index < ?
    ORDER BY order_index DESC
    LIMIT 1 OFFSET ?
  `).get(advId, curOrder, Math.max(0, steps - 1));
}

function listEncounters(advId, nodeKey) {
  return advDb.prepare(`
    SELECT * FROM adv_encounters
    WHERE adventure_id = ? AND node_key = ?
    ORDER BY id ASC
  `).all(advId, nodeKey);
}

function listAssets(advId, nodeKey) {
  return advDb.prepare(`
    SELECT * FROM adv_assets
    WHERE adventure_id = ? AND node_key = ?
    ORDER BY id ASC
  `).all(advId, nodeKey);
}

function findNodes(advId, query, limit = 10) {
  const like = `%${query}%`;
  return advDb.prepare(`
    SELECT node_key, name, page, order_index,
           /* quick score: favor name matches, then gm_notes/ra length-normalized a bit */
           (CASE WHEN name LIKE ? THEN 3 ELSE 0 END)
           + (CASE WHEN gm_notes LIKE ? THEN 2 ELSE 0 END)
           + (CASE WHEN readaloud LIKE ? THEN 1 ELSE 0 END) AS score
    FROM adv_nodes
    WHERE adventure_id = ?
      AND (name LIKE ? OR gm_notes LIKE ? OR readaloud LIKE ?)
    ORDER BY score DESC, order_index ASC
    LIMIT ?
  `).all(like, like, like, advId, like, like, like, limit);
}

// ---------- formatting helpers ----------
function trunc(s, n = 1000) {
  if (!s) return '';
  const t = s.trim();
  return t.length <= n ? t : (t.slice(0, n - 1) + '…');
}

function fmtDC(dcCalls) {
  try {
    const arr = JSON.parse(dcCalls || '[]');
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // compact
    const items = arr.map(d => {
      const parts = [];
      if (d.dc != null) parts.push(`DC ${d.dc}`);
      if (d.ability) parts.push(d.ability);
      if (d.skill) parts.push(`(${d.skill})`);
      if (d.kind) parts.push(d.kind);
      return parts.join(' ');
    }).filter(Boolean);
    return items.length ? items.join('; ') : null;
  } catch { return null; }
}

function nodeEmbed(adv, node, show = 'gm', page = 0, pageCount = 1) {
  const embed = new EmbedBuilder();

  // Title
  setTitleSafe(embed, node?.name || adv?.title || 'Section');

  // Body (single description kept non-empty)
  let body = '';
  if (show === 'gm') body = node?.gm_notes || '';
  else if (show === 'ra') body = node?.readaloud || '';
  else body = [node?.readaloud, node?.gm_notes].filter(Boolean).join('\n\n');

  // Make sure description is never empty
  setDescSafe(embed, body, 'No further text in this section.');

  // If "both", also split into fields so it’s easy to scan
  if (show === 'both') {
    if (_clean(node?.readaloud)) addFieldSafe(embed, 'Read-Aloud', node.readaloud);
    if (_clean(node?.gm_notes))  addFieldSafe(embed, 'GM Notes',   node.gm_notes);
  }

  // Footer/pagination (also safe/clamped)
  const footerBits = [
    adv?.code ? `Adventure: ${adv.code}` : null,
    show ? show.toUpperCase() : null,
    Number.isFinite(pageCount) && pageCount > 0 ? `Page ${page + 1}/${pageCount}` : null,
    node?.page ? `p.${node.page}` : null,
  ].filter(Boolean);

  if (footerBits.length) {
    embed.setFooter({ text: _clamp(footerBits.join(' • '), EMBED_LIMITS.footer) });
  }

  return embed;
}

function encountersEmbed(adv, node, encs) {
  const e = new EmbedBuilder()
    .setTitle(`${adv.title} — Encounters @ ${node.name}`)
    .setDescription(encs.length ? encs.map((x, i) => {
      const mobs = (() => {
        try {
          const arr = JSON.parse(x.creatures || '[]');
          if (!Array.isArray(arr) || !arr.length) return '—';
          return arr.map(c => `${c.qty || 1}× ${c.name}`).join(', ');
        } catch { return '—'; }
      })();
      return `**${i + 1}. ${x.name || 'Encounter'}** — ${x.kind || 'encounter'}\nCreatures: ${mobs}`;
    }).join('\n\n') : '_No encounters on this node._')
    .setFooter({ text: `Node ${node.node_key} • Page ${node.page ?? '—'}` });
  return e;
}

function assetsEmbed(adv, node, assets) {
  const e = new EmbedBuilder()
    .setTitle(`${adv.title} — Assets @ ${node.name}`)
    .setDescription(assets.length ? assets.map((a, i) => {
      const safe = a.player_safe ? ' (player-safe)' : '';
      const line = [a.type || 'asset', a.title].filter(Boolean).join(': ');
      return `**${i + 1}.** ${line}${safe}${a.path ? `\nPath: \`${a.path}\`` : ''}`;
    }).join('\n\n') : '_No assets on this node._')
    .setFooter({ text: `Node ${node.node_key} • Page ${node.page ?? '—'}` });
  return e;
}

function actionRows(code, order) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`adv|nav|${code}|${order}|prev`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`adv|nav|${code}|${order}|next`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`adv|show|${code}|${order}|ra`).setLabel('📖 Read-Aloud').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`adv|show|${code}|${order}|gm`).setLabel('📝 GM Notes').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`adv|list|${code}|${order}|enc`).setLabel('👹 Encounters').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`adv|list|${code}|${order}|assets`).setLabel('🖼️ Assets').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`adv|find|${code}|${order}`).setLabel('🔎 Find in Adventure').setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

// ---------- core render/post helpers (keep buttons “durable”) ----------
async function postNodeCard(interaction, adv, node, mode = 'gm') {
  const rows = actionRows(adv.code, node.order_index);
  const embed = nodeEmbed(adv, node, mode);
  return interaction.reply({ embeds: [embed], components: rows, ephemeral: false });
}
function buildNodeComponents(adv, node, show) {
  // Prefer custom controls if you add them; otherwise use the standard rows
  if (typeof nodeControls === 'function') return nodeControls(adv, node, show);
  return actionRows(adv.code, node.order_index);
}

async function editNodeCard(interaction, adv, node, show = 'gm', opts = {}) {
  const { update = false, ephemeral = false } = opts;

  const embed = nodeEmbed(adv, node, show);
  const components = buildNodeComponents(adv, node, show);
  const payload = {
    embeds: [embed],
    components,
    ephemeral,
    allowedMentions: { parse: [] },
  };

  // Robust “did this come from a component?” check (no optional chaining)
  const cameFromComponent =
    (typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent()) ||
    (typeof interaction.isButton === 'function' && interaction.isButton()) ||
    (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu()) ||
    (typeof interaction.isChannelSelectMenu === 'function' && interaction.isChannelSelectMenu()) ||
    (typeof interaction.isUserSelectMenu === 'function' && interaction.isUserSelectMenu()) ||
    (typeof interaction.isRoleSelectMenu === 'function' && interaction.isRoleSelectMenu());

  try {
    // For component interactions, do a single update (no deferUpdate)
    if ((cameFromComponent || update) && !interaction.deferred && !interaction.replied) {
      return await interaction.update(payload);
    }

    // If a slash command deferred earlier, edit that reply
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }

    // Fresh slash command path
    return await interaction.reply(payload);
  } catch (err) {
    // Token expired / unknown interaction, fall back without crashing
    try {
      return await interaction.followUp({ ...payload, ephemeral: false });
    } catch {
      if (interaction.channel && typeof interaction.channel.send === 'function') {
        try { return await interaction.channel.send(payload); } catch {}
      }
    }
  }
}

async function appendFollowup(interaction, payload) {
  // keeps original buttons clickable; adds content below
  return interaction.followUp({ ...payload, ephemeral: false });
}

function setChannelState(channelId, { code, advId, order }) {
  ADV_STATE.set(channelId, { code, advId, order });
}
function getChannelState(channelId) {
  return ADV_STATE.get(channelId) || null;
}

// ---------- /adv command handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // Slash subcommands
    if (interaction.isChatInputCommand() && interaction.commandName === 'adv') {
      const sub = interaction.options.getSubcommand();
      // Require an active session for this channel's active party
      const activeParty = selActiveParty.get(interaction.guildId, interaction.channelId);
      const activeSess = activeParty ? selActiveSessionByParty.get(activeParty.id) : null;
      if (!activeParty || !activeSess) {
        await interaction.reply({
          content: 'No active session here. Start one with **/session start** (and ensure a party is active with **/party use**).',
          flags: EPH
        });
        return;
      }

      if (sub === 'open') {
        const q = interaction.options.getString('adventure', true);
        const adv = getAdventureByCodeOrTitle(q);
        if (!adv) return interaction.reply({ content: `No adventure found matching \`${q}\`.`, flags: EPH });

        const first = getFirstNode(adv.id);
        if (!first) return interaction.reply({ content: `Adventure \`${adv.title}\` has no nodes.`, flags: EPH });

        setChannelState(interaction.channelId, { code: adv.code, advId: adv.id, order: first.order_index });
        await interaction.deferReply();
        const rows = actionRows(adv.code, first.order_index);
        const embed = nodeEmbed(adv, first, 'gm');
        return editNodeCard(interaction, adv, first, 'gm');

      } else if (sub === 'here') {
        const st = getChannelState(interaction.channelId);
        if (!st) return interaction.reply({ content: 'No adventure is open in this channel. Use `/adv open` first.', flags: EPH });

        const adv = advDb.prepare(`SELECT * FROM adventures WHERE id = ?`).get(st.advId);
        const node = getNodeByOrder(st.advId, st.order);
        if (!node) return interaction.reply({ content: 'Current node not found (did the graph change?).', flags: EPH });

        await interaction.deferReply();
        return editNodeCard(interaction, adv, node, 'gm');

      } else if (sub === 'next' || sub === 'prev') {
        const st = getChannelState(interaction.channelId);
        if (!st) return interaction.reply({ content: 'No adventure is open here. Use `/adv open` first.', flags: EPH });
        const steps = interaction.options.getInteger('steps') || 1;
        const adv = advDb.prepare(`SELECT * FROM adventures WHERE id = ?`).get(st.advId);
        const node = (sub === 'next') ? getNextNode(st.advId, st.order, steps) : getPrevNode(st.advId, st.order, steps);
        if (!node) return interaction.reply({ content: `There is no ${sub === 'next' ? 'next' : 'previous'} node from here.`, flags: EPH });

        setChannelState(interaction.channelId, { code: adv.code, advId: adv.id, order: node.order_index });
        await interaction.deferReply();
        return editNodeCard(interaction, adv, node, 'gm');

      } else if (sub === 'goto') {
        const st = getChannelState(interaction.channelId);
        if (!st) return interaction.reply({ content: 'No adventure is open here. Use `/adv open` first.', flags: EPH });
        const adv = advDb.prepare(`SELECT * FROM adventures WHERE id = ?`).get(st.advId);

        const arg = interaction.options.getString('node', true).trim();
        let node = null;

        if (/^\d+(?:-\d+)*$/.test(arg)) {
          node = getNodeByKey(st.advId, arg);
        }
        if (!node) {
          // fallback: fuzzy by name
          node = advDb.prepare(`
            SELECT * FROM adv_nodes
            WHERE adventure_id = ?
              AND name LIKE ?
            ORDER BY LENGTH(name) ASC, order_index ASC
            LIMIT 1
          `).get(st.advId, `%${arg}%`);
        }

        if (!node) return interaction.reply({ content: `No node matching \`${arg}\` was found.`, flags: EPH });

        setChannelState(interaction.channelId, { code: adv.code, advId: adv.id, order: node.order_index });
        await interaction.deferReply();
        return editNodeCard(interaction, adv, node, 'gm');

      } else if (sub === 'find') {
        const st = getChannelState(interaction.channelId);
        if (!st) return interaction.reply({ content: 'No adventure is open here. Use `/adv open` first.', flags: EPH });
        const adv = advDb.prepare(`SELECT * FROM adventures WHERE id = ?`).get(st.advId);

        const q = interaction.options.getString('query', true);
        const limit = interaction.options.getInteger('limit') || 10;
        const rows = findNodes(st.advId, q, limit);

        if (rows.length === 0) return interaction.reply({ content: `No matches for \`${q}\` in **${adv.title}**.`, flags: EPH });

        // Make a compact list + per-result “Open” buttons (durable)
        const desc = rows.map((r, i) => {
          const page = r.page != null ? ` (p. ${r.page})` : '';
          return `**${i + 1}.** \`${r.node_key}\` — ${r.name}${page}`;
        }).join('\n');

        const row = new ActionRowBuilder().addComponents(
          ...rows.slice(0, 5).map(r =>
            new ButtonBuilder()
              .setCustomId(`adv|open|${adv.code}|${r.order_index}`)
              .setLabel(r.name.slice(0, 80))
              .setStyle(ButtonStyle.Secondary)
          )
        );

        const embed = new EmbedBuilder()
          .setTitle(`${adv.title} — Find: "${q}"`)
          .setDescription(desc);

        return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });

      } else if (sub === 'ra') {
        const st = getChannelState(interaction.channelId);
        if (!st) return interaction.reply({ content: 'No adventure is open here. Use `/adv open` first.', flags: EPH });
        const ephemeral = interaction.options.getBoolean('ephemeral') || false;
        const adv = advDb.prepare(`SELECT * FROM adventures WHERE id = ?`).get(st.advId);
        const node = getNodeByOrder(st.advId, st.order);
        if (!node) return interaction.reply({ content: 'Current node not found.', flags: EPH });

        const embed = nodeEmbed(adv, node, 'ra');
        return interaction.reply({ embeds: [embed], ephemeral });
      }
    }

    // Button interactions (durable)
    if (interaction.isButton() && interaction.customId.startsWith('adv|')) {
      const parts = interaction.customId.split('|'); // adv|type|code|order|extra?
      const [, type, code, orderStr, extra] = parts;
      const order = parseInt(orderStr, 10);
      const adv = advDb.prepare(`SELECT * FROM adventures WHERE code = ?`).get(code);
      if (!adv) return interaction.reply({ content: 'Adventure not found (code changed?).', flags: EPH });

      const node = getNodeByOrder(adv.id, order);
      if (!node) return interaction.reply({ content: 'Node not found (index changed?).', flags: EPH });

      // Keep the channel’s state in sync *if* this button came from that channel context
      setChannelState(interaction.channelId, { code: adv.code, advId: adv.id, order });

      if (type === 'nav') {
        const st = getChannelState(interaction.channelId);
        if (!st) {
          return interaction.reply({ content: 'No adventure is open here. Use `/adv open` first.', flags: EPH });
        }

        const adv = advDb.prepare(`SELECT * FROM adventures WHERE id = ?`).get(st.advId);
        const next = extra === 'next'
          ? getNextNode(adv.id, st.order, 1)
          : getPrevNode(adv.id, st.order, 1);

        if (!next) {
          return appendFollowup(interaction, { content: `No ${extra === 'next' ? 'next' : 'previous'} node.` });
        }

        setChannelState(interaction.channelId, { code: adv.code, advId: adv.id, order: next.order_index });

        // IMPORTANT: no deferUpdate — do a one-shot update
        return editNodeCard(interaction, adv, next, 'gm', { update: true });
      }


      if (type === 'show') {
        await interaction.deferUpdate();
        const mode = extra === 'ra' ? 'ra' : 'gm';
        const embed = nodeEmbed(adv, node, mode);
        return appendFollowup(interaction, { embeds: [embed] }); // append; keep original buttons alive
      }

      if (type === 'list') {
        await interaction.deferUpdate();
        if (extra === 'enc') {
          const encs = listEncounters(adv.id, node.node_key);
          const e = encountersEmbed(adv, node, encs);
          return appendFollowup(interaction, { embeds: [e] });
        } else if (extra === 'assets') {
          const assets = listAssets(adv.id, node.node_key);
          const e = assetsEmbed(adv, node, assets);
          return appendFollowup(interaction, { embeds: [e] });
        }
      }

      if (type === 'find') {
        await interaction.deferUpdate();
        const content = `Use \`/adv find query:<keywords>\` to search **${adv.title}**.`;
        return appendFollowup(interaction, { content });
      }

      if (type === 'open') {
        await interaction.deferUpdate();
        // open a specific order_index (from /adv find buttons)
        const target = getNodeByOrder(adv.id, order);
        if (!target) return appendFollowup(interaction, { content: 'Target node not found.' });
        setChannelState(interaction.channelId, { code: adv.code, advId: adv.id, order: target.order_index });
        const embed = nodeEmbed(adv, target, 'gm');
        return appendFollowup(interaction, { embeds: [embed], components: actionRows(adv.code, target.order_index) });
      }
    }
  } catch (err) {
    console.error('adv interaction error:', err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'Something went wrong in /adv.', flags: EPH }); } catch {}
    }
  }
});

//end ADVENTURES 


/* =========================
   Bestiary interactive selection sessions
========================= */
const bestiarySessions = new Map(); // key: `${channelId}:${userId}` -> { items, ts }
const BESTIARY_SESSION_TTL_MS = 2 * 60 * 1000;

function sessionKeyFor(userId, channelId) {
  return `${channelId}:${userId}`;
}
function saveBestiarySession(userId, channelId, items) {
  bestiarySessions.set(sessionKeyFor(userId, channelId), { items, ts: Date.now() });
  setTimeout(() => {
    const k = sessionKeyFor(userId, channelId);
    const s = bestiarySessions.get(k);
    if (s && Date.now() - s.ts >= BESTIARY_SESSION_TTL_MS) bestiarySessions.delete(k);
  }, BESTIARY_SESSION_TTL_MS + 500);
}
function peekBestiarySession(userId, channelId) {
  const s = bestiarySessions.get(sessionKeyFor(userId, channelId));
  if (!s) return null;
  if (Date.now() - s.ts > BESTIARY_SESSION_TTL_MS) {
    bestiarySessions.delete(sessionKeyFor(userId, channelId));
    return null;
  }
  return s.items;
}
function clearBestiarySession(userId, channelId) {
  bestiarySessions.delete(sessionKeyFor(userId, channelId));
}

// Sessions keyed by user; store query + page state
const bestiaryFindSessions = new Map(); // userId -> { key, channelId, q, page, pageSize, ts }
function makeKey() { return Math.random().toString(36).slice(2); }

function setBestiaryFindSession(userId, data, ttlMs = 3 * 60 * 1000) {
  bestiaryFindSessions.set(userId, { ...data, ts: Date.now() });
  setTimeout(() => {
    const s = bestiaryFindSessions.get(userId);
    if (s && Date.now() - s.ts >= ttlMs) bestiaryFindSessions.delete(userId);
  }, ttlMs + 1000);
}

function getBestiaryFindSession(userId) {
  const s = bestiaryFindSessions.get(userId);
  return s || null;
}

function renderFindPage(sess) {
  const q = sess.q || '';
  let page = Math.max(0, sess.page || 0);
  const pageSize = Math.max(1, sess.pageSize || 10);
  const offset = page * pageSize;

  // ranked search (non-dedup), returns { page: [], total }
  let { page: items, total } = searchBestiaryRanked(q, offset, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Clamp if we went past the end
  if (items.length === 0 && total > 0 && page > 0) {
    page = totalPages - 1;
    sess.page = page;
    const retry = searchBestiaryRanked(q, page * pageSize, pageSize);
    items = retry.page;
    total = retry.total;
  }

  const lines = items.map((it, i) => {
    const packShort = require('path').basename(it.pack || '');
    const cat = it.category === 'exact' ? 'exact'
             : it.category === 'starts' ? 'starts with'
             : 'contains';
    return `${i + 1}. **${it.name}**  —  \`${packShort}\` (${cat})`;
  });

  const header = `Results for **${q}** — page ${page + 1}/${totalPages} • ${total} match${total === 1 ? '' : 'es'}`;
  const body = lines.join('\n') || '_No results on this page._';
  const tail = '_Reply with a number or use the buttons below._';
  const content = [header, body, tail].join('\n');

  // Build components (numbered picks in rows of up to 5)
  const components = [];
  if (items.length > 0) {
    let currentRow = new ActionRowBuilder();
    for (let i = 0; i < items.length; i++) {
      const packShort = require('path').basename(items[i].pack || '');
      const btn = new ButtonBuilder()
        .setCustomId(`bestiary_pick:${packShort}:${items[i].idx}`)
        .setLabel(String(i + 1))
        .setStyle(ButtonStyle.Secondary);

      currentRow.addComponents(btn);
      if (currentRow.components.length === 5) {
        components.push(currentRow);
        currentRow = new ActionRowBuilder();
      }
    }
    if (currentRow.components.length > 0) components.push(currentRow);
  }

  // Pagination row
  if (totalPages > 1) {
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`bestiary_page:${sess.key}:prev`)
          .setLabel('Prev')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`bestiary_page:${sess.key}:next`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= totalPages - 1),
      );
    components.push(row);
  }

  return { content, components };
}

// Minimal renderer used by both /bestiary show and numeric picks
async function sendMonsterCard(channel, mon, fileLabel = '') {
  if (!mon) return;
  const fields = [];

  // Actions list (first 6 names)
  const actionNames = (mon.action || []).map(a => a.name).filter(Boolean);
  if (actionNames.length) {
    fields.push({ name: 'Actions', value: actionNames.slice(0, 6).join(', '), inline: false });
  }

  if (mon.trait?.length) {
    const traitNames = mon.trait.map(t => t.name).filter(Boolean).slice(0, 6);
    if (traitNames.length) fields.push({ name: 'Traits', value: traitNames.join(', '), inline: false });
  }

  const ac = Array.isArray(mon.ac) ? (mon.ac[0]?.ac || mon.ac[0]?.special || mon.ac[0]) : mon.ac;
  const hp = typeof mon.hp === 'object' ? (mon.hp.average ?? mon.hp.special ?? '') : mon.hp;
  const type = typeof mon.type === 'string' ? mon.type : mon.type?.type || '';
  const size = Array.isArray(mon.size) ? mon.size.join(', ') : mon.size || '';

  await channel.send({
    embeds: [{
      title: `${mon.name}${mon.source ? ` — ${mon.source}` : ''}`,
      description: [
        size && `**Size:** ${size}`,
        type && `**Type:** ${type}`,
        ac   && `**AC:** ${ac}`,
        hp   && `**HP:** ${hp}`
      ].filter(Boolean).join('\n'),
      fields,
      footer: { text: fileLabel ? `Source pack: ${fileLabel}` : '' }
    }]
  });
}



/* =========================
   Avrae command cache (for buttons)
========================= */
const avraeCmdCache = new Map(); // key -> { lines: string[], ts: number }
function putAvraeCmds(key, lines) {
  const k = String(key);
  const arr = Array.isArray(lines) ? lines : [];
  avraeCmdCache.set(k, { lines: arr, ts: Date.now() });
  setTimeout(() => avraeCmdCache.delete(k), 10 * 60 * 1000);
}
function getAvraeCmds(key) {
  const v = avraeCmdCache.get(String(key));
  return v?.lines || [];
}

/* =========================
   Prompts
========================= */
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `You are Ben's GM assistant. Be concise unless he asks for theory; then be formal and long. Address him as "Ben".`;

const GM_SYSTEM = `
You are “The GM” for a 2024 D&D 5e game (sometimes called 5.5e) running in Discord alongside Avrae.
Players use Avrae for all mechanics. You narrate, make rulings, and run monsters via Avrae commands.
When combat or rules actions are needed, answer using TWO blocks:

<NARRATION>
[A tight, evocative description and any rulings or table talk.]
</NARRATION>

<AVRAE>
[Zero or more Avrae commands, one per line. Examples:
!i attack "Claw" -t "Ben"
!i cast "Hold Person" -t "Rogue"
!i next
]
</AVRAE>

Never post Avrae commands publicly. Put every Avrae command only inside <AVRAE>, one per line, ready for a human to paste.
Do not include citations or a “Sources” section in <NARRATION>; citations are shown separately by the bot.
Obey runtime controls provided as an additional system message; they may request narration-only, inclusion of rulings, and/or emitting Avrae commands.
If you need the monster’s options, first emit “!i attack list”, then choose the most sensible attack from the returned list and execute it. Don’t ask the table what to do on a monster turn; pick and act.

If you need info, issue discovery commands first (e.g., !i attack list, !i cast list, !i status).
Prefer 2024 RAW 5e (5.5e). Be concise. Do not include anything but commands inside <AVRAE>.
If rules/notes context is provided, treat it as authoritative. If unsure, propose both rulings briefly.
`.trim();

/* =========================
   Parsing + posting GM outputs
========================= */
function parseBlocks(text) {
  const n = text.match(/<NARRATION>([\s\S]*?)<\/NARRATION>/i)?.[1]?.trim();
  const a = text.match(/<AVRAE>([\s\S]*?)<\/AVRAE>/i)?.[1]?.trim();
  const avraeLines = a ? a.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  return { narration: n, avraeLines };
}

async function postOpsButtonsAuto(label, avraeLines) {
  const opsId = GM_OPS_CHANNEL_ID;
  if (!opsId || !avraeLines?.length) return;
  const ops = await client.channels.fetch(opsId).catch(() => null);
  if (!ops || !ops.isTextBased()) return;

  const key = randomUUID();
  putAvraeCmds(key, avraeLines);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`avrae_all:${key}`).setLabel('Show all commands').setStyle(ButtonStyle.Primary),
    ...avraeLines.slice(0, 5).map((_, i) =>
      new ButtonBuilder().setCustomId(`avrae_one:${key}:${i}`).setLabel(`Show #${i + 1}`).setStyle(ButtonStyle.Secondary)
    )
  );

  console.log('Posting to ops channel:', opsId, 'lines:', avraeLines.length);
  await ops.send({
    content: `**GM Ops** — ${label || 'Auto turn commands'}\n(Click a button; result will be shown only to you.)`,
    components: [row],
  });
}

async function postGMResult(channel, modelText, ctx = null) {
  const { narration, avraeLines } = parseBlocks(modelText);

  // Public narration (skip if silentPublic)
  if (narration && !ctx?.silentPublic) {
    const chunks = narration.match(/[\s\S]{1,1900}(?=\n|$)/g) || [narration];
    for (const c of chunks) await channel.send(c);
  }

  // Slash-command flow → ephemeral buttons to invoker
  if (ctx?.interaction && avraeLines.length) {
    const ctxId = ctx.interaction.id;
    putAvraeCmds(ctxId, avraeLines);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`avrae_all:${ctxId}`).setLabel('Show all commands').setStyle(ButtonStyle.Primary),
      ...avraeLines.slice(0, 5).map((_, i) =>
        new ButtonBuilder().setCustomId(`avrae_one:${ctxId}:${i}`).setLabel(`Show #${i + 1}`).setStyle(ButtonStyle.Secondary)
      )
    );

    await ctx.interaction.followUp({
      content: `Avrae commands ready to paste (only you can see this).`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // AUTO / programmatic flow → buttons in GM-only ops channel
  if (!ctx?.interaction && avraeLines.length) {
    const label = ctx?.actor ? `Auto turn • ${ctx.actor}` : 'Auto turn';
    try {
      await postOpsButtonsAuto(label, avraeLines);
    } catch (e) {
      console.error('postOpsButtonsAuto failed:', e);
    }
  }
}

async function runGMForChannel(channel, note, { actNow = true, includeRules = false, actor = '', silentPublic = false } = {}) {
  const chId = channel.id;
  const recent = transcript.get(chId) || [];

  // Build snapshot and action memory
  const snapshot = buildCombatSnapshot(chId, actor);


  // Known moves for this actor (hydrate from DB if memory is empty)
  if (actor && getActorActions(chId, actor).actions.length === 0) {
    hydrateKnownActionsFromDB(chId, actor);
  }
  const actorMoves = actor ? getActorActions(chId, actor) : { actions: [], bonus: [], reactions: [] };
  const hasActionList = actor && actorMoves.actions.length > 0;

  const sceneQuery = [recent.slice(-10).join('\n'), note && `GM note: ${note}`].filter(Boolean).join('\n');

  // Retrieval (optional)
  let retrievedContext = [];
  try { retrievedContext = await retrieveContext(sceneQuery, { topK: RAG_TOPK }); } catch {}
  const retrieved = retrievedContext.map(x => x.formatted).join('\n\n');

  const model = chooseModelForGM({
    baseModel: DEFAULT_MODEL,
    miniModel: FAST_MODEL,
    transcriptChars: recent.join('\n').length,
    retrievedChars: retrieved.length,
    complexityHint: note,
  });

  const fallbackTarget = pickDefaultTarget(snapshot);

  const MODE_INSTRUCTIONS = `
RUNTIME CONTROLS:
- narrate_only: ${!actNow && !includeRules}
- include_rules: ${includeRules}
- act_now: ${actNow}
- actor: ${actor || '(unknown)'}
- known_actions: ${actorMoves.actions.length}
- known_bonus: ${actorMoves.bonus.length}
- known_reactions: ${actorMoves.reactions.length}
- fallback_target: ${fallbackTarget || '(none)'}

Targeting rules (hard):
- You MUST only target a name from pcs[]. Do NOT target monsters.
- If you propose a -t "Name" that is not in pcs[], replace it with "${fallbackTarget || '(none)'}".

Tactics (soft, brief):
- Prefer finishing low HP PCs (by % HP), unless a different target is overwhelmingly better (e.g., caster concentration, exposed, prone).
- If using a ranged attack while adjacent to a PC, prefer moving/Disengage or switching to a melee action to avoid disadvantage.
- Use Bonus Action only if available and tactically sensible; Reactions are off-turn only.
- If no known actions for actor: output ONLY "!i attack list" in <AVRAE> and stop.
- Never include a "Sources" section in <NARRATION>.
`.trim();

  const prompt = [
    'Recent table log (most recent last):',
    ...recent.slice(-20),
    retrieved ? '\nRules/notes context:\n' + retrieved : '',
    hasActionList ? `\nKnown moves for ${actor}:\nActions: ${actorMoves.actions.map(a => `"${a}"`).join(', ')}` : '',
    actorMoves.bonus.length ? `Bonus: ${actorMoves.bonus.map(a => `"${a}"`).join(', ')}` : '',
    actorMoves.reactions.length ? `Reactions: ${actorMoves.reactions.map(a => `"${a}"`).join(', ')}` : '',
    '\nCombat snapshot JSON (authoritative — use pcs[] names only):\n```json\n' + JSON.stringify({
      round: snapshot.round,
      actor: snapshot.actor,
      pcs: snapshot.pcs,
      monsters: snapshot.monsters,
      suggestedTargets: snapshot.suggestedTargets.map(x => x.name),
      lastTarget: snapshot.lastTarget
    }, null, 2) + '\n```',
    note ? `\nGM note: ${note}` : '',
  ].filter(Boolean).join('\n');

  if (!silentPublic) await channel.send('— GM auto —');

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: GM_SYSTEM },
      { role: 'system', content: MODE_INSTRUCTIONS },
      { role: 'user', content: prompt },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || '';

  // Validate and, if needed, patch invalid targets before posting
  const patched = sanitizeTargetsInModelText(raw, snapshot);
  if (patched.avraeTargets) setLastTarget(chId, actor, patched.avraeTargets);

  await postGMResult(channel, patched.text, { interaction: undefined, actor, silentPublic });
}

/* =========================
   Slash commands
========================= */
/* =========================
   Slash commands (single source of truth)
========================= */
const commands = [
  // ping
  new SlashCommandBuilder().setName('ping').setDescription('Pong test'),

  // ask
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the GM assistant')
    .addStringOption(o => o.setName('prompt').setDescription('Your question').setRequired(true)),

  // model
  (() => {
    const b = new SlashCommandBuilder().setName('model').setDescription('Get or set the model for this server');
    b.addSubcommand(sc => sc.setName('get').setDescription('Show the current model'));
    b.addSubcommand(sc =>
      sc.setName('set')
        .setDescription('Set the model')
        .addStringOption(o => {
          const withChoices = o.setName('name').setDescription('Model name').setRequired(true);
          ALLOWED_MODELS.forEach(m => withChoices.addChoices({ name: m, value: m }));
          return withChoices;
        })
    );
    return b;
  })(),

  // auto
  new SlashCommandBuilder()
    .setName('auto')
    .setDescription('Auto-GM controls (per channel)')
    .addSubcommand(sc => sc.setName('get').setDescription('Show Auto-GM status/mode in this channel'))
    .addSubcommand(sc =>
      sc.setName('set')
        .setDescription('Turn Auto-GM on or off in this channel')
        .addStringOption(o =>
          o.setName('state')
            .setDescription('on | off')
            .setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
        )
    )
    .addSubcommand(sc =>
      sc.setName('mode')
        .setDescription('Get or set the Auto-GM output style')
        .addStringOption(o =>
          o.setName('style')
            .setDescription('narrate_only | include_rules | act_now | act_now_rules')
            .setRequired(false)
            .addChoices(
              { name: 'narrate_only', value: 'narrate_only' },
              { name: 'include_rules', value: 'include_rules' },
              { name: 'act_now', value: 'act_now' },
              { name: 'act_now_rules', value: 'act_now_rules' }
            )
        )
    )
    .addSubcommand(sc =>
      sc.setName('silent')
        .setDescription('Silence Auto-GM on PC turns (no narration)')
        .addStringOption(o =>
          o.setName('state')
            .setDescription('on | off')
            .setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
        )
    ),

  // teach
  new SlashCommandBuilder()
    .setName('teach')
    .setDescription('Teach the GM-bot an actor’s actions from an Avrae DM paste')
    .addStringOption(o =>
      o.setName('paste').setDescription('Paste the DM text from Avrae (e.g. "Goblin Hexer1\'s Actions .")').setRequired(true)
    )
    .addStringOption(o => o.setName('actor').setDescription('Optional: actor name if it didn’t parse').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Optional: which game channel this applies to').setRequired(false)),

  // bestiary
  (() => {
    const b = new SlashCommandBuilder().setName('bestiary').setDescription('Bestiary tools');

    b.addSubcommand(sc =>
      sc.setName('find')
        .setDescription('Search monsters across local bestiary packs')
        .addStringOption(o => o.setName('query').setDescription('Name or part of a name (e.g. "oni")').setRequired(true))
    );

    b.addSubcommand(sc =>
      sc.setName('show')
        .setDescription('Show a specific monster (name, or pack.json#idx)')
        .addStringOption(o =>
          o.setName('target').setDescription('Monster name OR pack.json#idx (e.g. "bestiary-xmm.json#123")').setRequired(true)
        )
    );

    return b;
  })(),

  // adv
  (() => {
    const b = new SlashCommandBuilder().setName('adv').setDescription('Adventure navigator & tools');

    b.addSubcommand(sc =>
      sc.setName('open')
        .setDescription('Open/select an adventure by code or title')
        .addStringOption(o =>
          o.setName('adventure').setDescription('Adventure code (e.g. "adventure-wdmm") or part of its title').setRequired(true)
        )
    );

    b.addSubcommand(sc => sc.setName('here').setDescription('Show the current node (GM view)'));

    b.addSubcommand(sc =>
      sc.setName('next')
        .setDescription('Go to the next node')
        .addIntegerOption(o => o.setName('steps').setDescription('How many steps to move (default 1)').setRequired(false))
    );

    b.addSubcommand(sc =>
      sc.setName('prev')
        .setDescription('Go to the previous node')
        .addIntegerOption(o => o.setName('steps').setDescription('How many steps to move back (default 1)').setRequired(false))
    );

    b.addSubcommand(sc =>
      sc.setName('goto')
        .setDescription('Jump to a node by key (e.g. "0-3-2") or partial name')
        .addStringOption(o => o.setName('node').setDescription('Node key or name fragment').setRequired(true))
    );

    b.addSubcommand(sc =>
      sc.setName('find')
        .setDescription('Search within the current adventure')
        .addStringOption(o => o.setName('query').setDescription('Keywords to search').setRequired(true))
        .addIntegerOption(o => o.setName('limit').setDescription('Max results (default 10)').setRequired(false))
    );

    b.addSubcommand(sc =>
      sc.setName('ra')
        .setDescription('Post Read-Aloud for the current node')
        .addBooleanOption(o => o.setName('ephemeral').setDescription('Only show to you (default false)'))
    );

    return b;
  })(),

  // party
  (() => {
    const b = new SlashCommandBuilder().setName('party').setDescription('Party management');

    // new (required before optional)
    b.addSubcommand(sc =>
      sc.setName('new')
        .setDescription('Create a new party in this channel')
        .addStringOption(o => o.setName('name').setDescription('Party name').setRequired(true))
        .addStringOption(o => o.setName('adventure').setDescription('Optional adventure code'))
    );

    // use
    b.addSubcommand(sc =>
      sc.setName('use')
        .setDescription('Activate an existing party in this channel')
        .addStringOption(o => o.setName('name').setDescription('Party name').setRequired(true))
    );

    // list
    b.addSubcommand(sc => sc.setName('list').setDescription('List parties in this channel'));

    // roster
    b.addSubcommand(sc => sc.setName('roster').setDescription('Show active party roster'));

    // add
    b.addSubcommand(sc =>
      sc.setName('add')
        .setDescription('Add a character to the active party')
        .addStringOption(o => o.setName('name').setDescription('Character name').setRequired(true))
        .addUserOption(o => o.setName('player').setDescription('Discord user who owns this character').setRequired(false))
    );

    // remove
    b.addSubcommand(sc =>
      sc.setName('remove')
        .setDescription('Remove a character from the active party')
        .addStringOption(o => o.setName('name').setDescription('Character name').setRequired(true))
    );

    // update
    b.addSubcommand(sc =>
      sc.setName('update')
        .setDescription('Listen for an Avrae !vsheet to update a character')
        .addStringOption(o => o.setName('name').setDescription('Character name').setRequired(true))
    );

    // show
    b.addSubcommand(sc =>
      sc.setName('show')
        .setDescription('Show a character sheet for a party member')
        .addStringOption(o => o.setName('name').setDescription('Character name').setRequired(true))
    );

    // end
    b.addSubcommand(sc => sc.setName('end').setDescription('Archive/end the active party'));

    // ── /party stash <add|remove|show> ─────────────────────────────────────────────
    b.addSubcommandGroup(scg =>
      scg.setName('stash')
        .setDescription('Manage the party’s shared stash')
        .addSubcommand(sc =>
          sc.setName('add')
            .setDescription('Add items/currency to the party stash')
            .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
            .addNumberOption(o => o.setName('qty').setDescription('Quantity to add').setRequired(true))
            .addStringOption(o => o.setName('unit').setDescription('Unit (e.g., gp, arrows, potions)'))
            .addNumberOption(o => o.setName('gp').setDescription('GP value (optional)'))
            .addStringOption(o => o.setName('notes').setDescription('Note or source (optional)'))
        )
        .addSubcommand(sc =>
          sc.setName('remove')
            .setDescription('Remove items/currency from the party stash')
            .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
            .addNumberOption(o => o.setName('qty').setDescription('Quantity to remove').setRequired(true))
            .addStringOption(o => o.setName('unit').setDescription('Unit to target (if multiple exist)'))
        )
        .addSubcommand(sc =>
          sc.setName('show')
            .setDescription('Show everything in the party stash')
        )
    )
    return b;
  })(),

  // session
  new SlashCommandBuilder()
    .setName('session')
    .setDescription('Start or end a game session')
    .addSubcommand(sc =>
      sc.setName('start')
        .setDescription('Start a session for the active party')
        .addStringOption(o => o.setName('title').setDescription('Optional session title'))
        .addStringOption(o => o.setName('goals').setDescription('High-level goals for this session'))
        .addStringOption(o => o.setName('adv').setDescription('Override adventure code for this session'))
        .addStringOption(o => o.setName('node').setDescription('Starting node_key override'))
        .addStringOption(o =>
          o.setName('log_mode')
            .setDescription('Auto-logger mode')
            .addChoices(
              { name: 'auto', value: 'auto' },
              { name: 'auto+review', value: 'auto+review' },
              { name: 'manual', value: 'manual' }
            )
        )
        .addNumberOption(o => o.setName('conf_min').setDescription('Confidence threshold (0.0–1.0)'))
        .addChannelOption(o => o.setName('post_to').setDescription('Narration output channel'))
        .addChannelOption(o => o.setName('log_to').setDescription('Log/review channel'))
        .addStringOption(o =>
          o.setName('xp_mode')
            .setDescription('XP tracking mode')
            .addChoices({ name: 'milestone', value: 'milestone' }, { name: 'xp', value: 'xp' })
        )
        .addStringOption(o => o.setName('notes').setDescription('Private GM note'))
    )
    .addSubcommand(sc =>
      sc.setName('end')
        .setDescription('End the current session')
        .addStringOption(o => o.setName('summary').setDescription('Freeform wrap-up that augments the recap'))
        .addStringOption(o => o.setName('xp').setDescription('XP award or “milestone: …”'))
        .addStringOption(o => o.setName('inspiration').setDescription('Mentions/names to award inspiration'))
        .addStringOption(o => o.setName('loot').setDescription('Loot/treasure notes'))
        .addStringOption(o => o.setName('next_time').setDescription('What you want to do next time'))
    ),

  // gmlog
  new SlashCommandBuilder()
    .setName('gmlog')
    .setDescription('GM logging: events, notes, reputation, and stash')
    // add (fast event)
    .addSubcommand(sc =>
      sc.setName('add')
        .setDescription('Add a GM log entry')
        .addStringOption(o =>
          o.setName('category').setDescription('Category').setRequired(true).addChoices(
            { name: 'narration', value: 'narration' },
            { name: 'move', value: 'move' },
            { name: 'encounter', value: 'encounter' },
            { name: 'dc', value: 'dc' },
            { name: 'award', value: 'award' },
            { name: 'loot', value: 'loot' },
            { name: 'social', value: 'social' },
            { name: 'rule', value: 'rule' },
            { name: 'misc', value: 'misc' },
          )
        )
        .addStringOption(o => o.setName('text').setDescription('What happened?').setRequired(true))
        .addStringOption(o => o.setName('tags').setDescription('Tags (e.g. #combat #halruaa)'))
        .addStringOption(o => o.setName('adv').setDescription('Adventure code (optional)'))
        .addStringOption(o => o.setName('node').setDescription('Node key (optional)'))
        .addStringOption(o =>
          o.setName('visibility')
            .setDescription('Who can see this later?')
            .addChoices({ name: 'gm', value: 'gm' }, { name: 'players', value: 'players' }, { name: 'public', value: 'public' })
        )
    )
    // notes
    .addSubcommandGroup(g =>
      g.setName('notes')
      .setDescription('GM notes (party/session/character/location/objective)')
      .addSubcommand(sc =>
        sc.setName('add')
          .setDescription('Create a note')
          .addStringOption(o => o.setName('title').setDescription('Note title').setRequired(true))
          .addStringOption(o => o.setName('body').setDescription('Note body').setRequired(true))
          .addStringOption(o => o.setName('scope')
            .setDescription('Scope of this note')
            .addChoices(
              { name:'party', value:'party' },
              { name:'session', value:'session' },
              { name:'character', value:'character' },
              { name:'location', value:'location' },
              { name:'objective', value:'objective' },
            )
            .setRequired(false))
          .addStringOption(o => o.setName('visibility')
            .setDescription('Who can see this')
            .addChoices(
              { name:'gm', value:'gm' },
              { name:'players', value:'players' },
            )
            .setRequired(false))
          .addBooleanOption(o => o.setName('pin').setDescription('Pin this note').setRequired(false))
      )
      .addSubcommand(sc =>
        sc.setName('edit')
          .setDescription('Edit a note')
          .addIntegerOption(o => o.setName('id').setDescription('Note ID').setRequired(true))
          .addStringOption(o => o.setName('title').setDescription('New title'))
          .addStringOption(o => o.setName('body').setDescription('New body'))
          .addStringOption(o => o.setName('scope')
            .setDescription('New scope')
            .addChoices(
              { name:'party', value:'party' },
              { name:'session', value:'session' },
              { name:'character', value:'character' },
              { name:'location', value:'location' },
              { name:'objective', value:'objective' },
            ))
          .addStringOption(o => o.setName('visibility')
            .setDescription('New visibility')
            .addChoices(
              { name:'gm', value:'gm' },
              { name:'players', value:'players' },
            ))
          .addBooleanOption(o => o.setName('pin').setDescription('Pin (true) / Unpin (false)'))
      )
      .addSubcommand(sc =>
        sc.setName('pin')
          .setDescription('Pin a note')
          .addIntegerOption(o => o.setName('id').setDescription('Note ID').setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName('unpin')
          .setDescription('Unpin a note')
          .addIntegerOption(o => o.setName('id').setDescription('Note ID').setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName('show')
          .setDescription('Show a note')
          .addIntegerOption(o => o.setName('id').setDescription('Note ID').setRequired(true))
      )
      .addSubcommand(sc =>
        sc.setName('list')
          .setDescription('List recent notes')
          .addIntegerOption(o => o.setName('page').setDescription('Page (10 per page)'))
      )
      .addSubcommand(sc =>
        sc.setName('delete')
          .setDescription('Delete a note')
          .addIntegerOption(o => o.setName('id').setDescription('Note ID').setRequired(true))
      )
    )

    // In your /gmlog builder:
    .addSubcommandGroup(g =>
      g.setName('rep')
      .setDescription('Reputation with factions')
      // /gmlog rep add
      .addSubcommand(sc =>
        sc.setName('add')
          .setDescription('Adjust reputation by a delta (positive or negative)')
          .addStringOption(o => o.setName('faction').setDescription('Faction name').setRequired(true))
          .addIntegerOption(o => o.setName('amount').setDescription('Change amount (e.g., +2 or -1)').setRequired(true))
          .addStringOption(o => o.setName('trend').setDescription('Trend note (e.g., up / down / neutral)'))
          .addStringOption(o => o.setName('notes').setDescription('Short notes about why it changed'))
      )
      // /gmlog rep set
      .addSubcommand(sc =>
        sc.setName('set')
          .setDescription('Set reputation to an absolute score')
          .addStringOption(o => o.setName('faction').setDescription('Faction name').setRequired(true))
          .addIntegerOption(o => o.setName('score').setDescription('Absolute score').setRequired(true))
          .addStringOption(o => o.setName('trend').setDescription('Trend note'))
          .addStringOption(o => o.setName('notes').setDescription('Short notes'))
      )
      // /gmlog rep note
      .addSubcommand(sc =>
        sc.setName('note')
          .setDescription('Update trend/notes without changing score')
          .addStringOption(o => o.setName('faction').setDescription('Faction name').setRequired(true))
          .addStringOption(o => o.setName('trend').setDescription('Trend note'))
          .addStringOption(o => o.setName('notes').setDescription('Short notes'))
      )
      // /gmlog rep show
      .addSubcommand(sc =>
        sc.setName('show')
          .setDescription('Show reputation (all or one)')
          .addStringOption(o => o.setName('faction').setDescription('Optional: show just this faction'))
      )
    )
    // .addSubcommandGroup(...) — append to your existing gmlog registration
    .addSubcommandGroup(g =>
      g.setName('events')
      .setDescription('Log and view key story events')
      .addSubcommand(sc =>
        sc.setName('add')
          .setDescription('Add a story event')
          .addStringOption(o =>
            o.setName('type')
              .setDescription('Event type')
              .setRequired(true)
              .addChoices(
                { name:'decision',  value:'decision'  },
                { name:'clue',      value:'clue'      },
                { name:'discovery', value:'discovery' },
                { name:'combat',    value:'combat'    },
                { name:'hazard',    value:'hazard'    },
                { name:'social',    value:'social'    },
                { name:'rest',      value:'rest'      },
                { name:'travel',    value:'travel'    },
                { name:'reward',    value:'reward'    },
                { name:'defeat',    value:'defeat'    },
                { name:'milestone', value:'milestone' }
              )
          )
          .addStringOption(o => o
            .setName('text')
            .setDescription('What happened?')
            .setRequired(true))
          .addStringOption(o => o
            .setName('tags')
            .setDescription('#tags separated by spaces'))
          .addStringOption(o => o
            .setName('adv')
            .setDescription('Adventure code (optional)'))
          .addStringOption(o => o
            .setName('node')
            .setDescription('Node key (optional)'))
          .addStringOption(o => o
            .setName('visibility')
            .setDescription('Who can see this')
            .addChoices({ name:'GM-only', value:'gm' }, { name:'Players', value:'players' }))
      )
      .addSubcommand(sc =>
        sc.setName('show')
          .setDescription('Show recent events')
          .addStringOption(o => o.setName('type').setDescription('Filter by type'))
          .addIntegerOption(o => o.setName('limit').setDescription('How many (default 10)').setMinValue(1).setMaxValue(50))
      )
      .addSubcommand(sc =>
        sc.setName('search')
          .setDescription('Search events')
          .addStringOption(o => o.setName('query').setDescription('Search text').setRequired(true))
          .addStringOption(o => o.setName('type').setDescription('Filter by type'))
          .addIntegerOption(o => o.setName('limit').setDescription('How many (default 10)').setMinValue(1).setMaxValue(50))
      )
    )

    // history
    .addSubcommand(sc =>
      sc.setName('show').setDescription('Show recent GM log entries').addIntegerOption(o => o.setName('limit').setDescription('How many? (default 10)'))
    )
    .addSubcommand(sc =>
      sc.setName('search')
        .setDescription('Search GM log by text/tags')
        .addStringOption(o => o.setName('query').setDescription('Text or #tags').setRequired(true))
        .addIntegerOption(o => o.setName('limit').setDescription('How many? (default 10)'))
    ),

  // ref
  new SlashCommandBuilder()
    .setName('ref')
    .setDescription('Search rules & lore (books)')
    .addStringOption(o => o.setName('q').setDescription('Query (e.g. "Opportunity Attack", "Grappled escape")').setRequired(true))
    .addIntegerOption(o => o.setName('top').setDescription('Max results (default 30)')),

  // gm
  new SlashCommandBuilder()
    .setName('gm')
    .setDescription('GM: narrate and choose the next monster/scene action')
    .addStringOption(o => o.setName('note').setDescription('Optional note, e.g. “it is the ogre’s turn”'))
    .addBooleanOption(o => o.setName('show_sources').setDescription('Show which resource chunks were used'))
    .addBooleanOption(o => o.setName('sources_ephemeral').setDescription('Show sources only to you (default true)'))
    .addBooleanOption(o => o.setName('narrate_only').setDescription('Only narration (no rules/commands/prompts). Default: on'))
    .addBooleanOption(o => o.setName('include_rules').setDescription('Include a brief RAW rulings list in narration'))
    .addBooleanOption(o => o.setName('act_now').setDescription('Also output Avrae commands (<AVRAE>)')),
];

async function registerSlashCommandsSafe(rest, appId, guildId, commands) {
  if (process.env.SKIP_REGISTER === '1') {
    console.warn('[slash] SKIP_REGISTER=1 → skipping slash command registration.');
    return;
  }
  console.time('slash.register');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000); // 10s timeout

  try {
    await rest.put(
      Routes.applicationGuildCommands(appId, guildId),
      { body: commands, signal: ac.signal }
    );
    console.log('[slash] registration OK');
  } catch (e) {
    console.error('[slash] registration FAILED:', e?.message || e);
  } finally {
    clearTimeout(timer);
    console.timeEnd('slash.register');
  }
}

/* =========================
   Command registration
========================= */
// ---- Slash command registration (robust + guild-only) ----
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  try {
    const appId   = client.user.id;
    const guildId = process.env.GUILD_ID;

    // How many & how big (just for your logs)
    const approxBytes = Buffer.byteLength(JSON.stringify(commands), 'utf8');
    console.log(`[slash] registering ${commands.length} command(s); payload ~${approxBytes} bytes`);

    // Choose behavior via env:
    //   SLASH_REGISTER=auto  (default): only register if commands changed
    //   SLASH_REGISTER=force : force a single overwrite this run
    //   SLASH_REGISTER=skip  : skip registration entirely
    const mode = process.env.SLASH_REGISTER || 'auto';

    const result = await registerGuildSlashCommandsSafe({
      rest,
      applicationId: appId,
      guildId,
      commands,             // your built array of SlashCommandBuilder().toJSON()
      timeoutMs: 120000,    // can bump if needed
      cacheDir: '.cache',   // where the last-hash file lives
      mode,                 // 'auto' | 'force' | 'skip'
      log: console.log,
    });

    console.log('[slash] result:', result);

    console.log(`Logged in as ${client.user.tag}`);
    console.log('Registered game channels:', [...GAME_CHANNEL_IDS]);
    console.log('GM ops channel:', GM_OPS_CHANNEL_ID || '(not set)');

    // Your normal post-boot hooks
    loadBestiary();
  } catch (err) {
    console.error('Command registration failed:', err);
    // Still continue running the bot even if registration hiccups
    try { console.log(`Logged in as ${client.user.tag}`); } catch {}
  }
});


/* =========================
   Message listener (transcript + auto)
========================= */
client.on('messageCreate', async (msg) => {
  // Bestiary quick-pick: user replies with "1..n" after /bestiary find
try {
  if (msg.author.bot) return;
  const sess = getBestiaryFindSession(msg.author.id);
  if (!sess) return;
  if (sess.channelId !== msg.channel.id) return;

  const m = msg.content.trim().match(/^(\d{1,2})$/);
  if (!m) return;

  const pickIdx = parseInt(m[1], 10) - 1;
  const offset = (sess.page || 0) * (sess.pageSize || 10);
  const { page } = searchBestiaryRanked(sess.q, offset, sess.pageSize || 10);
  const item = page[pickIdx];
  if (!item) return;

  // delete the number if we have Manage Messages
  try {
    const me = msg.guild?.members?.me;
    if (me && msg.channel.permissionsFor(me).has('ManageMessages')) await msg.delete();
  } catch {}

  // Show the rich statblock in DM (or fallback in-channel)
  const picked = getBestiaryMonsterByPackIdx(item.pack, item.idx);
  if (!picked) {
    await msg.reply('Could not load that monster (pack changed?). Try `/bestiary find` again.');
    return;
  }
  const block = formatMonsterRich(picked); // <- rich formatter
  const dm = await msg.author.createDM().catch(() => null);
  if (dm) await dm.send(block);
  else await msg.reply({ content: block }); // fallback

  bestiaryFindSessions.delete(msg.author.id);
} catch (e) {
  console.error('bestiary quick-pick error:', e);
} 

  // ===== Everything below is your existing GM/Avrae flow =====
  if (!isRegisteredGameChannel(msg.channel)) return;

  const fromAvrae = isFromAvrae(msg);
  if (msg.author?.bot && !fromAvrae) return;

  const s = summarizeMessage(msg);
  if (s) pushTranscript(msg.channel.id, s);

  // Learn from any public "attack list/statblock-like" Avrae message
  if (fromAvrae) {
    const txt = msg.cleanContent || '';
    const looksList =
      /attacks?:/i.test(txt) ||
      /(melee|ranged)\s+weapon\s+attack/i.test(txt) ||
      /to hit/i.test(txt);
    if (looksList) {
      const current = extractTurnName(msg) || (autoState.get(msg.channel.id) || {}).lastTurn || '';
      const { actor: parsedActor, entries } = parseTeachPaste(txt);
      const actorGuess = parsedActor || current;
      if (actorGuess && entries.length) {
        rememberActorActions(msg.channel.id, actorGuess, entries);
        console.log('Learned from public list:', { actorGuess, entries });
      }
    }
  }

  // Keep combat state fresh from Avrae posts
  if (fromAvrae) ingestAvraeForCombat(msg);

  // Auto-GM triggers only on Avrae turn posts
  if (!fromAvrae) return;

  const chId = msg.channel.id;
  const autoOn = autoGMEnabled.has(chId) ? autoGMEnabled.get(chId) : AUTO_GM_DEFAULT;
  if (!autoOn) return;

  const turnName = extractTurnName(msg);
  console.log('Turn detector ->', turnName || '(none)');
  if (!turnName) return;

  // If we don't know PCs/monsters yet, ask for INIT list and bail
  const snapshot = buildCombatSnapshot(chId, turnName);
  const needRoster = (snapshot.pcs.length === 0 || snapshot.monsters.length === 0);

  if (needRoster) {
    const last = rosterPromptAt.get(chId) || 0;
    if (Date.now() - last > ROSTER_PROMPT_COOLDOWN_MS) {
      rosterPromptAt.set(chId, Date.now());

      // Public nudge in the game channel
      await msg.channel.send(
        `— GM setup — I need the roster before I act. Please run \`${INIT_LIST_CMD}\` in this channel so I can see PCs and monsters.`
      ).catch(() => {});
      console.log('Roster missing → prompting for INIT LIST', { chId, turnName });

      // Ops buttons for convenience
      try { await postOpsButtonsAuto('Request roster', [INIT_LIST_CMD]); } catch {}
    }
    return; // don't narrate/act yet
  }

  const st = autoState.get(chId) || { lastTurn: '', lastTs: 0 };
  if (st.lastTurn === turnName && Date.now() - st.lastTs < AUTO_COOLDOWN_MS) return;

  const { isMonster, reason } = classifyCombatant(turnName);
  console.log('Auto-GM classify:', { turnName, isMonster, reason });

  // Optional: totally silent on PC turns
  const silentPC = getSilentPcTurns(chId);
  if (!isMonster && silentPC) {
    autoState.set(chId, { lastTurn: turnName, lastTs: Date.now() });
    console.log('Auto-GM: PC turn (silent).');
    return;
  }

  // Mode → booleans (never act on PC turns)
  const mode = getAutoMode(chId);
  const base = modeToSettings(mode);
  const includeRules = base.includeRules;
  const actNow = isMonster ? base.actNow : false;

  autoState.set(chId, { lastTurn: turnName, lastTs: Date.now() });

  try {
    await runGMForChannel(msg.channel, `It's ${turnName}'s turn.`, {
      actNow,
      includeRules,
      actor: turnName, // pass actor so ops post can label it
    });
    setLastActiveGameChannel(msg.channel); // after successful trigger
  } catch (e) {
    console.error('Auto-GM error:', e);
  }
});


/* =========================
   Interactions
========================= */

//!vsheet listener for party updates (minimal ack + full persistence)
client.on('messageCreate', async (message) => {
  try {
    if (!message.guildId || !message.channelId) return;

    // Only handle likely vsheet messages
    if (!isLikelyVsheetMessage(message)) return;

    const raw = collectAvraeText(message);
    const parsed = parseVsheetText(raw);
    const parsedName = (parsed?.name || '').trim();

    // Look for pending entries for this channel
    const prefix = `${message.channelId}::`;
    const candidates = [...pendingVsheet.keys()].filter(k => k.startsWith(prefix));
    if (!candidates.length) return; // no one asked for an update here

    // Choose which pending to fulfill:
    // 1) exact char match by parsed name
    let key = null;
    if (parsedName) {
      const exact = `${prefix}${parsedName.toLowerCase()}`;
      if (pendingVsheet.has(exact)) key = exact;
    }
    // 2) if none and there’s only one pending, use it
    if (!key && candidates.length === 1) key = candidates[0];
    // 3) if none, try by author (if only one pending belongs to this author)
    if (!key) {
      const byAuthor = candidates.filter(k => pendingVsheet.get(k)?.playerId === message.author.id);
      if (byAuthor.length === 1) key = byAuthor[0];
    }
    if (!key) return; // ambiguous; ignore quietly

    const pending = pendingVsheet.get(key);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingVsheet.delete(key);
      return;
    }

    // Require a minimum parse so we don’t import the bare “!vsheet” ping
    const good =
      parsed.ac != null ||
      (parsed.hpCur != null && parsed.hpMax != null) ||
      parsed.level != null;
    if (!good) {
      // Often the first message is just "!vsheet" and the embed follows;
      // ignore weak parses and wait for the real one.
      return;
    }

    // Use the character name we armed the listener with (primary),
    // fallback to parsed name if needed.
    const charName =
      pending.characterName ||
      (parsedName && !/^!vsheet\b/i.test(parsedName) ? parsedName : null);

    if (!charName) {
      console.warn('vsheet: no char name resolved; ignoring');
      return;
    }

    // Persist to DB
    await saveParsedVsheet(message.guildId, message.channelId, charName, parsed);

    // Acknowledge
    await message.channel.send(`Updated **${charName}** from !vsheet.`);

    // Clear the pending entry
    pendingVsheet.delete(key);
  } catch (e) {
    console.error('vsheet parse/update error:', e);
  }
});



client.on('interactionCreate', async (interaction) => {
  try {
    // 1) BUTTONS: handle BEFORE chat-input guard
    // inside client.on('interactionCreate', async (interaction) => { ... })
    if (interaction.isButton()) {
      const id = interaction.customId || '';

      // small helper for long messages
      const chunk = (s, max = 1900) => {
        const out = [];
        let t = String(s || '');
        while (t.length) { out.push(t.slice(0, max)); t = t.slice(max); }
        return out;
      };

      try {
        // ---- Avrae command reveal buttons ----
        if (id.startsWith('avrae_all:') || id.startsWith('avrae_one:')) {
          if (id.startsWith('avrae_all:')) {
            const [, key] = id.split(':');
            const lines = getAvraeCmds(key) || [];
            const block = lines.length ? '```text\n' + lines.join('\n') + '\n```' : '_No commands available._';
            await interaction.reply({ content: block, flags: MessageFlags.Ephemeral });
            return;
          }
          if (id.startsWith('avrae_one:')) {
            const [, key, idxStr] = id.split(':');
            const idx = parseInt(idxStr, 10);
            const lines = getAvraeCmds(key) || [];
            const cmd = lines[idx];
            const block = cmd ? '```text\n' + cmd + '\n```' : '_No command available._';
            await interaction.reply({ content: block, flags: MessageFlags.Ephemeral });
            return;
          }
        }

        // ---- Bestiary pagination buttons: bestiary_page:<key>:(prev|next)
        if (id.startsWith('bestiary_page:')) {
          const [, key, dir] = id.split(':');
          const sess = getBestiaryFindSession(interaction.user.id);
          if (!sess || sess.key !== key) {
            await interaction.reply({ content: 'Search session expired. Run `/bestiary find` again.', flags: MessageFlags.Ephemeral });
            return;
          }
          if (dir === 'prev' && sess.page > 0) sess.page--;
          if (dir === 'next') sess.page++;

          // refresh TTL and re-render page
          setBestiaryFindSession(interaction.user.id, sess);
          const rendered = renderFindPage(sess);
          await interaction.update({ content: rendered.content, components: rendered.components });
          return;
        }

        // ---- Bestiary pick buttons: bestiary_pick:<packShort>:<idx>
        if (id.startsWith('bestiary_pick:')) {
          const [, packShort, idxStr] = id.split(':');
          const idx = Number(idxStr);

          const picked = getBestiaryMonsterByPackIdx(packShort, idx);
          if (!picked) {
            await interaction.reply({
              content: 'Monster not found (pack changed?). Try `/bestiary find` again.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // rich statblock
          const text = formatMonsterRich(picked);

          // long statblocks may need chunking
          const chunk = (s, max = 1900) => {
            const out = [];
            let t = String(s || '');
            while (t.length) { out.push(t.slice(0, max)); t = t.slice(max); }
            return out;
          };

          const parts = chunk(text);
          await interaction.reply({ content: parts[0], flags: MessageFlags.Ephemeral });
          for (let i = 1; i < parts.length; i++) {
            await interaction.followUp({ content: parts[i], flags: MessageFlags.Ephemeral });
          }
          return;
        }
        // ---- /ref pagination: ref_page:<key>:(prev|next)
        if (id.startsWith('ref_page:')) {
          const [, key, dir] = id.split(':');
          const sess = getRefSession(interaction.user.id);
          if (!sess || sess.key !== key) {
            await interaction.reply({ content: 'Search session expired. Run `/ref` again.', flags: EPH });
            return;
          }
          if (dir === 'prev' && sess.page > 0) sess.page--;
          if (dir === 'next') {
            const totalPages = Math.max(1, Math.ceil(sess.results.length / Math.max(1, sess.pageSize || 5)));
            if (sess.page < totalPages - 1) sess.page++;
          }
          // refresh TTL and re-render
          setRefSession(interaction.user.id, sess);
          const view = renderRefPage(sess);
          await interaction.update({ content: view.content, components: view.components });
          return;
        }

        // ---- /ref open a result: ref_open:<key>:<globalIndex>
        if (id.startsWith('ref_open:')) {
          const [, key, idxStr] = id.split(':');
          const sess = getRefSession(interaction.user.id);
          if (!sess || sess.key !== key) {
            await interaction.reply({ content: 'Search session expired. Run `/ref` again.', flags: EPH });
            return;
          }
          const gi = parseInt(idxStr, 10);
          const hit = sess.results[gi];
          if (!hit) {
            await interaction.reply({ content: 'That result is no longer available.', flags: EPH });
            return;
          }

          // Pull the chunk + a bit of context (±1)
          const parsed = parseBookNs(hit.path);
          let body = hit.text || '';
          if (parsed) {
            const span = 1; // number of neighbor chunks on each side
            const rows = getDocRange(parsed.ns, Math.max(0, parsed.zeroIndex - span), parsed.zeroIndex + span);
            if (rows?.length) {
              body = rows.map(r => r.text).join('\n\n');
            }
          }

          // Chunk to stay under Discord limits
          const parts = [];
          let t = `**${hit.path}**  (sim ${hit.score.toFixed(3)})\n\n${body}`.replace(/\s+\n/g, '\n');
          while (t.length) { parts.push(t.slice(0, 1900)); t = t.slice(1900); }

          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({ content: parts[0], flags: EPH });
            for (let i = 1; i < parts.length; i++) await interaction.followUp({ content: parts[i], flags: EPH });
          } else {
            await interaction.followUp({ content: parts[0], flags: EPH });
            for (let i = 1; i < parts.length; i++) await interaction.followUp({ content: parts[i], flags: EPH });
          }
          return;
        }
        // ---- /ask source expansion buttons: asksrc:<key>:<idx> ----
        if (id.startsWith('asksrc:')) {
          const [, key, idxStr] = id.split(':');
          const sess = getAskSrcSession(key);
          if (!sess) {
            await interaction.reply({ content: 'Source context expired. Re-run `/ask`.', flags: EPH });
            return;
          }

          const which = parseInt(idxStr, 10);
          const item = sess.items[which];
          if (!item) {
            await interaction.deferUpdate().catch(() => {});
            return;
          }

          // Expand with neighbor chunks for context; fall back to the single chunk if needed
          const expanded = expandDocWithNeighbors(item.path, item.idx, 1) || item.text || '(no text)';
          const header = `**${item.path}** (chunk ${item.idx}${boost2024ForPath(item.path) > 0 ? ' • 2024' : ''})`;

          // Keep the original message/buttons intact -> acknowledge then append a new message
          try { await interaction.deferUpdate(); } catch {}

          // chunk long payload into safe 1900-char blocks
          const chunks = [];
          let t = String(expanded);
          while (t.length) { chunks.push(t.slice(0, 1800)); t = t.slice(1800); }

          await interaction.followUp({ content: header });
          for (const c of chunks) {
            await interaction.followUp({ content: '```text\n' + c + '\n```' });
          }

          // refresh TTL
          sess.ts = Date.now();
          return;
        }

        // Unknown button type — safely ignore
        await interaction.deferUpdate().catch(() => {});
        return;
      } catch (e) {
        console.error('Button handler error:', e);
        try {
          // Acknowledge so Discord doesn’t show “This interaction failed”
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Button failed. Try again.', flags: MessageFlags.Ephemeral });
          } else if (interaction.deferred && !interaction.replied) {
            await interaction.followUp({ content: 'Button failed. Try again.', flags: MessageFlags.Ephemeral });
          }
        } catch {}
      }

      return; // buttons handled
    }

    // 2) SLASH COMMANDS
    if (!interaction.isChatInputCommand()) return;

    if (interaction.isChatInputCommand() && interaction.commandName === 'session') {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const channelId = interaction.channelId;

      if (sub === 'start') {
        // Must have an active party selected in this channel
        const party = requireActiveParty(guildId, channelId);
        if (!party) {
          await interaction.reply({
            content: 'No active party in this channel. Use **/party use** (or **/party new**) first.',
            flags: EPH
          });
          return;
        }

        // No overlapping sessions for this party
        const already = selActiveSessionByParty.get(party.id);
        if (already) {
          await interaction.reply({
            content: `There is already an active session: **${already.title || ('Session ' + already.id)}**. End it with **/session end**.`,
            flags: EPH
          });
          return;
        }

        const title       = interaction.options.getString('title') || `Session ${new Date().toISOString().slice(0,10)}`;
        const goals       = interaction.options.getString('goals') || null;
        const adv_code    = interaction.options.getString('adv') || party.adventure_code || null;
        const node_key    = interaction.options.getString('node') || party.current_node_key || null;
        const log_mode    = interaction.options.getString('log_mode') || 'auto+review';
        const conf_min    = interaction.options.getNumber('conf_min') ?? 0.7;
        const postCh      = interaction.options.getChannel('post_to') || null;
        const logCh       = interaction.options.getChannel('log_to') || null;
        const xp_mode     = interaction.options.getString('xp_mode') || null;
        const notes       = interaction.options.getString('notes') || null;

        // Seed participants from current roster
        const roster = listMembersByParty.all(guildId, channelId, party.id)
          .map(m => ({ character_name: m.character_name, player_user: m.player_user || null }));
        const participants_json = JSON.stringify(roster);

        // Permission fields (we’ll leave most null for now)
        const created_by = interaction.user.id;

        partyDb.exec('BEGIN IMMEDIATE');
        try {
          insertSession.run(
            party.id, guildId, channelId,
            title, adv_code, node_key, goals, notes, log_mode, conf_min,
            postCh ? postCh.id : null, logCh ? logCh.id : null, xp_mode,
            interaction.user.id, participants_json,
            created_by, null, null, null, null, null, 'public'
          );

          // Optionally pin current session on the party
          const newly = selActiveSessionByParty.get(party.id);
          if (newly) setPartyCurrentSession.run(newly.id, party.id);

          partyDb.exec('COMMIT');
        } catch (e) {
          partyDb.exec('ROLLBACK');
          console.error('session start error:', e);
          await interaction.reply({ content: 'Could not start session (DB error).', flags: EPH });
          return;
        }

        const embed = {
          color: 0x2b6cb0,
          title: `Session started — ${title}`,
          fields: [
            { name: 'Party', value: party.name, inline: true },
            { name: 'Goals', value: goals || '—', inline: true },
            { name: 'Adventure', value: adv_code || '—', inline: true },
            { name: 'Start Node', value: node_key || '—', inline: true },
            { name: 'Logger', value: `${log_mode} (≥ ${conf_min})`, inline: true },
            { name: 'XP Mode', value: xp_mode || '—', inline: true },
          ],
          footer: { text: `Started by ${interaction.user.username}` }
        };

        await interaction.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'end') {
        const party = requireActiveParty(guildId, channelId);
        if (!party) {
          await interaction.reply({ content: 'No active party in this channel.', flags: EPH });
          return;
        }
        const sess = selActiveSessionByParty.get(party.id);
        if (!sess) {
          await interaction.reply({ content: 'No active session to end. Use **/session start** first.', flags: EPH });
          return;
        }

        const summary     = interaction.options.getString('summary') || '';
        const xp          = interaction.options.getString('xp') || '';
        const insp        = interaction.options.getString('inspiration') || '';
        const loot        = interaction.options.getString('loot') || '';
        const nextTime    = interaction.options.getString('next_time') || '';
        const exportWhere = interaction.options.getString('export') || 'thread';
        const closeAdv    = interaction.options.getBoolean('close_adv') || false;

        // Tiny recap for now (auto-logger will augment later)
        const recap = [
          `**Session:** ${sess.title || ('Session ' + sess.id)}`,
          sess.goals ? `**Goals:** ${sess.goals}` : null,
          summary ? `**Summary:** ${summary}` : null,
          xp ? `**XP:** ${xp}` : null,
          insp ? `**Inspiration:** ${insp}` : null,
          loot ? `**Loot:** ${loot}` : null,
          nextTime ? `**Next Time:** ${nextTime}` : null,
        ].filter(Boolean).join('\n');

        partyDb.exec('BEGIN IMMEDIATE');
        try {
          endSessionById.run(interaction.user.id, recap, sess.id);
          if (closeAdv) {
            partyDb.prepare(`UPDATE parties SET adventure_code=NULL, current_node_key=NULL WHERE id=?`).run(party.id);
          }
          setPartyCurrentSession.run(null, party.id); // unpin current session
          partyDb.exec('COMMIT');
        } catch (e) {
          partyDb.exec('ROLLBACK');
          console.error('session end error:', e);
          await interaction.reply({ content: 'Could not end session (DB error).', flags: EPH });
          return;
        }

        // Post recap as requested
        if (exportWhere === 'thread') {
          try {
            const thread = await interaction.channel.threads.create({
              name: `${sess.title || ('Session ' + sess.id)} — Recap`,
              autoArchiveDuration: 1440,
              reason: 'Session recap'
            });
            await thread.send(recap || 'Session ended.');
          } catch (e) {
            console.warn('Could not create recap thread:', e.message);
            await interaction.reply({ content: 'Session ended. (Couldn’t create recap thread; check channel perms.)', flags: EPH });
            return;
          }
        } else if (exportWhere === 'file') {
          const buf = Buffer.from(recap || 'Session ended.', 'utf8');
          await interaction.channel.send({ files: [{ attachment: buf, name: 'session_recap.txt' }] });
        }

        await interaction.reply({ content: `Ended **${sess.title || ('Session ' + sess.id)}**.`, flags: EPH });
        return;
      }
    }

    // /gmlog handler — group-first routing so /gmlog rep add doesn't hit generic "add"
    if (interaction.isChatInputCommand() && interaction.commandName === 'gmlog') {
      try {
        const group    = interaction.options.getSubcommandGroup(false); // 'rep' | null
        const sub      = interaction.options.getSubcommand();           // 'add' | 'set' | 'note' | 'show' | ...
        const guildId  = interaction.guildId;
        const channelId= interaction.channelId;
        const userId   = interaction.user.id;

        // Ensure an active party; most logs are party-scoped
        const party   = ensureActiveParty(guildId, channelId, 'Party');
        const partyId = party?.id || null;

        // Active session (nullable)
        const sessionId = getActiveSessionIdSafe(guildId, channelId);
        // ---------- EVENTS group ----------
        if (group === 'events') {
          const action    = interaction.options.getSubcommand();
          const now       = Date.now();
          const party     = ensureActiveParty(guildId, channelId, 'Party');
          const partyId   = party?.id || null;
          const sessionId = getActiveSessionIdSafe(guildId, channelId);

          if (sub === 'add') {
            const type = interaction.options.getString('type', true);
            const text = interaction.options.getString('text', true);
            const tags = normTags(interaction.options.getString('tags') || '');
            const adv  = interaction.options.getString('adv')  || null;
            const node = interaction.options.getString('node') || null;
            const vis  = interaction.options.getString('visibility') || 'gm';

            const category = `event:${type}`;

            insGmLog.run(
              guildId, channelId, partyId, sessionId,
              category, text, tags, adv, node,
              vis, null, null,
              userId, now
            );

            await interaction.reply({
              content: `Logged **${type}**: ${text}${tags ? ` ${tags}` : ''}` +
                      (adv ? ` _(adv:${adv}${node ? `/${node}` : ''})_` : ''),
              flags: EPH
            });
            return;
          }

          if (sub === 'show') {
            const typeOpt = interaction.options.getString('type') || null;
            const limit   = Math.max(1, Math.min(50, interaction.options.getInteger('limit') ?? 10));
            const offset  = 0;

            const rows = typeOpt
              ? listEventsByType.all(guildId, channelId, partyId, `event:${typeOpt}`, limit, offset)
              : listEventsAny.all(guildId, channelId, partyId, limit, offset);

            if (!rows.length) {
              await interaction.reply({ content: 'No events logged yet.', flags: EPH });
              return;
            }

            const lines = rows.map(r => {
              const t = r.category.replace(/^event:/, '');
              const ref = (r.adv ? ` _(adv:${r.adv}${r.node ? `/${r.node}` : ''})_` : '');
              const tag = r.tags ? ` ${r.tags}` : '';
              return `• [event/${t}] ${r.content}${tag} — ${fmtTime(r.created_at)}${ref}`;
            });

            await interaction.reply({
              content: `**Events${typeOpt ? ` — ${typeOpt}` : ''}**\n` + lines.join('\n'),
              flags: EPH
            });
            return;
          }

          if (sub === 'search') {
              const q      = interaction.options.getString('query', true);
              const typeOp = interaction.options.getString('type') || null;
              const limit  = Math.max(1, Math.min(50, interaction.options.getInteger('limit') ?? 10));
              const offset = 0;
              const like   = `%${q}%`;

              let rows = [];

              if (typeOp) {
                // If user specified a type, keep the old behavior (search within that type by text/tags)
                rows = searchEventsByType.all(guildId, channelId, partyId, `event:${typeOp}`, like, like, limit, offset);
              } else {
                // New behavior: search BOTH text/tags and type-partials
                const byText = searchEventsAny.all(guildId, channelId, partyId, like, like, limit, offset);
                const byType = searchEventsByCategoryLike.all(guildId, channelId, partyId, `event:%${q}%`, limit, offset);

                // Merge + de-dup (no id selected here, so use a composite key)
                const seen = new Set();
                const merged = [];
                for (const r of [...byType, ...byText]) {
                  const key = `${r.category}|${r.content}|${r.created_at}`;
                  if (!seen.has(key)) { seen.add(key); merged.push(r); }
                }
                rows = merged.slice(0, limit);
              }

              if (!rows.length) {
                await interaction.reply({ content: `No event matches for \`${q}\`.`, flags: EPH });
                return;
              }

              const lines = rows.map(r => {
                const t = r.category.replace(/^event:/, '');
                const ref = (r.adv ? ` _(adv:${r.adv}${r.node ? `/${r.node}` : ''})_` : '');
                const tag = r.tags ? ` ${r.tags}` : '';
                return `• [event/${t}] ${r.content}${tag} — ${fmtTime(r.created_at)}${ref}`;
              });

              await interaction.reply({
                content: `**Event search** for \`${q}\`${typeOp ? ` in ${typeOp}` : ''}:\n` + lines.join('\n'),
                flags: EPH
              });
              return;
          }
        }

        // ---------- REP group ----------
        if (group === 'rep') {
          const sessionId = getActiveSessionIdSafe(guildId, channelId);
          const now      = Date.now();

          // Helper: fetch current row (case-insensitive) or null
          const getCurrent = (faction) => getRepOneCI.get(guildId, channelId, partyId, faction);

          if (sub === 'add' || sub === 'set') {
            // faction is REQUIRED for add/set
            const faction = interaction.options.getString('faction', true).trim();
            const amount  = interaction.options.getInteger('amount', true);
            const trend   = interaction.options.getString('trend') || null;
            const notesIn = interaction.options.getString('notes') || null;

            const existing     = getCurrent(faction);
            const currentScore = existing ? (existing.score | 0) : 0;
            const newScore     = (sub === 'set') ? amount : (currentScore + amount);

            // If notes provided, append to any existing notes; otherwise carry them forward unchanged
            const combinedNotes = notesIn
              ? (existing?.notes ? (existing.notes.endsWith('\n') ? existing.notes + notesIn : `${existing.notes}\n${notesIn}`) : notesIn)
              : (existing?.notes ?? null);

            // Persist reputation
            upsertReputation.run(
              guildId, channelId, partyId,
              faction, newScore, (trend ?? existing?.trend ?? null), combinedNotes,
              'players', null, null,
              userId, now
            );

            // Log to gm_logs for history/audit
            insGmLog.run(
              guildId, channelId, partyId, sessionId,
              `rep:${action}`,
              `${faction} => ${newScore}${trend ? ` (${trend})` : ''}${notesIn ? ` — ${notesIn}` : ''}`,
              normTags(`#${faction}`), null, null,
              'gm', null, null,
              userId, now
            );

            await interaction.reply({
              content: `Reputation with **${faction}** is now **${newScore}**` + (trend ? ` (_${trend}_)` : ''),
              flags: EPH
            });
            return;
          }

          if (sub === 'note') {
            // NOTE: your registration uses the option name 'notes' (required)
            const faction  = interaction.options.getString('faction', true).trim();
            const noteText = interaction.options.getString('notes', true).trim();
            const trend    = interaction.options.getString('trend') || null;

            const existing     = getCurrent(faction);
            const currentScore = existing ? (existing.score | 0) : 0;

            // Append new note to existing (if any)
            const mergedNotes = existing?.notes
              ? (existing.notes.endsWith('\n') ? existing.notes + noteText : `${existing.notes}\n${noteText}`)
              : noteText;

            upsertReputation.run(
              guildId, channelId, partyId,
              faction, currentScore, (trend ?? existing?.trend ?? null), mergedNotes,
              'players', null, null,
              userId, now
            );

            // Log it
            insGmLog.run(
              guildId, channelId, partyId, sessionId,
              'rep:note', noteText,
              normTags(`#${faction}`), null, null,
              'gm', null, null,
              userId, now
            );

            await interaction.reply({
              content: `Noted **${faction}**: ${noteText}` + (trend ? ` (_${trend}_)` : ''),
              flags: EPH
            });
            return;
          }

          if (sub === 'show') {
            // faction is OPTIONAL; support partials like "harp" or "har per s"
            const qRaw   = interaction.options.getString('faction') || '';
            const tokens = canonFaction(qRaw).split(' ').filter(Boolean);

            let rows = listReps.all(guildId, channelId, partyId);

            if (tokens.length) {
              rows = rows.filter(r => {
                const f = canonFaction(r.faction);
                return tokens.every(tok => f.includes(tok));
              });
            }

            if (!rows.length) {
              await interaction.reply({
                content: tokens.length
                  ? `No reputation rows matching **${qRaw}**.`
                  : 'No reputations recorded yet.',
                flags: EPH
              });
              return;
            }

            rows.sort((a, b) =>
              a.faction.localeCompare(b.faction, undefined, { sensitivity: 'base' })
            );

            const lines = rows.map(r =>
              `• **${r.faction}**: ${r.score}` +
              (r.trend ? ` (_${r.trend}_)` : '') +
              (r.notes ? ` — ${r.notes}` : '')
            );

            await interaction.reply({
              content: (tokens.length ? `**Reputation — results for “${qRaw}”**` : '**Reputation**') + `\n` + lines.join('\n'),
              flags: EPH
            });
            return;
          }
        }


        if (group === 'notes') {
          const sessionRow = selActiveSessionId.get(guildId, channelId, partyId) || null;
          const sessId = sessionRow?.id || sessionId || null;

          if (sub === 'add') {
            const title = interaction.options.getString('title', true).trim();
            const body  = interaction.options.getString('body',  true).trim();
            const scope = interaction.options.getString('scope') || 'party';
            const visibility = interaction.options.getString('visibility') || 'gm';
            const pin   = interaction.options.getBoolean('pin') ? 1 : 0;
            const ts    = nowMs();

            insNote.run(
              guildId, channelId, partyId, sessId,
              scope, title, body, pin, visibility,
              null, null,                 // allow_roles, allow_users (future permissions)
              userId, ts, userId, ts
            );

            const newId = partyDb.prepare('SELECT last_insert_rowid() AS id').get().id;
            await interaction.reply({
              content: `📝 Note **#${newId}** added${pin ? ' and pinned' : ''} (${scope}, ${visibility}).`,
              flags: EPH
            });
            return;
          }

          if (sub === 'edit') {
            const id    = interaction.options.getInteger('id', true);
            const row   = getNote.get(id, guildId, channelId, partyId);
            if (!row) { await interaction.reply({ content: `Note #${id} not found for this party.`, flags: EPH }); return; }

            const newTitle = interaction.options.getString('title');
            const newBody  = interaction.options.getString('body');
            const newScope = interaction.options.getString('scope');
            const newVis   = interaction.options.getString('visibility');
            const pinOpt   = interaction.options.getBoolean('pin');

            const scope = (newScope || row.scope).trim();
            const title = (newTitle ?? row.title).trim();
            const body  = (newBody  ?? row.body).trim();
            const vis   = (newVis   || row.visibility).trim();

            updNote.run(scope, title, body, vis, userId, nowMs(), id, guildId, channelId, partyId);

            if (typeof pinOpt === 'boolean') {
              setNotePinned.run(pinOpt ? 1 : 0, userId, nowMs(), id, guildId, channelId, partyId);
            }

            await interaction.reply({ content: `✏️ Note #${id} updated.`, flags: EPH });
            return;
          }

          if (sub === 'pin' || sub === 'unpin') {
            const id  = interaction.options.getInteger('id', true);
            const row = getNote.get(id, guildId, channelId, partyId);
            if (!row) { await interaction.reply({ content: `Note #${id} not found.`, flags: EPH }); return; }

            const want = sub === 'pin' ? 1 : 0;
            setNotePinned.run(want, userId, nowMs(), id, guildId, channelId, partyId);

            await interaction.reply({ content: `${want ? '📌 Pinned' : '📍 Unpinned'} note #${id}.`, flags: EPH });
            return;
          }

          if (sub === 'show') {
            const id  = interaction.options.getInteger('id', true);
            const row = getNote.get(id, guildId, channelId, partyId);
            if (!row) { await interaction.reply({ content: `Note #${id} not found.`, flags: EPH }); return; }

            const embed = {
              color: row.pinned ? 0xf6ad55 : 0x3182ce,
              title: `#${row.id} — ${row.title}`,
              description: row.body,
              fields: [
                { name: 'Scope', value: row.scope || 'party', inline: true },
                { name: 'Visibility', value: row.visibility || 'gm', inline: true },
                ...(row.session_id ? [{ name: 'Session', value: String(row.session_id), inline: true }] : []),
              ],
              footer: { text: `Updated ${new Date(row.updated_at).toLocaleString()}` }
            };
            await interaction.reply({ embeds: [embed], flags: EPH });
            return;
          }

          if (sub === 'list') {
            const page = Math.max(1, interaction.options.getInteger('page') || 1);
            const PAGE = 10;
            const offset = (page - 1) * PAGE;

            const total = countNotesStmt.get(guildId, channelId, partyId).c;
            const rows  = listNotesStmt.all(guildId, channelId, partyId, PAGE, offset);

            if (!rows.length) {
              await interaction.reply({ content: 'No notes yet.', flags: EPH });
              return;
            }

            const lines = rows.map(r =>
              `**#${r.id}** ${r.pinned ? '📌 ' : ''}${r.title} — _${r.scope}_${r.visibility === 'players' ? ' (players)' : ''} — ${new Date(r.updated_at).toLocaleString()}`
            );

            await interaction.reply({
              content: `Notes (page ${page}/${Math.max(1, Math.ceil(total / PAGE))}):\n${lines.join('\n')}`,
              flags: EPH
            });
            return;
          }

          if (sub === 'delete') {
            const id  = interaction.options.getInteger('id', true);
            const row = getNote.get(id, guildId, channelId, partyId);
            if (!row) { await interaction.reply({ content: `Note #${id} not found.`, flags: EPH }); return; }

            delNote.run(id, guildId, channelId, partyId);
            await interaction.reply({ content: `🗑️ Deleted note #${id}.`, flags: EPH });
            return;
          }
        }

        // ---------- NON-group subcommands (existing) ----------
        // /gmlog add
        if (sub === 'add') {
            const category = interaction.options.getString('category', true);
            const text     = interaction.options.getString('text', true);
            const tagsRaw  = interaction.options.getString('tags') || '';
            const adv      = interaction.options.getString('adv')  || null;
            const node     = interaction.options.getString('node') || null;
            const vis      = interaction.options.getString('visibility') || 'gm';

            insGmLog.run(
                guildId, channelId, partyId, sessionId,
                category, text, normTags(tagsRaw), adv, node,
                vis, null, null, userId, nowMs()
            );

            await interaction.reply({
                content: `Logged **${category}**: ${text}${tagsRaw ? ` ${normTags(tagsRaw)}` : ''}`,
                flags: EPH
            });
            return;
        }
        // /gmlog show
        if (sub === 'show') {
          const limit = Math.max(1, Math.min(50, interaction.options.getInteger('limit') ?? 10));
          const rows = listRecentLogs.all(guildId, channelId, partyId, limit, 0);
          if (!rows.length) {
            await interaction.reply({ content:'No GM log entries yet.', flags: EPH });
            return;
          }
          const out = rows.map(r => `• [${r.category}] ${r.content}${r.tags ? ' ' + r.tags : ''} — ${fmtTime(r.created_at)}`);
          await interaction.reply({ content: out.join('\n'), flags: EPH });
          return;
        }

        // /gmlog search
        if (sub === 'search') {
          const q = interaction.options.getString('query', true);
          const like = `%${q}%`;
          const limit = Math.max(1, Math.min(50, interaction.options.getInteger('limit') ?? 10));
          const offset = 0;

          // include unscoped logs (party_id NULL) and party-scoped logs; notes are party-scoped
          const logs  = searchLogs.all(guildId, channelId, partyId, like, like, limit, offset);
          const notes = searchNotes.all(guildId, channelId, partyId, like, like, limit, offset);

          const rows = [...logs, ...notes].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

          if (!rows.length) {
            await interaction.reply({ content: `No matches for \`${q}\`.`, flags: EPH });
            return;
          }

          const out = rows.map(r => {
            if (r.kind === 'log') {
              const tagStr = r.tags ? ` ${r.tags}` : '';
              return `• [log/${r.category}] ${r.content}${tagStr} — ${fmtTime(r.created_at)}`;
            } else {
              // note
              return `• [note] **${r.title}** — ${snippet(r.body)} — ${fmtTime(r.created_at)}`;
            }
          });

          await interaction.reply({ content: out.join('\n'), flags: EPH });
          return;
        }

      } catch (e) {
        console.error('gmlog error:', e);
        await interaction.reply({ content: `Sorry, /gmlog failed: ${e.message}`, flags: EPH }).catch(() => {});
      }
    }

    // --- /party command handler ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'party') {
      const group     = interaction.options.getSubcommandGroup(false); // e.g. 'stash' or null
      const sub       = interaction.options.getSubcommand();           // e.g. 'add' | 'show' | ...
      const guildId   = interaction.guildId;
      const channelId = interaction.channelId;

      // helper: consistent key for "waiting for !vsheet" state
      const makeKey = (chId, name) => `${chId}::${(name || '').toLowerCase().trim()}`;

      // ───────────────────────────────────────────────────────────
      // Handle GROUPED subs first: /party stash <add|remove|show>
      // ───────────────────────────────────────────────────────────
      if (group === 'stash') {
        const partyRow = ensureActiveParty(guildId, channelId, 'Party');
        const partyId  = partyRow?.id || null;

        if (sub === 'show') {
          const rows = listStashByParty.all(guildId, channelId, partyId);
          if (!rows.length) {
            await interaction.reply({ content: 'Party stash is empty.', flags: EPH });
            return;
          }
          const lines = rows.map(r => {
            const qtyStr = (r.qty % 1 === 0) ? String(r.qty) : String(r.qty);
            const unit   = r.unit ? ` ${r.unit}` : ' (no unit)';
            const gp     = (r.gp_value != null) ? ` — ${r.gp_value} gp` : '';
            const note   = r.notes ? ` — ${r.notes}` : '';
            return `• **${r.item}**: ${qtyStr}${unit}${gp}${note}`;
          });
          await interaction.reply({ content: `**Party Stash**\n${lines.join('\n')}`, flags: EPH });
          return;
        }

        // /party stash add
        if (sub === 'add') {
          const itemIn = interaction.options.getString('item', true);
          const qtyIn  = interaction.options.getNumber('qty', true);
          const unitIn = interaction.options.getString('unit') || '';
          const gpVal  = interaction.options.getNumber('gp') ?? null;
          const notes  = interaction.options.getString('notes') || null;

          const qty = Number(qtyIn);
          if (!Number.isFinite(qty) || qty <= 0) {
            await interaction.reply({ content: 'Quantity must be a positive number.', flags: EPH });
            return;
          }

          let item = normItem(itemIn);
          let unit = normUnit(unitIn);

          // If unit omitted, resolve to single existing unit (if exactly one)
          if (!unit) {
            const rows = listDistinctUnitsForItem.all(guildId, channelId, partyId, item);
            const units = [...new Set(rows.map(r => r.unit || ''))];
            if (units.length === 1) {
              unit = units[0];
              // also use the canonical stored item text to avoid case-duplication
              item = rows[0]?.item || item;
            } else if (units.length > 1) {
              const choices = units.map(u => u || '(no unit)').join(', ');
              await interaction.reply({
                content: `Multiple units exist for **${item}**: ${choices}\nSpecify a unit, e.g. \`/party stash add item "${item}" qty ${qty} unit ${units[0]}\`.`,
                flags: EPH
              });
              return;
            }
          }

          // Check if this exact (item, unit) row exists BEFORE adding
          const preRow = getQtyForRow.get(guildId, channelId, partyId, item, unit);
          const wasNew = !preRow;

          // Upsert (adds or increments)
          upsertStashAdd.run(
            guildId, channelId, partyId,
            item, unit, qty, gpVal, notes,
            interaction.user.id, Date.now()
          );

          // Fetch the new total after the add
          const after = getQtyForRow.get(guildId, channelId, partyId, item, unit);
          const newQty = Number(after?.qty) || 0;
          const unitStr = unit ? ` ${unit}` : '';

          // Optional: audit trail in gm_logs
          insGmLog.run(
            guildId, channelId, partyId, getActiveSessionIdSafe(guildId, channelId),
            'stash:add', `+${qty} ${item}${unitStr}${notes ? ` — ${notes}` : ''}`,
            normTags(`#stash #${item.replace(/\s+/g, '-')}`), null, null,
            'gm', null, null, interaction.user.id, Date.now()
          );

          // Reply — if brand new, don’t show the “now have” total
          if (wasNew) {
            await interaction.reply({
              content: `Added **${qty}${unitStr} ${item}**.`,
              flags: EPH
            });
          } else {
            await interaction.reply({
              content: `Added **${qty}${unitStr} ${item}**. You now have **${newQty}${unitStr} ${item}**.`,
              flags: EPH
            });
          }

          return;
        }

        // /party stash remove
        if (sub === 'remove') {
          const itemIn = interaction.options.getString('item', true);
          const qtyIn  = interaction.options.getNumber('qty', true);
          const unitIn = interaction.options.getString('unit') || '';

          const qtyReq = Number(qtyIn);
          if (!Number.isFinite(qtyReq) || qtyReq <= 0) {
            await interaction.reply({ content: 'Quantity to remove must be a positive number.', flags: EPH });
            return;
          }

          let item = normItem(itemIn);
          let unit = normUnit(unitIn);

          // If unit omitted, resolve to single existing unit (if exactly one)
          if (!unit) {
            const rows = listDistinctUnitsForItem.all(guildId, channelId, partyId, item);
            const units = [...new Set(rows.map(r => r.unit || ''))];
            if (units.length === 1) {
              unit = units[0];
              item = rows[0]?.item || item;
            } else if (units.length > 1) {
              const choices = units.map(u => u || '(no unit)').join(', ');
              await interaction.reply({
                content: `Multiple units exist for **${item}**: ${choices}\nSpecify a unit, e.g. \`/party stash remove item "${item}" qty ${qtyReq} unit ${units[0]}\`.`,
                flags: EPH
              });
              return;
            }
          }

          const row = getQtyForRow.get(guildId, channelId, partyId, item, unit);
          if (!row) {
            await interaction.reply({
              content: `No matching stash entry for **${item}**${unit ? ` (${unit})` : ''}.`,
              flags: EPH
            });
            return;
          }

          const available = Number(row.qty) || 0;
          const toRemove = Math.min(available, qtyReq);
          const remaining = Math.max(0, available - toRemove);
          const unitStr = unit ? ` ${unit}` : '';

          if (toRemove <= 0) {
            await interaction.reply({
              content: `**${item}**${unitStr} is already at 0.`,
              flags: EPH
            });
            return;
          }

          // Apply removal and cleanup if it hits zero
          stashClampRemove.run(
            toRemove, toRemove,
            interaction.user.id, Date.now(),
            guildId, channelId, partyId, item, unit
          );
          stashDeleteRowIfZero.run(guildId, channelId, partyId, item, unit);

          // Optional audit trail in gm_logs
          insGmLog.run(
            guildId, channelId, partyId, getActiveSessionIdSafe(guildId, channelId),
            'stash:remove', `-${toRemove} ${item}${unitStr}`,
            normTags(`#stash #${item.replace(/\s+/g, '-')}`), null, null,
            'gm', null, null, interaction.user.id, Date.now()
          );

          if (remaining <= 0) {
            await interaction.reply({
              content: `Removed all **${available}${unitStr} ${item}**.`,
              flags: EPH
            });
          } else {
            await interaction.reply({
              content: `Removed **${toRemove}${unitStr} ${item}**. You now have **${remaining}${unitStr} ${item}**.`,
              flags: EPH
            });
          }
          return;
        }

        // Unknown sub under /party stash
        await interaction.reply({ content: 'Unknown /party stash subcommand.', flags: EPH });
        return;
      } // end group === 'stash'

      // ───────────────────────────────────────────────────────────
      // Ungrouped subs: new | use | list | end | roster | add | remove | update | show
      // ───────────────────────────────────────────────────────────

      // /party new name:<string> [adventure:<string>]
      if (sub === 'new') {
        const name = interaction.options.getString('name', true).trim();
        const adventure = interaction.options.getString('adventure') || null;

        const existing = selPartyByName.get(guildId, channelId, name);
        partyDb.exec('BEGIN IMMEDIATE');
        try {
          deactivateAllParties.run(guildId, channelId);
          if (existing) {
            activatePartyById.run(existing.id);
          } else {
            insertParty.run(guildId, channelId, name, adventure);
          }
          partyDb.exec('COMMIT');
        } catch (e) {
          partyDb.exec('ROLLBACK');
          throw e;
        }

        const active = selActiveParty.get(guildId, channelId);
        await interaction.reply({
          content: `Created/activated party **${active.name}**${adventure ? ` (adventure: ${adventure})` : ''}.`,
          flags: EPH
        });
        return;
      }

      // /party use name:<string>
      if (sub === 'use') {
        const name = interaction.options.getString('name', true).trim();
        const row = selPartyByName.get(guildId, channelId, name);
        if (!row) {
          await interaction.reply({ content: `No party named **${name}** in this channel. Try **/party new**.`, flags: EPH });
          return;
        }
        partyDb.exec('BEGIN IMMEDIATE');
        try {
          deactivateAllParties.run(guildId, channelId);
          activatePartyById.run(row.id);
          partyDb.exec('COMMIT');
        } catch (e) {
          partyDb.exec('ROLLBACK'); throw e;
        }
        await interaction.reply({ content: `Activated party **${name}**.`, flags: EPH });
        return;
      }

      // /party list
      if (sub === 'list') {
        const rows = listParties.all(guildId, channelId);
        if (!rows.length) {
          await interaction.reply({ content: 'No parties in this channel. Use **/party new** to create one.', flags: EPH });
          return;
        }
        const lines = rows.map(r => `${r.is_active ? '⭐ ' : '  '}${r.name}${r.adventure_code ? ` — *${r.adventure_code}*` : ''}`);
        await interaction.reply({ content: 'Parties in this channel:\n' + lines.join('\n'), flags: EPH });
        return;
      }

      // /party end
      if (sub === 'end') {
        const active = selActiveParty.get(guildId, channelId);
        if (!active) {
          await interaction.reply({ content: 'No active party to end.', flags: EPH });
          return;
        }
        endPartyById.run(active.id);
        await interaction.reply({ content: `Ended party **${active.name}**. You can **/party use** another or **/party new**.`, flags: EPH });
        return;
      }

      // /party roster
      if (sub === 'roster') {
        const active = ensureActiveParty(guildId, channelId); // creates "Party" if none
        const members = listMembersByParty.all(guildId, channelId, active.id);
        if (!members.length) {
          await interaction.reply({ content: `Party **${active.name}** has no members yet. Use **/party add**.`, flags: EPH });
          return;
        }
        const lines = members.map(m => `• **${m.character_name}** ${m.class ? `(${m.class} ${m.level ?? ''})` : ''}${m.player_user ? ` — <@${m.player_user}>` : ''}`);
        await interaction.reply({ content: `**${active.name}** roster:\n${lines.join('\n')}`, flags: EPH });
        return;
      }

      // /party add name:<string> [player:<user>]
      if (sub === 'add') {
        const charName = interaction.options.getString('name', true).trim();
        const player   = interaction.options.getUser('player') || interaction.user;

        const active = ensureActiveParty(guildId, channelId);
        setPlayerOnly.run(guildId, channelId, active.id, charName, player.id, Date.now());

        const key = makeKey(channelId, charName);
        pendingVsheet.set(key, {
          characterName: charName,
          requestedBy: interaction.user.id,
          playerId: player.id,
          partyId: active.id,
          expiresAt: Date.now() + 2 * 60 * 1000
        });

        await interaction.reply({
          content:
            `Added **${charName}** to party **${active.name}**.\n` +
            `Owner: <@${player.id}>.\n\n` +
            `Now run **/party update** \`${charName}\` and then post an Avrae **!vsheet** for that character in this channel to import stats.\n` +
            `_I’ll listen for !vsheet for the next 2 minutes._`,
          flags: EPH
        });
        return;
      }

      // /party remove name:<string>
      if (sub === 'remove') {
        const charName = interaction.options.getString('name', true).trim();
        const active = selActiveParty.get(guildId, channelId);
        if (!active) {
          await interaction.reply({ content: 'No active party. Use **/party new** or **/party use**.', flags: EPH });
          return;
        }
        const exists = getMemberByParty.get(guildId, channelId, active.id, charName);
        if (!exists) {
          await interaction.reply({ content: `**${charName}** is not in **${active.name}**.`, flags: EPH });
          return;
        }
        removeMemberByParty.run(guildId, channelId, active.id, charName);
        await interaction.reply({ content: `Removed **${charName}** from **${active.name}**.`, flags: EPH });
        return;
      }

      // /party update name:<string>
      if (sub === 'update') {
        const charName = interaction.options.getString('name', true).trim();
        const active = selActiveParty.get(guildId, channelId);
        if (!active) {
          await interaction.reply({ content: 'No active party. Use **/party new** or **/party use**.', flags: EPH });
          return;
        }
        const row = getMemberByParty.get(guildId, channelId, active.id, charName);
        if (!row) {
          await interaction.reply({ content: `I don’t see **${charName}** in party **${active.name}**. Use **/party add** first.`, flags: EPH });
          return;
        }

        const key = makeKey(channelId, charName);
        pendingVsheet.set(key, {
          characterName: charName,
          requestedBy: interaction.user.id,
          playerId: row.player_user || interaction.user.id,
          partyId: active.id,
          expiresAt: Date.now() + 2 * 60 * 1000
        });
        setTimeout(() => {
          const cur = pendingVsheet.get(key);
          if (cur && cur.expiresAt <= Date.now()) pendingVsheet.delete(key);
        }, 2 * 60 * 1000 + 2000);

        await interaction.reply({
          content:
            `Okay! I’m listening for an Avrae **!vsheet** for **${charName}** in this channel for the next **2 minutes**.\n` +
            `Please have <@${row.player_user || interaction.user.id}> post \`!vsheet\` (optionally with the character name) now.`,
          flags: EPH
        });
        return;
      }

      // /party show name:<string>
      if (sub === 'show') {
        const charName = interaction.options.getString('name', true).trim();
        const active = selActiveParty.get(guildId, channelId);
        if (!active) {
          await interaction.reply({ content: 'No active party. Use **/party new** or **/party use**.', flags: EPH });
          return;
        }
        const row = getMemberByParty.get(guildId, channelId, active.id, charName);
        if (!row) {
          await interaction.reply({
            content: `I don’t see **${charName}** in party **${active.name}**. Try **/party add** first (then **/party update** and post \`!vsheet\`).`,
            flags: EPH
          });
          return;
        }

        // Build the embed (pull from row + data_json)
        let data = {};
        try { data = row.data_json ? JSON.parse(row.data_json) : {}; } catch {}

        const cls       = row.class || data.class || '—';
        const lvl       = row.level ?? data.level ?? '—';
        const prof      = (row.prof_bonus ?? data.prof ?? null);
        const sab       = data.spellAtkBonus ?? null;
        const sdc       = data.spellSaveDC ?? null;
        const ac        = row.ac ?? data.ac ?? '—';
        const hpCur     = row.hp_current ?? data.hpCur ?? '—';
        const hpMax     = row.hp_max ?? data.hpMax ?? '—';
        const init      = row.init_mod ?? data.init ?? '—';
        const speed     = row.speed ?? data.speed ?? '—';
        const pp        = row.pp ?? data.passivePerception ?? '—';
        const resist    = row.resistances ?? arrayOrCSV(data.resistances);
        const senses    = row.senses ?? arrayOrCSV(data.senses);
        const sheetUrl  = row.sheet_url || data.sheetUrl || null;
        const abilities = data.abilities || null;
        const saves     = data.saves || null;
        const skills    = data.skills || null;
        const attacks   = data.attacks || [];

        // robust timestamp to handle ms or seconds
        const ts = Number(row.updated_at) || Date.now();
        const tsMs = ts < 2e10 ? ts * 1000 : ts;

        const embed = {
          color: 0x2b6cb0,
          title: row.character_name,
          description: data.ancestry ? `*${data.ancestry}*` : undefined,
          fields: [
            { name: 'Class', value: cls, inline: true },
            { name: 'Character Level', value: String(lvl), inline: true },
            { name: 'Proficiency Bonus', value: prof != null ? fmtMod(prof) : '—', inline: true },
            ...(sab != null || sdc != null ? [
              { name: 'Spell Attack Bonus', value: fmtMod(sab ?? 0), inline: true },
              { name: 'Spell Save DC', value: sdc != null ? String(sdc) : '—', inline: true },
              { name: '\u200B', value: '\u200B', inline: true },
            ] : []),
            { name: 'AC', value: String(ac), inline: true },
            { name: 'HP', value: `${hpCur}/${hpMax}`, inline: true },
            { name: 'Initiative', value: fmtMod(init ?? 0), inline: true },
            { name: 'Speed', value: speed != null ? `${speed} ft.` : '—', inline: true },
            { name: 'Passive Perception', value: String(pp), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Abilities', value: abilitiesLine(abilities), inline: false },
            { name: 'Saving Throw Proficiencies', value: mapToCommaList(saves), inline: false },
            { name: 'Skill Proficiencies', value: mapToCommaList(skills), inline: false },
            { name: 'Background', value: data.background || '—', inline: false },
            { name: 'Resistances', value: arrayOrCSV(resist), inline: false },
            { name: 'Senses', value: arrayOrCSV(senses), inline: false },
            { name: 'Attacks', value: attacksBlock(attacks), inline: false },
            ...(sheetUrl ? [{ name: 'Character Sheet URL', value: sheetUrl, inline: false }] : []),
          ],
          footer: {
            text: `Updated ${new Date(tsMs).toLocaleString()}`
          }
        };

        await interaction.reply({ embeds: [embed] });
        return;
      }

      // Unknown /party subcommand
      await interaction.reply({ content: 'Unknown /party subcommand.', flags: EPH });
    }


    // /ref
    if (interaction.commandName === 'ref') {
      const q = interaction.options.getString('q', true);
      const top = interaction.options.getInteger('top') || 30;
      if (!ragDb) {
        await interaction.reply({ content: 'No reference index loaded yet. Run the book ingester first.', flags: EPH });
        return;
      }

      await interaction.deferReply({ flags: EPH });
      try {
        const results = await retrieveContext(q, { topK: top }); // uses your existing embed search over rules.db
        if (!results.length) {
          await interaction.editReply(`No matches for **${q}**.`);
          return;
        }
        const sess = { key: refMakeKey(), q, results, page: 0, pageSize: 5, ts: Date.now() };
        setRefSession(interaction.user.id, sess);
        const view = renderRefPage(sess);
        await interaction.editReply({ content: view.content, components: view.components });
      } catch (e) {
        console.error('ref search error:', e);
        await interaction.editReply('Search failed. Check logs.');
      }
      return;
    }


    // /ping
    if (interaction.commandName === 'ping') {
      await interaction.reply('pong 🏓');
      return;
    }

    // /teach
    if (interaction.commandName === 'teach') {
      try {
        await interaction.deferReply({ flags: EPH });

        const paste = interaction.options.getString('paste', true);
        const actorOpt = interaction.options.getString('actor') || '';
        const channelOpt = interaction.options.getChannel('channel');

        // Pick target channel: explicit > current (if registered) > last active in this guild
        let teachChannelId = channelOpt?.id;
        if (!teachChannelId) {
          if (isRegisteredGameChannel(interaction.channel)) {
            teachChannelId = interaction.channel.id;
          } else {
            teachChannelId = getDefaultTeachChannelId(interaction);
          }
        }
        if (!teachChannelId) {
          await interaction.editReply('I couldn’t determine which game channel to teach for. Provide the **channel** option, run `/teach` inside the game channel, or trigger Auto-GM once so I know the last active channel.');
          return;
        }

        const parsed = parseTeachPaste(paste) || {};
        const actor = (actorOpt || parsed.actor || '').trim();

        // Always work with an array
        let entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if ((!entries || !entries.length) && Array.isArray(parsed.names)) {
          // Back-compat in case an older parser returned "names"
          entries = parsed.names.map(n => ({ name: n, kind: 'action' }));
        }

        if (!actor) {
          await interaction.editReply('I couldn’t find the actor name. Add it with the **actor** option (e.g., `Goblin Hexer1`).');
          return;
        }
        if (!entries || !entries.length) {
          await interaction.editReply('I couldn’t detect any actions in the paste. Make sure you pasted the Avrae DM text that includes entries like `Greatclub: Attack: +6 to hit`.');
          return;
        }

        // Persist to memory (applies to exact name and base prefix)
        rememberActorActions(teachChannelId, actor, entries);
        persistActorActions(teachChannelId, actor, entries);

        // Pretty echo
        const byKind = entries.reduce((acc, e) => {
          (acc[e.kind] ||= []).push(e.name);
          return acc;
        }, {});
        const lines = [];
        if (byKind.action?.length)   { lines.push('**Actions**:');       lines.push(...byKind.action.map(n => `• ${n}`)); }
        if (byKind.bonus?.length)    { lines.push('\n**Bonus Actions**:');lines.push(...byKind.bonus.map(n => `• ${n}`)); }
        if (byKind.reaction?.length) { lines.push('\n**Reactions**:');    lines.push(...byKind.reaction.map(n => `• ${n}`)); }

        await interaction.editReply([
          `Learned **${entries.length}** move(s) for **${actor}** in <#${teachChannelId}> (applies to base **${getActorBase(actor)}**).`,
          '',
          ...lines,
        ].join('\n'));

        // Immediately resume that actor's turn with an ops-only suggestion (no public narration)
        try {
          const chan = await client.channels.fetch(teachChannelId).catch(() => null);
          if (chan && chan.isTextBased()) {
            const style = getAutoMode(teachChannelId);
            const { includeRules } = modeToSettings(style);
            await runGMForChannel(
              chan,
              `Follow-up after /teach: continue ${actor}'s turn with a concrete action.`,
              { actNow: true, includeRules, actor, silentPublic: true }
            );
            setLastActiveGameChannel(chan);
          }
        } catch (err) {
          console.error('Teach follow-up run failed:', err);
        }

        // Debug
        console.log('TEACH parsed:', { actor, entries });
      } catch (err) {
        console.error('teach handler error:', err);
        try { await interaction.editReply('Teach failed. Check logs.'); } catch {}
      }
      return;
    }


    // /model
    if (interaction.commandName === 'model') {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ content: 'Model settings are per-server. Try this inside a server.', flags: EPH });
        return;
      }
      if (sub === 'get') {
        await interaction.reply(`Current model: \`${getModel(guildId)}\``);
        return;
      }
      if (sub === 'set') {
        const name = interaction.options.getString('name', true);
        if (!ALLOWED_MODELS.includes(name)) {
          await interaction.reply({ content: `That model isn’t allowed here. Allowed: ${ALLOWED_MODELS.join(', ')}`, flags: EPH });
          return;
        }
        guildModel.set(guildId, name);
        await interaction.reply(`Model set to \`${name}\` for this server.`);
        return;
      }
    }

    // /ask
    // /ask (RAG-first with 2024 preference + citations)
    if (interaction.commandName === 'ask') {
      const userPrompt = interaction.options.getString('prompt', true);
      await interaction.deferReply();

      // If we have a rules DB, try to answer strictly from it first
      let usedRag = false;
      let finalText = '';
      let usedSources = [];

      try {
        if (ragDb) {
          // Retrieve and prefer 2024 sources
          const raw = await retrieveContext(userPrompt, { topK: 12 });
          const ranked = rerankPrefer2024(raw);

          if (isAddressedByContext(userPrompt, ranked)) {
            const { text: ctxBlock, used } = buildContextBlock(ranked, 6);
            usedSources = used;

            const STRICT_SYSTEM = `
    You are a rules assistant for D&D 5e (2024 revision preferred over 2014).
    Answer the user's question USING ONLY the "Objective Rules Excerpts" provided.
    - Prefer sources marked "PRIORITY: 2024" when conflicts exist.
    - Be concise and practical.
    - If a rule is ambiguous in the excerpts, explain both readings briefly.
    - Cite with [n] after each key claim so readers can see which excerpt supports it.
    - Do NOT invent rules or rely on outside knowledge.
    `.trim();

            const STRICT_USER = `
    User question:
    ${userPrompt}

    Objective Rules Excerpts:
    ${ctxBlock}

    Now write the answer using ONLY the excerpts above, with bracket citations (e.g., [1], [2]) mapped to the provided list.
    `.trim();

            const model = getModel(interaction.guildId);
            const completion = await openai.chat.completions.create({
              model,
              messages: [
                { role: 'system', content: STRICT_SYSTEM },
                { role: 'user', content: STRICT_USER },
              ],
            });

            finalText = completion.choices?.[0]?.message?.content?.trim() || '';
            usedRag = !!finalText;
          }
        }
      } catch (e) {
        console.error('RAG answer attempt failed:', e);
      }

      // Fallback to general model if the DB didn't sufficiently address it
      if (!usedRag) {
        try {
          const model = getModel(interaction.guildId);
          const completion = await openai.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
          });
          finalText = completion.choices?.[0]?.message?.content || '(no reply)';

          // If we still had some results, add them as "Related reading"
          if (ragDb) {
            const raw = await retrieveContext(userPrompt, { topK: 5 });
            const ranked = rerankPrefer2024(raw).slice(0, 5);
            usedSources = ranked;
          }
        } catch (e) {
          console.error('General /ask failed:', e);
          finalText = 'OpenAI error. Check API key, model access, and logs.';
        }
      }

      // Ship answer (chunk if needed), then append sources with 2024 preference visible
      const chunks = finalText.match(/[\s\S]{1,1900}(?=\n|$)/g) || [finalText];
      if (chunks.length) await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);

      if (usedSources?.length) {
        const key = makeAskSrcKey();
        saveAskSrcSession(key, usedSources);

        const srcLines = usedSources.map((p, i) => {
          const tag = boost2024ForPath(p.path) > 0 ? ' • 2024' : '';
          return `[${i + 1}] ${p.path} (sim ${p.score.toFixed(3)}${tag})`;
        }).join('\n');

        const content = 'Sources (click a number to expand below):\n' + '```text\n' + srcLines + '\n```';
        const components = buildAskSrcButtons(key, usedSources);

        await interaction.followUp({ content, components });
      }

      return;
    }

    // /auto
    if (interaction.commandName === 'auto') {
      const sub = interaction.options.getSubcommand();
      const ch = interaction.channel;
      const chId = ch?.id;

      if (!chId || !isRegisteredGameChannel(ch)) {
        await interaction.reply({ content: 'Use this inside a registered game channel.', flags: EPH });
        return;
      }

      if (sub === 'get') {
        const on   = autoGMEnabled.has(chId) ? autoGMEnabled.get(chId) : AUTO_GM_DEFAULT;
        const mode = getAutoMode(chId);
        const silent = getSilentPcTurns(chId);
        await interaction.reply({
          content: `Auto-GM: **${on ? 'ON' : 'OFF'}**\nMode: \`${mode}\`\nSilent PC turns: **${silent ? 'ON' : 'OFF'}**`,
          flags: EPH
        });
        return;
      }

      if (sub === 'set') {
        const state = interaction.options.getString('state', true);
        const on = state === 'on';
        autoGMEnabled.set(chId, on);
        await interaction.reply({ content: `Auto-GM set to **${on ? 'ON' : 'OFF'}**.`, flags: EPH });
        return;
      }

      if (sub === 'mode') {
        const style = interaction.options.getString('style'); // optional
        if (!style) {
          const current = getAutoMode(chId);
          await interaction.reply({ content: `Current Auto-GM mode: \`${current}\``, flags: EPH });
          return;
        }
        const allowed = new Set(['narrate_only', 'include_rules', 'act_now', 'act_now_rules']);
        if (!allowed.has(style)) {
          await interaction.reply({ content: 'Invalid mode.', flags: EPH });
          return;
        }
        autoMode.set(chId, style);
        await interaction.reply({ content: `Auto-GM mode set to \`${style}\`.`, flags: EPH });
        return;
      }

      if (sub === 'silent') {
        const state = interaction.options.getString('state', true);
        const on = state === 'on';
        silentPcTurns.set(chId, on);
        await interaction.reply({ content: `Silent PC turns set to **${on ? 'ON' : 'OFF'}**.`, flags: EPH });
        return;
      }
    }

    // bestiary
    if (interaction.commandName === 'bestiary') {
      const sub = interaction.options.getSubcommand();

      // ---------- /bestiary find ----------
      if (sub === 'find') {
          const query =
            interaction.options.getString('query') ??
            interaction.options.getString('name') ??
            interaction.options.getString('q');

          if (!query) {
            await interaction.reply({ content: 'Provide a search term, e.g. `/bestiary find query: oni`.', flags: EPH });
            return;
          }

          const key = makeKey();
          const sess = {
            key,
            q: query,
            page: 0,
            pageSize: 10,
            channelId: interaction.channel.id,
            ts: Date.now(),
          };
          setBestiaryFindSession(interaction.user.id, sess);

          const rendered = renderFindPage(sess);
          const payload = { content: rendered.content, flags: MessageFlags.Ephemeral };
          if (rendered.components && rendered.components.length) {
            payload.components = rendered.components;
          }
          await interaction.reply(payload);
          return;
        }

      // ---------- /bestiary show ----------
      if (sub === 'show') {
        // New shape: "target" (required). Fallback to legacy name/pack/idx if some user still has an old cached form.
        const targetOpt = interaction.options.getString('target');
        const legacyName = interaction.options.getString('name');
        const legacyPack = interaction.options.getString('pack');
        const legacyIdx  = interaction.options.getInteger('idx');

        const target = (targetOpt || legacyName || '').trim();

        const parsePackIdx = (s) => {
          const m = s && s.match(/^(.+?)\s*#\s*(\d+)$/);
          return m ? { pack: require('path').basename(m[1].trim()), idx: parseInt(m[2], 10) } : null;
        };

        let picked = null;

        // A) explicit pack+idx via "pack.json#123" or legacy pack+idx
        const pi = parsePackIdx(target) || (legacyPack && Number.isInteger(legacyIdx) ? { pack: legacyPack, idx: legacyIdx } : null);
        if (pi) picked = getBestiaryMonsterByPackIdx(pi.pack, pi.idx);

        // B) name lookup
        if (!picked && target) picked = getBestiaryMonster(target);

        // C) ranked fallback to top hit
        if (!picked && target) {
          const probe = searchBestiaryRanked(target, 0, 1);
          if (probe.page && probe.page[0]) {
            picked = getBestiaryMonsterByPackIdx(probe.page[0].pack, probe.page[0].idx);
          }
        }

        if (!picked) {
          await interaction.reply({ content: 'Monster not found.', flags: EPH });
          return;
        }

        const text = formatMonsterRich(picked);

        // Public (non-ephemeral) output for /show
        const parts = [];
        let t = String(text);
        while (t.length) { parts.push(t.slice(0, 1900)); t = t.slice(1900); }

        await interaction.reply({ content: parts[0] });
        for (let i = 1; i < parts.length; i++) {
          await interaction.followUp({ content: parts[i] });
        }
        return;
      }

    }

    // /gm
    if (interaction.commandName === 'gm') {
      if (!isRegisteredGameChannel(interaction.channel)) {
        await interaction.reply({ content: 'This isn’t a registered game channel.', flags: EPH });
        return;
      }

      const note = interaction.options.getString('note') || '';

      // sources flags
      const showSourcesOpt = interaction.options.getBoolean('show_sources');
      const sourcesEphemeralOpt = interaction.options.getBoolean('sources_ephemeral');
      const showSources = (showSourcesOpt === null) ? SHOW_SOURCES_DEFAULT : showSourcesOpt;
      const wantsEphemeral = showSources
        ? ((sourcesEphemeralOpt === null) ? SOURCES_EPHEMERAL_DEFAULT : !!sourcesEphemeralOpt)
        : false;

      // runtime flags
      const narrateOnlyOpt  = interaction.options.getBoolean('narrate_only');
      const includeRulesOpt = interaction.options.getBoolean('include_rules');
      const actNowOpt       = interaction.options.getBoolean('act_now');

      const narrateOnly  = (narrateOnlyOpt  === null) ? NARRATE_ONLY_DEFAULT  : !!narrateOnlyOpt;
      const includeRules = (includeRulesOpt === null) ? INCLUDE_RULES_DEFAULT : !!includeRulesOpt;
      const actNow       = (actNowOpt       === null) ? ACT_NOW_DEFAULT       : !!actNowOpt;

      await interaction.deferReply({ ephemeral: wantsEphemeral });
      console.log('flags => narrateOnly:', narrateOnly, 'includeRules:', includeRules, 'actNow:', actNow, 'showSources:', showSources, 'wantsEphemeral:', wantsEphemeral);

      const chId = interaction.channel.id;
      const recent = transcript.get(chId) || [];
      const sceneQuery = [recent.slice(-10).join('\n'), note && `GM note: ${note}`].filter(Boolean).join('\n');

      // Retrieval (with simple must/prefer)
      const q = (sceneQuery || '').toLowerCase();
      const mustTerms = [];
      const preferTerms = [];
      if (/\bprone\b/.test(q)) mustTerms.push('prone');
      if (/\bshove(d|s)?\b/.test(q)) preferTerms.push('shove', 'shoved');
      if (/\bgrappl(ed|e|ing)\b/.test(q)) preferTerms.push('grapple', 'grappled');

      let retrievedContext = [];
      try {
        retrievedContext = await retrieveContext(sceneQuery, { topK: RAG_TOPK, mustTerms, preferTerms });
      } catch (e) {
        console.warn('RAG retrieval failed (continuing without context):', e.message);
        retrievedContext = [];
      }
      const retrieved = retrievedContext.map(x => x.formatted).join('\n\n');

      const model = chooseModelForGM({
        baseModel: getModel(interaction.guildId),
        miniModel: FAST_MODEL,
        transcriptChars: recent.join('\n').length,
        retrievedChars: retrieved.length,
        complexityHint: note,
      });

      const prompt = [
        'Recent table log (most recent last):',
        ...recent.slice(-20),
        retrieved ? '\nRules/notes context:\n' + retrieved : '',
        note ? `\nGM note: ${note}` : '',
      ].filter(Boolean).join('\n');

      try {
        const MODE_INSTRUCTIONS = `
          RUNTIME CONTROLS:
          - narrate_only: ${narrateOnly}
          - include_rules: ${includeRules}
          - act_now: ${actNow}

          Behavior:
          - If narrate_only is true: OUTPUT ONLY the <NARRATION> block. Do NOT include rules explanations, player option lists, questions to players, or an <AVRAE> block.
          - If include_rules is true: Within <NARRATION>, include a brief "Rulings (RAW)" section (max 4 bullets).
          - If act_now is true: After narration, include an <AVRAE> block with exact Avrae commands. If false, omit <AVRAE>.
          - Never include a "Sources" section in <NARRATION>; citations are handled by the bot UI.
          `.trim();

        const completion = await openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: GM_SYSTEM },
            { role: 'system', content: MODE_INSTRUCTIONS },
            { role: 'user', content: prompt },
          ],
        });

        const out = completion.choices?.[0]?.message?.content || '(no reply)';
        await interaction.editReply('— GM acting —');

        // Sources (optional)
        function chunkString(str, size = 1800) { const out = []; for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size)); return out; }
        function makeKeywords(query) { const base = (query || '').toLowerCase(); const words = Array.from(new Set(base.match(/[a-z]{4,}/g) || [])); const priority = ['prone','grapple','shove','opportunity','concentration','cover','disadvantage','advantage']; const merged = [...new Set([...priority.filter(p => words.includes(p)), ...words])]; return merged.slice(0, 8); }
        function bestExcerpt(text, query, maxLen = 220) { const t = (text || '').replace(/\s+/g, ' '); if (!t) return ''; const kws = makeKeywords(query); let pos = -1; for (const k of kws) { const i = t.toLowerCase().indexOf(k); if (i !== -1) { pos = i; break; } } if (pos === -1) { return t.length > maxLen ? t.slice(0, maxLen) + '…' : t; } const half = Math.floor(maxLen / 2); const start = Math.max(0, pos - half); const end = Math.min(t.length, start + maxLen); return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : ''); }
        function firstHeading(text) { const m = text && text.match(/(^|\n)#+\s*([^\n#]+)\s*/); return m ? m[2].trim() : null; }

        if (showSources && retrievedContext.length) {
          const replyFlags = wantsEphemeral ? MessageFlags.Ephemeral : undefined;
          const summaryBody = retrievedContext.map(p => {
            const heading = firstHeading(p.text);
            const excerpt = bestExcerpt(p.text, sceneQuery, 220);
            const header = `#${p.rank}  ${p.path}  [chunk ${p.idx}]  sim ${p.score.toFixed(3)}` + (heading ? `  — ${heading}` : '');
            return `${header}\n ${excerpt}`;
          }).join('\n\n');
          const payload = 'Sources used:\n' + '```text\n' + summaryBody + '\n```';
          const parts = chunkString(payload);
          await interaction.followUp({ content: parts[0], flags: replyFlags });
          for (let i = 1; i < parts.length; i++) await interaction.followUp({ content: parts[i], flags: replyFlags });
        }

        // Post result (with ephemeral buttons for commands)
        await postGMResult(interaction.channel, out, { interaction });
        setLastActiveGameChannel(interaction.channel);
      } catch (e) {
        console.error(e);
        await interaction.editReply('GM error. Check logs.');
      }
      return;
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);