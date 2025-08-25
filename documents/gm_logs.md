# GM Logs & Notes

This document explains the Game Master logging system used by the bot: data model, prepared statements, command surface, and operational guidance. It covers **gm_logs**, **party_notes**, **party_reputation**, and **party_stash** (stash management is surfaced on `/party`, but logs can still be written into `gm_logs`).

---

## Goals
- Give the GM a durable, searchable timeline of campaign events per channel/party.
- Separate structured concepts (reputation, stash, notes) while keeping a unified audit trail.
- Be future‑proof for permissions/visibility without blocking current use.
- Support auto‑logging from the GM AI while allowing manual edits and queries.

---

## Tables

### 1) `gm_logs` — append‑only event stream
**Purpose:** Time‑ordered, free‑text events the GM or the automation records.

**Columns**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `guild_id` TEXT NOT NULL
- `channel_id` TEXT NOT NULL
- `party_id` INTEGER NULL — NULL for channel‑scoped/global logs, else the active party id
- `session_id` INTEGER NULL — link to active session if any
- `category` TEXT NOT NULL — e.g. `exploration`, `combat`, `decision`, `rep:add`, `stash:remove`, etc.
- `content` TEXT NOT NULL — description
- `tags` TEXT NULL — space or comma separated tokens, e.g. `#inn #rumors`
- `related_adv_code` TEXT NULL — optional adv short code (from ingest)
- `related_node_key` TEXT NULL — optional adventure node key
- `visibility` TEXT DEFAULT `gm` — `gm` | `players` | `private`
- `allow_roles` TEXT NULL — reserved for future per‑role ACLs
- `allow_users` TEXT NULL — reserved for future per‑user ACLs
- `created_by` TEXT NULL — user id
- `created_at` INTEGER NOT NULL — epoch ms

**Indexes**
- `idx_gm_logs_party (guild_id, channel_id, party_id, created_at DESC)`
- `idx_gm_logs_session (guild_id, channel_id, session_id, created_at DESC)`

**Prepared Statements (key ones)**
- `insGmLog` — insert a new log row
- `listRecentLogs` — latest N logs for (guild, channel, party)
- `searchLogs` — LIKE search on `content` or `tags`, party‑scoped or global

**Categories (suggested taxonomy)**
- Core: `exploration`, `social`, `combat`, `travel`, `rest`, `downtime`, `quest`, `clue`, `decision`, `failure`, `milestone`, `session`
- Integrations: `rep:add`, `rep:set`, `rep:note`, `stash:add`, `stash:remove`, `note:add`, `note:edit`, `note:pin`, `note:unpin`
- Adventure links: `adv:start`, `adv:node`, `adv:end`

## Event Categories (added)
| category                | content example                           | tags                    |
|-------------------------|-------------------------------------------|-------------------------|
| event:combat:init       | "Initiative started" / "Initiative ended" | #init/start or #init/end|
| event:combat:summary    | "A 3-minute skirmish — 5 hits, 1 miss…"   | #combat/summary         |
| event:rest:short        | "Short rest resolved"                     | #rest/short             |
| event:rest:long         | "Long rest resolved"                      | #rest/long              |
| event:decision          | "I sneak past the guard"                  | #decision               |
| event:session:summary   | recap text at /session end                | #recap                  |

Notes:
• These rows only write while a session is active.
• `events search <text>` continues to match `category`, `content`, and `tags`.

> Use tags for quick faceting: `#npc:<name>`, `#faction:<name>`, `#location:<name>`, `#loot`, `#mystery`, etc.

---

### 2) `party_notes` — durable GM notes
**Purpose:** Pinned or regular notes with titles; used for handouts, prep, session summaries.

**Columns**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `guild_id` TEXT NOT NULL
- `channel_id` TEXT NOT NULL
- `party_id` INTEGER NOT NULL
- `session_id` INTEGER NULL
- `scope` TEXT DEFAULT `party` — `party` | `session` | `gm`
- `title` TEXT NOT NULL
- `body` TEXT NOT NULL
- `pinned` INTEGER DEFAULT 0
- `visibility` TEXT DEFAULT `gm`
- `allow_roles` TEXT NULL
- `allow_users` TEXT NULL
- `created_by` TEXT NULL
- `created_at` INTEGER NOT NULL
- `updated_by` TEXT NULL
- `updated_at` INTEGER NOT NULL

**Indexes**
- `idx_party_notes_party (guild_id, channel_id, party_id, created_at DESC)`

**Prepared Statements**
- `insNote`, `updNote`, `setNotePinned`, `delNote`
- `getNote`, `listNotesStmt`, `countNotesStmt`
- `searchNotes` — LIKE on `title` or `body`

**Good uses**
- Session recap, NPC dossiers, location briefs, TODOs, clues board.
- Pin commonly referenced notes or handouts.

---

### 3) `party_reputation` — faction disposition
**Purpose:** Track party reputation with factions and its trend/notes.

**Columns**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `guild_id` TEXT NOT NULL
- `channel_id` TEXT NOT NULL
- `party_id` INTEGER NOT NULL
- `faction` TEXT NOT NULL
- `score` INTEGER NOT NULL DEFAULT 0
- `trend` TEXT NULL — e.g., `improving`, `worsening`, `volatile`
- `notes` TEXT NULL — free text running note log
- `visibility` TEXT DEFAULT `players`
- `allow_roles` TEXT NULL
- `allow_users` TEXT NULL
- `updated_by` TEXT NULL
- `updated_at` INTEGER NOT NULL

