# Session Model

This document describes how a **play session** is represented, tracked, and used by the GM Bot to coordinate party progress, adventure state, and GM-facing logs.

---

## Goals

- Provide a durable record of each table’s play sessions (start/end, topic, who started/ended).
- Gate gameplay features (e.g., `/adv`) behind an active session.
- Give the GM Bot a compact, queryable **context bundle** during an active session.
- Auto-log meaningful events (decisions, node transitions, NPC/PC interactions, stash/reputation changes) for later recall.
- Support human-in-the-loop edits via `/gmlog` and `/party`.

---

## Core Entities & Relationships

```
Guild/Channel ─┬─ Parties (one active per channel) ─┬─ Party Members
               │                                    └─ Party Stash / Reputation / Notes
               └─ Sessions (0 or 1 active) ─────────────┘
```

- **parties**: per-guild, per-channel; exactly one may be active at a time.
- **party_members**: characters (PCs/NPCs) scoped to a party.
- **sessions**: time-bounded windows of play; at most one active per (guild, channel, party).
- **gm_logs / party_notes / party_reputation / party_stash**: session-aware or party-scoped artifacts that form the campaign history.

---

## Session Table (Overview)

**Table**: `sessions`

| Column        | Type     | Notes |
| ---           | ---      | --- |
| `id`          | INTEGER  | PK |
| `guild_id`    | TEXT     | Partition key |
| `channel_id`  | TEXT     | Partition key |
| `party_id`    | INTEGER  | FK → parties.id |
| `topic`       | TEXT     | Optional session focus or title |
| `notes`       | TEXT     | Free-form annotations |
| `started_by`  | TEXT     | Discord user id |
| `started_at`  | INTEGER  | ms epoch |
| `ended_by`    | TEXT     | Discord user id (nullable) |
| `ended_at`    | INTEGER  | ms epoch (nullable) |

**Active session** = row with `ended_at IS NULL` for the (guild_id, channel_id, party_id).

---

## Lifecycle

### States
- **Inactive**: No active session for the channel.
- **Active**: Exactly one `sessions` row with `ended_at NULL`.
- **Ended**: Session persisted with `ended_at` and `ended_by` set.

### Transitions (via slash commands)
- `/session start [topic] [notes]` → create sessions row (requires an active party).
- `/session status` → report the live session (duration, party name, participants, adventure node if known).
- `/session end` → set `ended_at`, `ended_by`; (optionally) produce a summary note.

> **Design rule:** _No auto start/end._ The session lifecycle is explicit per your requirement.

---

## Session Context Bundle (Runtime)

When a session is active, the bot can snapshot a **context bundle** used by the GPT “GM loop” to reason about the party and current scene.

```json
{
  "session": {
    "id": 42,
    "guild_id": "…",
    "channel_id": "…",
    "party_id": 7,
    "topic": "Ambush at the Old Bridge",
    "started_at": 1723948023000
  },
  "party": {
    "name": "The Verdant Company",
    "members": [
      {
        "character_name": "Aegis",
        "player_user": "1234567890",
        "class": "Paladin",
        "level": 2,
        "ac": 15,
        "hp": { "current": 13, "max": 20 },
        "init_mod": 0,
        "pp": 11,
        "resistances": ["necrotic","radiant"],
        "sheet_url": "https://…"
      },
      { "character_name": "Sera", "class": "Ranger", "level": 1, … }
    ]
  },
  "adventure": {
    "code": "ditlcot",
    "node_key": "ch1.intro",
    "breadcrumbs": ["ch1.intro"]
  },
  "reputation": [
    { "faction": "Harpers", "score": 6, "trend": "improving" }
  ],
  "stash": [
    { "item": "Gold Pieces", "qty": 25, "unit": "gp" },
    { "item": "Potion of Healing", "qty": 2, "unit": "" }
  ],
  "recent_logs": [
    { "when": 1723948120000, "category": "decision", "content": "Aegis parleyed instead of fighting" },
    { "when": 1723948205000, "category": "adv:node", "content": "Moved to ch1.bridge-ambush" }
  ]
}
```

**Provenance:** All values are sourced from the db via lightweight queries (`party_members`, `party_stash`, `party_reputation`, `gm_logs`) scoped to the active session/party.

---

## Gating & Guardrails

- Commands that _require_ an active session: anything that drives narrative progression (e.g., `/adv open`, `/adv continue`, future auto-GM actions). If no active session, reply with an ephemeral hint to run `/session start`.
- Commands that are **allowed without** a session: party roster maintenance (`/party add/remove/show/roster/stash`), reference queries (`/ask`, `/ref`, `/bestiary`).

---

## Auto-Logging & Signal Sources

While a session is active, the bot should observe:

1. **Adventure navigation**
   - When a node is opened/continued, insert `gm_logs` rows with `category = 'adv:node'`, plus `related_adv_code` & `related_node_key`.
