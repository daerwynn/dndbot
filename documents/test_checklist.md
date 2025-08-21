# Test Checklist

A pragmatic, end‑to‑end checklist for validating the **D&D GM Bot** in a real Discord guild. Use it before merges and after schema or command changes.

> Tip: check off items per environment (DEV, STAGE, PROD). Keep short notes (pass/fail, bug #) beside each item.

---

## 0) Pre‑Flight

- [ ] **Secrets**: `.env` contains `DISCORD_TOKEN`, `CLIENT_ID`, guild override, DB paths.
- [ ] **Node/Deps**: Node ≥ 20, clean `npm i`, `node -v` logged.
- [ ] **SQLite files**: `rules.db` (RAG), `party.db` present & writable. WAL enabled.
- [ ] **Bot perms**: Bot invited with Slash Commands, Send Messages, Read Message History, Embed Links, Manage Messages (optional cleanup).
- [ ] **Avrae** present in the server (for `!vsheet` capture) and can post embeds.

---

## 1) Command Registration

- [ ] Start bot; confirm **no registration errors** in console.
- [ ] In Discord, `/help` (if present) or type `/gmlog` and `/party`—subcommands visible & in expected groups.

---

## 2) Database Schema & Migrations

- [ ] On first launch, `party.db` creates **tables**: `parties`, `party_members`, `sessions`, `gm_logs`, `party_notes`, `party_reputation`, `party_stash`.
- [ ] Columns exist (spot‑check with `PRAGMA table_info`): `party_members.ancestry`, `hp_current`, `hp_max`, `init_mod`, `pp`, JSON blobs, etc.
- [ ] **Indexes** exist: uniqueness on `(guild_id, channel_id, party_id, item, unit)`; lookup indexes for parties/members/reps/stash.
- [ ] Re‑run with a preexisting DB: **no migration crashes**; columns added if missing.

---

## 3) Party Lifecycle

- [ ] `/party new name Testers` → reply confirms created/activated. `SELECT * FROM parties WHERE is_active=1` shows it.
- [ ] `/party list` shows active star next to **Testers**.
- [ ] `/party new name AltParty` then `/party list` (Testers inactive, AltParty active).
- [ ] `/party use name Testers` re‑activates it.
- [ ] `/party end` archives active; `/party roster` warns no members.

---

## 4) Add/Update Member via Avrae !vsheet

- [ ] `/party add name Aegis` → bot arms listener.
- [ ] `/party update name Aegis` → bot listening for 2min.
- [ ] Post **actual** Avrae `!vsheet` message for that character.
- [ ] Bot replies `Updated Aegis from !vsheet` (or with summary if configured).
- [ ] `/party show name Aegis` → embed includes:
  - [ ] Class/Level/Proficiency Bonus
  - [ ] AC, HP X/Y, Initiative, Speed, PP
  - [ ] Abilities line (all six), Saves, Skills
  - [ ] Resistances, Senses
  - [ ] Attacks parsed (name, to‑hit, damage)
  - [ ] Sheet URL shown if present
- [ ] Edge: send `!vsheet` with formatting variations (bold, italics, line breaks) still parses.
- [ ] Edge: expired listener (wait >2min) → silent ignore; run `/party update` again.

---

## 5) Party Stash (moved under /party)

- [ ] `/party stash add item "Gold Pieces" qty 20 unit gp` → reply confirms **Added 20 gp Gold Pieces**.
- [ ] `/party stash add item "Gold Pieces" qty 5 unit gp` → reply confirms delta and **now have 25**.
- [ ] Omit unit when exactly one exists → auto‑resolves; multiple units → bot prompts to specify.
- [ ] `/party stash show` lists consolidated rows; no duplicate case variants.
- [ ] `/party stash remove item "Gold Pieces" qty 10 unit gp` → reply shows **removed 10**, now **15** left.
- [ ] Remove to zero → row deleted; message confirms **removed all**.
- [ ] Remove non‑existent item → bot responds with **No matching stash entry** (no silent success).

---

## 6) Reputation (/gmlog rep …)

- [ ] `/gmlog rep add faction Harpers amount 2` → show new total; row created in `party_reputation`.
- [ ] `/gmlog rep set faction Harpers amount 5` → value replaced with 5.
- [ ] `/gmlog rep note faction Harpers notes "Allies secured"` → notes appended; trend optional.
- [ ] `/gmlog rep show` lists all reps; `/gmlog rep show faction harp` (case/partial) matches Harpers.
- [ ] Audit: matching entries written to `gm_logs` with `rep:*` categories.

---

## 7) Notes (/gmlog notes …)

- [ ] `/gmlog notes add title "Lead" body "Talk to Althea" scope party pin:true visibility players` → saved and pinned.
- [ ] `/gmlog notes list` shows pagination and pin marker.
- [ ] `/gmlog notes edit id <id> title "New Lead"` updates; `/gmlog notes pin id <id>` & `unpin` toggle state.
- [ ] `/gmlog notes delete id <id>` removes it; list reflects deletion.
- [ ] `/gmlog search lead` finds both logs & notes (unified).

---

## 8) GM Logs (/gmlog add/show/search)

- [ ] `/gmlog add category scene text "Arrived in Phandalin" tags "#travel #phandalin"` → inserted with timestamp.
- [ ] `/gmlog show limit 5` renders recent entries with categories & tags; time formatting OK.
- [ ] `/gmlog search phandalin` finds the above (content + tags); **no crash** and `fmtTime` used.

---

## 9) Events (/gmlog events …)

- [ ] `/gmlog events add type "social" text "Brokered peace with miners" tags "#phandalin"`
- [ ] `/gmlog events show` lists events with type.
- [ ] `/gmlog events search miners` matches by content **and** partial **type**.

---

## 10) Sessions (/session …)

- [ ] `/session start title "Session 01"` → opens new active session and timebox begins.
- [ ] During an active session, `/adv open …` allowed; without active session it warns/gates.
- [ ] `/session end` closes session; `/session status` shows none active.
- [ ] Restart session and verify continued logging/reputation/stash belong to new `session_id`.

---

## 11) Adventure Ingest & Lookup

- [ ] `node ingest-adventure.js` processes multiple files without DB lock or unique key errors.
- [ ] Titles normalized & validated; acronym checks logged for unmatched titles.
- [ ] `/adv find query "Tsojcanth"` (or your current command) returns metadata instead of raw JSON.

---

## 12) Permissions Scaffold (future‑ready)

- [ ] Tables contain `visibility`, `allow_roles`, `allow_users` columns where specified.
- [ ] Current behavior: no hard restrictions enforced; rows store values without error.
- [ ] Spot‑test: insert a row with custom `allow_roles`/`allow_users` → query returns as text.

---

## 13) Error Handling & Edge Cases

- [ ] Missing required option yields helpful ephemeral error (no stack trace leak).
- [ ] Concurrent /party stash adds from two users don’t duplicate rows (unique index holds).
- [ ] `!vsheet` posted by non‑owner still parses; owner stored from `/party add`.
- [ ] Expired pending vsheet cleanly ignored.
- [ ] Case differences in item/faction names do not create duplicates (canonicalization works).

---

## 14) Performance & Stability

- [ ] Bulk ingest (tens of adventures) runs without long stalls; DB WAL confirmed.
- [ ] Typical command latency < 1s in Discord; no unhandled promise rejections.
- [ ] Memory steady after 30 minutes of activity (watch process RSS).

---

## 15) Data Integrity Spot Checks (SQL)

Run these against `party.db` as needed:

```sql
-- Parties & active flag
SELECT id, name, is_active, created_at FROM parties WHERE guild_id=? AND channel_id=? ORDER BY id DESC;

-- Roster
SELECT party_id, character_name, class, level, player_user FROM party_members WHERE party_id=? ORDER BY character_name;

-- Stash
SELECT item, unit, qty, gp_value FROM party_stash WHERE party_id=? ORDER BY item, unit;

-- Reputation
SELECT faction, score, trend, notes FROM party_reputation WHERE party_id=? ORDER BY faction;

-- Notes
SELECT id, title, pinned, visibility, updated_at FROM party_notes WHERE party_id=? ORDER BY updated_at DESC LIMIT 10;

-- GM Logs
SELECT category, content, tags, created_at FROM gm_logs WHERE party_id=? ORDER BY created_at DESC LIMIT 10;
```

---

## 16) Regression Suite (Quick Pass)

- [ ] `/party new` → `/party add` → `!vsheet` → `/party show` → OK
- [ ] `/party stash add/remove/show` consolidates & cleans up rows
- [ ] `/gmlog rep add/set/note/show` (partial/case match works)
- [ ] `/gmlog notes add/list/edit/pin/unpin/delete`
- [ ] `/gmlog add/show/search` (includes notes in search)
- [ ] `/gmlog events add/show/search` (type partial match)
- [ ] `/session start` → `/adv open` allowed; `/session end` → gated

---

## 17) Release Checklist

- [ ] Bump bot version banner (if any) and changelog.
- [ ] Backup `party.db` before deploy; schema diffs reviewed.
- [ ] Smoke test in a staging guild with real Avrae.
- [ ] Announce command changes to players/GMs with short examples.

