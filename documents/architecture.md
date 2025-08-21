# ARCHITECTURE

> High-level map of the bot’s moving parts: runtime, storage, ingest, and command surface.

---

## 1) Runtime Overview

- **Discord runtime:** A single Node.js process (discord.js) registers slash commands and reacts to interactions (`/party`, `/session`, `/gmlog`, etc.).
- **SQLite stores (better-sqlite3):**
  - `party.db` (read-write) — live campaign state (parties, members, sessions, logs, notes, reputation, stash). WAL journal + NORMAL sync.
  - `docs.sqlite` (read-write during ingest) — text corpus of adventures/books for RAG. The `docs` table holds `(adv_code, node_key, text, meta, updated_at)`.
- **In-memory helpers:**
  - `pendingVsheet` map for “listen for next `!vsheet`” flow per channel+character.
  - Forgiving `!vsheet` parser + normalizers; upsert persists parsed sheet to `party_members`.

---

## 2) Data Model (party.db)

### Parties & Members
- **`parties`**: channel‑scoped sticky “active party” with optional adventure code and a current node pointer. Unique per `(guild_id, channel_id, name)`. Also an `is_active` flag per channel.
- **`party_members`**: characters bound to a **party** (via `party_id`) and channel. Rich character profile plus blobs (abilities/saves/skills/attacks), ancestry/background, ownership (`player_user`) and timestamps. Canonical uniqueness is `(guild_id, channel_id, party_id, character_name)`.

Typical lookups: by active party, by `(guild, channel, party_id, character_name)`. Sorted roster uses `is_npc` and case‑insensitive name ordering.

### Sessions
- **`party_sessions`**: explicit session start/end (timestamps), optional notes, `created_by`. The active session finder filters by `ended_at IS NULL`.

### GM Telemetry & Knowledge
- **`gm_logs`**: append‑only event stream with typed `category` (e.g., `rep:add`, `stash:remove`), freeform `content`, tag string, optional adventure bindings, and visibility fields (permission scaffolding). Indexed by party and session; timestamps are epoch ms.
- **`party_notes`**: durable GM/party notes, with `scope` (party/session/character/faction), pinning, and visibility scaffolding.
- **`party_reputation`**: faction disposition (`score`, `trend`, `notes`) with a uniqueness constraint per party+faction and helpful query index.
- **`party_stash`**: normalized “shared loot” ledger: `(item, unit, qty, gp_value, notes)` with a unique index on `(guild_id, channel_id, party_id, item, unit)`. Visibility scaffolding is present.

> **Permission scaffolding** — `visibility`, `allow_roles`, `allow_users` exist on logs/notes/rep/stash for future ACLs; schema helper ensures these columns are present.

---

## 3) V‑Sheet Import Flow

1. **Arm**: `/party update <name>` records a pending window keyed to `(channelId::name)` so the next Avrae `!vsheet` in that channel is captured.
2. **Detect**: message listener heuristics recognize Avrae’s embed/content (`Class:`, `HP:`, `AC:`, `!vsheet` footer).
3. **Parse**: tolerant regex extraction: class/level/prof; AC/HP/init/speed; abilities (score+mod); saves/skills; PP/senses/resists; attacks; sheet URL.
4. **Persist**: an upsert writes all fields & JSON blobs into `party_members` (ON CONFLICT update), stamping `updated_at`.

---

## 4) Command Surface (high level)

- **`/party`**  
  - **Party mgmt**: `new/use/list/end`, **roster**. Active party is per‑channel; “ensure active” creates a default on first use.  
  - **Members**: `add/remove`, `update` (arms `!vsheet`), `show` (renders character embed from stored profile).  
  - **Stash** (moved from `/gmlog`): `stash add/remove/show`. Adds merge by `(item,unit)`; removes clamp to available and delete rows at zero; all operations optionally audit to `gm_logs`. Unique index prevents duplicate rows.

- **`/session`**  
  - `start`, `end`, `status` (active session is required before story‑driving `/adv` runs as GM). Backed by `party_sessions`.

- **`/gmlog`**  
  - **add/show/search** — freeform telemetry feed & lookup (text+tags). Search spans logs and notes with `LIKE` across content/tags/title/body and sorts by time.  
  - **rep** group — `add`, `set`, `note`, `show` for `party_reputation`, with CI/partial matching on faction names and history writes to `gm_logs`.  
  - **notes** group — `add/edit/pin/unpin/list/delete` over `party_notes` with pin + scope + visibility.  
  - **events** group — typed events (e.g., **combat**, **social**, **travel**, **discovery**) into `gm_logs`, used later for automatic recap and reputation heuristics.

---

## 5) Adventure & Book Ingest (docs.sqlite)

- **Corpus table**: `docs(id, adv_code, node_key, text, meta, updated_at)` with uniqueness per `(adv_code, node_key)` and indices for lookups. Drives RAG queries, `/adv` scaffolding, and future scene steering.
- **Ingest script (`ingest.js`)**: CLI utilities to (a) load raw JSON/text into `docs`, (b) (optionally) chunk, and (c) maintain metadata/timestamps; it’s the central hub for getting material into the knowledge store.
- **Adventure graph ingest (`ingest-adventure.js`)**: parses per‑adventure JSON to a node/edge graph, merges encounters/assets, and writes narrative nodes into `docs` with `(adv_code, node_key, meta, text)`. Invoked per file (e.g., `adventure-*.json`) and logs counts/timings for diagnostics.

---

## 6) Reliability & Concurrency Notes

- **SQLite pragmas**: WAL + NORMAL sync on `party.db` to reduce locks and improve throughput. (Ingest uses its own connection to `docs.sqlite`.)
- **Upsert patterns**: `ON CONFLICT` on meaningful composite keys (e.g., member identity, stash `(item,unit)`, reputation `(faction)`) provide idempotent, lock-light writes suitable for Discord command bursts.
- **Indices**: targeted for hot paths (by party, by session, by composite identity) to keep list/search/show responsive.

---

## 7) What’s intentionally “stubbed” for v1

- **Permission enforcement**: tables already carry `visibility`, `allow_roles`, `allow_users`; enforcement is uncomplicated to add later since the shape is standardized across entities.
- **Automated GM driver**: the runtime has all scaffolding (active party/session, reputation, notes, stash, logs, docs corpus). The next step is wiring the story driver to:
  1) gate on active session,
  2) read the active party/adventure pointer,
  3) summarize recent `gm_logs`/`party_notes`, and
  4) query `docs` for the next scene node.

---

## 8) Quick “How it fits together”

1) **Players** use `/party` to assemble a roster, then `/session start`.
2) **GM/auto‑GM** runs using the adventure corpus in `docs.sqlite`, writing **events** and **notes** to `party.db` as play unfolds.
3) **Reputation** and **stash** mutate via commands and/or automated heuristics (social/combat/loot), with changes mirrored to `gm_logs`.
4) **Recaps** and **resumes** draw from `gm_logs` + `party_notes` + `party_sessions` to rehydrate context.

