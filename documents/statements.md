# Prepared Statements Reference

This doc lists the prepared SQL statements used by `index.js`, grouped by feature area. Each entry shows the **statement name**, the **SQL**, and the **parameter order** you must pass when calling `.run()` / `.get()` / `.all()`.

> All tables/columns referenced here match `DB_SCHEMA.sql`.

---

## Parties

### `selActiveParty` — get active party for channel
```sql
SELECT *
FROM parties
WHERE guild_id = ? AND channel_id = ? AND is_active = 1
ORDER BY id DESC
LIMIT 1;
```
**Params:** `(guild_id, channel_id)`

### `selPartyByName` — find party by exact name
```sql
SELECT *
FROM parties
WHERE guild_id = ? AND channel_id = ? AND name = ?
LIMIT 1;
```
**Params:** `(guild_id, channel_id, name)`

### `deactivateAllParties` — archive existing parties in channel
```sql
UPDATE parties
SET is_active = 0
WHERE guild_id = ? AND channel_id = ?;
```
**Params:** `(guild_id, channel_id)`

### `insertParty` — create & activate a party
```sql
INSERT INTO parties (guild_id, channel_id, name, adventure_code, is_active)
VALUES (?, ?, ?, ?, 1);
```
**Params:** `(guild_id, channel_id, name, adventure_code)`

### `activatePartyById`
```sql
UPDATE parties
SET is_active = 1
WHERE id = ?;
```
**Params:** `(party_id)`

### `endPartyById`
```sql
UPDATE parties
SET is_active = 0
WHERE id = ?;
```
**Params:** `(party_id)`

### `listParties` — list all parties for channel
```sql
SELECT id, name, is_active, adventure_code, created_at
FROM parties
WHERE guild_id = ? AND channel_id = ?
ORDER BY is_active DESC, id DESC;
```
**Params:** `(guild_id, channel_id)`

---

## Party Members (scoped by `party_id`)

### `listMembersByParty`
```sql
SELECT *
FROM party_members
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
ORDER BY is_npc ASC, character_name COLLATE NOCASE;
```
**Params:** `(guild_id, channel_id, party_id)`

### `getMemberByParty`
```sql
SELECT *
FROM party_members
WHERE guild_id = ? AND channel_id = ? AND party_id = ? AND character_name = ?
LIMIT 1;
```
**Params:** `(guild_id, channel_id, party_id, character_name)`

### `removeMemberByParty`
```sql
DELETE FROM party_members
WHERE guild_id = ? AND channel_id = ? AND party_id = ? AND character_name = ?;
```
**Params:** `(guild_id, channel_id, party_id, character_name)`

### `setPlayerOnly` — upsert owner when adding member
```sql
INSERT INTO party_members (
  guild_id, channel_id, party_id, character_name, player_user, updated_at
) VALUES (?,?,?,?,?,?)
ON CONFLICT(guild_id, channel_id, party_id, character_name)
DO UPDATE SET
  player_user = excluded.player_user,
  updated_at  = excluded.updated_at;
```
**Params:** `(guild_id, channel_id, party_id, character_name, player_user, updated_at_ms)`

### `upsertMemberFromVsheet` — import Avrae !vsheet
```sql
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
  updated_at     = excluded.updated_at;
```
**Params:**
```
(guild_id, channel_id, party_id, character_name, player_user,
 class, level, prof_bonus, ac, hp_current, hp_max,
 init_mod, speed, pp, resistances, senses, sheet_url,
 abilities_json, saves_json, skills_json, attacks_json,
 ancestry, background, data_json, updated_at_ms)
```

---

## Sessions

### `insSessionStart`
```sql
INSERT INTO sessions (
  guild_id, channel_id, party_id, host_user, started_at, notes
) VALUES (?,?,?,?,?,?);
```
**Params:** `(guild_id, channel_id, party_id, host_user, started_at_ms, notes_json_or_null)`

### `updSessionEnd`
```sql
UPDATE sessions
SET ended_at = ?, notes = COALESCE(?, notes)
WHERE id = ?;
```
**Params:** `(ended_at_ms, final_notes_json_or_null, session_id)`