2. **Encounters & combat**
   - Detect initiative/attack/skill roll patterns from Avrae posts; log summaries (e.g., `category = 'combat'`, `content = 'Orc ambush resolved; party won'`).
  • On **init start/end** (Avrae): write `event:combat:init` (start/end).
  • On **init end**: flush combat transcript → write `event:combat:summary`.
  • On **rest** (Avrae result): write `event:rest:short|long`.
  • On **directed action** (@bot or /gm …): write `event:decision`.
  • On **/session end**: write `event:session:summary` and post recap.
  All of the above are gated by an active session.
3. **Decisions & consequences**
   - When a choice button is pressed or a decision is confirmed in chat, log as `category = 'decision'` with tags like `#npc:Strahd` or `#location:OldBridge`.
4. **Loot & stash updates**
   - `/party stash add/remove` already writes to `party_stash`. Optionally mirror to `gm_logs` with `category = 'stash:add'|'stash:remove'`.
5. **Reputation changes**
   - `/gmlog rep add|set|note` persists to `party_reputation` and writes `gm_logs` entries for timeline context.
6. **Notes**
   - `/gmlog notes add/edit/pin` creates durable party notes; their titles/bodies become searchable via `/gmlog search`.

These signals form the **session diary** and power post-game summaries and resumptions.

---

## Resumption Strategy

When a new session starts for a party:

1. Load the **last ended session** (if any) and extract its last `adv:node` entry as the resume node.
2. Present a short **Recap** compiled from `gm_logs` (last N timeline items) and pinned `party_notes`.
3. Offer to **continue** from the last node or **branch** (if choices were left unresolved).

---

## Permissions (Future-Ready)

Each of the following tables includes `visibility`, `allow_roles`, `allow_users` columns for future enforcement:

- `gm_logs`, `party_notes`, `party_reputation`, `party_stash`.

**Current behavior:** permissive (no filtering). **Future:**
- `visibility = 'gm'` → hide from non-GM roles/users.
- `visibility = 'players'` → safe for player-facing commands.

---

## Multi-Channel & Concurrency

- All queries key on `(guild_id, channel_id)`; WAL mode mitigates read/write contention.
- Only one active party & session per channel by design (explicit control prevents crosstalk).

---

## End-of-Session Summary (Optional)

On `/session end`, generate and store a one-page recap:

- Key events by category (decisions, nodes visited, major NPC interactions).
- Loot & stash deltas.
- Reputation changes.
- Injuries, conditions, and level-ups.

Persist as a pinned `party_notes` row (scope=`party`, visibility=`players`).

---

## Health & Integrity Checks

- Assert **one active session** per (guild_id, channel_id, party_id).
- Warn if `/adv` is invoked without an active session.
- Validate that `/party` mutations occur only for the active party.

---

## Future Hooks for the Auto-GM Loop

- **Session heartbeat:** periodic lightweight summary pushed to the model (context bundle), with deltas since last tick.
- **Scene controller:** store current `adventure.node_key`, open choices, and scene objectives in a small `session_state` JSON blob (kept in memory; mirrored to `party_notes` on checkpoints).
- **Safety tools:** quick `/session flag` to mark lines/subjects to avoid; write to `party_notes(scope='session')` with `visibility='gm'`.

---

## Minimal Query Surface (for the GM loop)

- `selActiveSessionId(guild, channel, party)` → `{ id } | null`.
- `selActiveParty(guild, channel)` → `{ id, name, adventure_code, … }`.
- `listMembersByParty(guild, channel, partyId)` → array of PCs/NPCs (with stats from last `!vsheet`).
- `listStashByParty(guild, channel, partyId)` → current stash.
- `listReps(guild, channel, partyId)` → reputations.
- `listRecentLogs(guild, channel, partyId, limit, offset)` → latest gm_logs.
- `getLastAdvNode(guild, channel, partyId)` → last node key (if any).

---

## Performance & Storage

- All write-heavy tables are append-mostly (logs/notes). Targeted UPDATEs are scoped by composite keys.
- WAL mode + short transactions → minimal lock contention.
- Indexes: ensure `sessions(guild_id, channel_id, party_id, ended_at)` and standard party indexes are present.

---

## FAQs

**Q: What if the bot restarts mid-session?**  
A: The session remains active (`ended_at` is NULL). Resume with `/session status` then continue.

**Q: Can we run two sessions in one channel?**  
A: Not concurrently by design. Create/activate another party or move to another channel.

**Q: Can players run `/adv`?**  
A: Behavior is configurable, but recommended flow is GM-only, gated by active session.

---

*This model keeps session orchestration narrow and explicit while giving the future Auto‑GM loop the structured context it needs to run scenes, react to dice/players, and write the campaign’s living history.*