**Constraints**
- `UNIQUE (guild_id, channel_id, party_id, faction)` — one row per faction per party

**Prepared Statements**
- `upsertReputation` — insert/update with score, trend, notes
- `getRepOneCI` — case‑insensitive single lookup
- `listReps` — all reputations for party

**Notes**
- The bot also logs to `gm_logs` on changes: `rep:add`, `rep:set`, `rep:note`.
- `/gmlog rep show` supports case‑insensitive partials; multi‑word tokens are matched contain‑wise.

---

### 4) `party_stash` — shared loot / currency
**Purpose:** Track shared party inventory and currency with unit normalization.

**Columns**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `guild_id` TEXT NOT NULL
- `channel_id` TEXT NOT NULL
- `party_id` INTEGER NOT NULL
- `item` TEXT NOT NULL — canonicalized titlecase
- `qty` REAL NOT NULL DEFAULT 1
- `unit` TEXT DEFAULT '' — canonicalized lowercase; empty string means “no unit”
- `gp_value` REAL NULL — optional value hint
- `notes` TEXT NULL
- `visibility` TEXT DEFAULT `players`
- `allow_roles` TEXT NULL
- `allow_users` TEXT NULL
- `updated_by` TEXT NULL
- `updated_at` INTEGER NOT NULL

**Indexes & Constraints**
- `CREATE UNIQUE INDEX uniq_party_stash ON (guild_id, channel_id, party_id, item, unit)`

**Prepared Statements** (key ones)
- `upsertStashAdd` — add or merge quantities; carries `gp_value`/`notes` forward if provided
- `stashClampRemove` — subtract clamped to available
- `stashDeleteRowIfZero` — cleanup empty rows
- `listStashByParty`, `listDistinctUnitsForItem`, `getQtyForRow`

**UX Notes**
- Stash commands moved under `/party stash` for players & GM.
- Unit can be omitted when there’s exactly one existing unit for the item.
- Replies include *running total* after add/remove, e.g., “Now you have 25 Arrows”.

---

## Command Surface (summary)

> Full details in **commands.md**. Below is the logging‑related subset.

### `/gmlog add`
Create a generic log entry with optional tags and adventure links.

### `/gmlog show`
Show the most recent log lines for the active party/channel.

### `/gmlog search query:<text> [limit]`
Search `gm_logs.content` and `gm_logs.tags` **and** `party_notes.title/body`, merged & time‑sorted.

### `/gmlog rep ...`
Group for reputation management: `add`, `set`, `note`, `show` (case‑insensitive partials supported on `show`).

### `/gmlog notes ...`
Group for notes management: `add`, `edit`, `pin`, `unpin`, `list`, `show`, `delete`.

### `/party stash ...`
Players and GM manage the shared stash: `add`, `remove`, `show`. Each action also writes a corresponding `gm_logs` entry.

---

## Search Semantics
- Text search uses `LIKE` on `content`/`tags` (logs) and `title`/`body` (notes).
- Scope: includes unscoped logs (`party_id IS NULL`) and party‑scoped logs for the active party.
- Results are merged and sorted by `created_at` (desc), with a kind tag in the output (`log/…` or `note`).

---

## Visibility & Permissions (future‑ready)
- `visibility` column on all tables: `gm`, `players`, `private` (currently advisory; display logic may enforce it later).
- `allow_roles` / `allow_users` reserved for per‑row ACLs.
- Today, we default to permissive behavior; later, middleware can filter rows at read time.

---

## Auto‑Logging Hooks (for the GM AI)
- **Session start/end**: write `gm_logs` with `category='session'` + `content='start|end'`.
- **Adventure traversal**: on node enter/exit, write `adv:node` with `related_adv_code` & `related_node_key`.
- **Reputation changes**: already logged by the command handler.
- **Stash changes**: already logged by `/party stash` handlers.
- **Significant choices/clues**: AI can emit `decision`/`clue` with tags like `#npc:Strahd`.

---

## Edge Cases & Conventions
- Timestamps are epoch **ms**.
- Tags allow either comma or space delimited; we normalize lightly.
- Keep `unit=''` (empty string) for “no unit” to preserve uniqueness invariant.
- Avoid editing past logs; prefer new entries (append‑only mindset). Use notes for living documents.

---

## Example Snippets

**Insert a generic event**
```
insGmLog.run(g, c, partyId, sessionId, 'social', 'Spoke with Madam Eva about the cards', '#npc:Madam-Eva', 'cos', 'Tser_Pool', 'gm', null, null, userId, Date.now());
```

**Add a pinned handout**
```
insNote.run(g, c, partyId, sessId, 'party', 'Prophecy', 'The raven flies at dawn...', 1, 'players', null, null, userId, now, userId, now);
```

**Increase reputation**
```
upsertReputation.run(g,c,partyId,'Harpers', current+2, 'improving', 'Returned the lost harp', 'players', null, null, userId, now);
```

---

## Migration & Maintenance Tips
- Schema creation is **idempotent**; additive migrations use `ALTER TABLE` guarded by `PRAGMA table_info`.
- Normalize existing `party_stash.unit` to `''` (empty string) once; a helper does this on startup.
- Unique index `uniq_party_stash` prevents duplicates on `(item, unit)` per party.

---

## Roadmap
- Implement visibility enforcement in renderers (hide `gm`/`private` rows from non‑GM users).
- Full‑text search (FTS5) virtual tables for `gm_logs`/`party_notes`.
- Structured log types (JSON) for machine‑readable events (e.g., encounter start/end, node transitions).
- Web dashboard export (CSV/MD) for campaign journals.