### `selActiveSessionId`
```sql
SELECT id
FROM sessions
WHERE guild_id = ? AND channel_id = ? AND party_id = ? AND ended_at IS NULL
ORDER BY id DESC
LIMIT 1;
```
**Params:** `(guild_id, channel_id, party_id)`

### `listSessions`
```sql
SELECT *
FROM sessions
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
ORDER BY id DESC
LIMIT ? OFFSET ?;
```
**Params:** `(guild_id, channel_id, party_id, limit, offset)`

---

## GM Logs

### `insGmLog`
```sql
INSERT INTO gm_logs (
  guild_id, channel_id, party_id, session_id,
  category, content, tags, related_adv_code, related_node_key,
  visibility, allow_roles, allow_users,
  created_by, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);
```
**Params:** `(guild_id, channel_id, party_id, session_id, category, content, tags, adv_code, node_key, visibility, allow_roles, allow_users, created_by, created_at_ms)`

### `listRecentLogs`
```sql
SELECT *
FROM gm_logs
WHERE guild_id = ? AND channel_id = ? AND (party_id = ? OR party_id IS NULL)
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```
**Params:** `(guild_id, channel_id, party_id, limit, offset)`

### `searchLogs`
```sql
SELECT 'log' AS kind, id, category, content, tags, created_at
FROM gm_logs
WHERE guild_id = ? AND channel_id = ? AND (party_id = ? OR party_id IS NULL)
  AND (content LIKE ? OR tags LIKE ?)
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```
**Params:** `(guild_id, channel_id, party_id, like_content, like_tags, limit, offset)`

---

## Notes

### `insNote`
```sql
INSERT INTO party_notes (
  guild_id, channel_id, party_id, session_id,
  scope, title, body, pinned, visibility,
  allow_roles, allow_users,
  created_by, created_at, updated_by, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
```
**Params:** `(guild_id, channel_id, party_id, session_id, scope, title, body, pinned_int, visibility, allow_roles, allow_users, created_by, created_at_ms, updated_by, updated_at_ms)`

### `updNote`
```sql
UPDATE party_notes
SET scope = ?, title = ?, body = ?, visibility = ?,
    updated_by = ?, updated_at = ?
WHERE id = ? AND guild_id = ? AND channel_id = ? AND party_id = ?;
```
**Params:** `(scope, title, body, visibility, updated_by, updated_at_ms, id, guild_id, channel_id, party_id)`

### `setNotePinned`
```sql
UPDATE party_notes
SET pinned = ?, updated_by = ?, updated_at = ?
WHERE id = ? AND guild_id = ? AND channel_id = ? AND party_id = ?;
```
**Params:** `(pinned_int, user_id, updated_at_ms, id, guild_id, channel_id, party_id)`

### `getNote`
```sql
SELECT *
FROM party_notes
WHERE id = ? AND guild_id = ? AND channel_id = ? AND party_id = ?
LIMIT 1;
```
**Params:** `(id, guild_id, channel_id, party_id)`

### `delNote`
```sql
DELETE FROM party_notes
WHERE id = ? AND guild_id = ? AND channel_id = ? AND party_id = ?;
```
**Params:** `(id, guild_id, channel_id, party_id)`

### `listNotesStmt`
```sql
SELECT id, title, scope, pinned, visibility, updated_at
FROM party_notes
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
ORDER BY updated_at DESC
LIMIT ? OFFSET ?;
```
**Params:** `(guild_id, channel_id, party_id, limit, offset)`

### `countNotesStmt`
```sql
SELECT COUNT(*) AS c
FROM party_notes
WHERE guild_id = ? AND channel_id = ? AND party_id = ?;
```
**Params:** `(guild_id, channel_id, party_id)`

### `searchNotes`
```sql
SELECT 'note' AS kind, id, title, body, created_at
FROM party_notes
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
  AND (title LIKE ? OR body LIKE ?)
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```
**Params:** `(guild_id, channel_id, party_id, like_title, like_body, limit, offset)`

---

## Reputation

### `upsertReputation`
```sql
INSERT INTO party_reputation (
  guild_id, channel_id, party_id,
  faction, score, trend, notes,
  visibility, allow_roles, allow_users,
  updated_by, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(guild_id, channel_id, party_id, faction) DO UPDATE SET
  score      = excluded.score,
  trend      = excluded.trend,
  notes      = excluded.notes,
  visibility = excluded.visibility,
  allow_roles= excluded.allow_roles,
  allow_users= excluded.allow_users,
  updated_by = excluded.updated_by,
  updated_at = excluded.updated_at;
```
**Params:** `(guild_id, channel_id, party_id, faction, score, trend, notes, visibility, allow_roles, allow_users, updated_by, updated_at_ms)`

### `getRepOneCI` — case‐insensitive lookup
```sql
SELECT *
FROM party_reputation
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
  AND faction = ? COLLATE NOCASE
LIMIT 1;
```
**Params:** `(guild_id, channel_id, party_id, faction_query)`

### `listReps`
```sql
SELECT faction, score, trend, notes
FROM party_reputation
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
ORDER BY faction COLLATE NOCASE;
```
**Params:** `(guild_id, channel_id, party_id)`

---

## Party Stash

### `upsertStashAdd` — add or increment a stash row
```sql
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
  updated_at = excluded.updated_at;
```
**Params:** `(guild_id, channel_id, party_id, item, unit, qty, gp_value, notes, updated_by, updated_at_ms)`

### `stashClampRemove` — subtract with floor at 0
```sql
UPDATE party_stash
SET qty = CASE WHEN qty - ? < 0 THEN 0 ELSE qty - ? END,
    updated_by = ?,
    updated_at = ?
WHERE guild_id = ? AND channel_id = ? AND party_id = ? AND item = ? AND unit = ?;
```
**Params:** `(delta_qty, delta_qty, updated_by, updated_at_ms, guild_id, channel_id, party_id, item, unit)`

### `stashDeleteRowIfZero`
```sql
DELETE FROM party_stash
WHERE guild_id = ? AND channel_id = ? AND party_id = ? AND item = ? AND unit = ? AND qty <= 0;
```
**Params:** `(guild_id, channel_id, party_id, item, unit)`

### `listStashByParty`
```sql
SELECT item, unit, qty, gp_value, notes
FROM party_stash
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
ORDER BY LOWER(item), unit;
```
**Params:** `(guild_id, channel_id, party_id)`

### `getQtyForRow`
```sql
SELECT qty
FROM party_stash
WHERE guild_id = ? AND channel_id = ? AND party_id = ? AND item = ? AND unit = ?
LIMIT 1;
```
**Params:** `(guild_id, channel_id, party_id, item, unit)`

### `listDistinctUnitsForItem`
```sql
SELECT DISTINCT unit, item
FROM party_stash
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
  AND LOWER(item) = LOWER(?);
```
**Params:** `(guild_id, channel_id, party_id, item_name)`

---

## Event Summaries (derived from `gm_logs`)

These are not separate tables; they are convenience queries you may use when building per‑session or per‑party summaries.

### Examples
```sql
-- session recap by category
SELECT category, COUNT(*) AS n
FROM gm_logs
WHERE guild_id = ? AND channel_id = ? AND party_id = ? AND session_id = ?
GROUP BY category
ORDER BY n DESC;

-- last 20 meaningful events
SELECT category, content, created_at
FROM gm_logs
WHERE guild_id = ? AND channel_id = ? AND party_id = ?
ORDER BY created_at DESC
LIMIT 20;
```
**Params:** as indicated per query.

---

### Notes
- All timestamps are stored as **milliseconds since epoch** (`INTEGER`).
- Case‑insensitive comparisons rely on `COLLATE NOCASE`.
- Stash `unit` is normalized to `''` (empty string) for no‑unit, so uniqueness works cleanly.
- Use the exact parameter order shown above to avoid "Too few/many parameter values" errors.

