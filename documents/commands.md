# Slash Commands Guide

> **Scope**
> • Commands are channel-scoped. Parties, sessions, logs, and stash live per **guild+channel**.
> • “Active party” is required for most operations; `ensureActiveParty` creates a default **Party** if missing.
> • “Active session” is **explicitly** controlled with `/session start` and `/session end`. Some features log session_id when present.
> • All replies are ephemeral by default (shown as “Only you can see this”).

---

## /party
Party management, roster, and shared stash.

### new
Create & activate a named party in this channel.
- **name** (string, required)
- **adventure** (string, optional) – freeform code/label for what you plan to run

**Example**: `/party new name "The Copper Serpents" adventure AITFR`

### use
Activate an existing party in this channel.
- **name** (string, required)

### list
List parties in this channel (marks active with ⭐).

### roster
Show the active party’s members.

### add
Add a character to the **active** party and arm a short window to capture their `!vsheet`.
- **name** (string, required) – character name
- **player** (user, optional) – defaults to the invoker

The bot will instruct the player to post an Avrae `!vsheet` in the next ~2 minutes.

### remove
Remove a character from the **active** party.
- **name** (string, required)

### update
Re-arm the `!vsheet` capture window to refresh an existing member.
- **name** (string, required)

### show
Show an embedded, Avrae-style character sheet from the latest `!vsheet` import.
- **name** (string, required)

### end
Archive (deactivate) the active party.

### stash (group)
Shared loot / currency for the **active** party.

#### stash show
List the stash.

#### stash add
Add/merge items into the stash. If **unit** is omitted and exactly one unit already exists for that item, it’s reused; if multiple units exist, the bot prompts you to specify one.
- **item** (string, required)
- **qty** (number, required) – positive
- **unit** (string, optional) – e.g., `gp`, `arrow`, `potion`, or blank
- **gp** (number, optional) – per‑unit or total value, used as an annotation
- **notes** (string, optional)

Responses:
- New item: `Added <qty> <unit?> <item>.`
- Existing item: `Added <qty>… You now have <total>…`

#### stash remove
Subtract from the stash (never below zero). If **unit** omitted and multiple exist, the bot asks you to specify.
- **item** (string, required)
- **qty** (number, required) – positive
- **unit** (string, optional)

Responses:
- `Removed <qty>… You now have <total>…`
- If reaches zero: `Removed all <item>…`
- If item/unit not found: clear guidance message.

---

## /session
Explicit table time control; `/adv` requires an active session.

### start
Begin a new session for the active party, capturing timestamp and optional summary.
- **note** (string, optional) – opening remark/agenda

### end
End the current session for the active party.
- **note** (string, optional) – closing recap

### status
Show whether a session is active and its start time/duration.

---

## /gmlog
GM event stream, durable notes, and faction reputation. (Players usually won’t use this directly.)

### rep (group)
Faction reputation tracking (case-insensitive, partial matching supported in *show*).

#### rep add
- **faction** (string, required)
- **amount** (integer, required) – delta to apply
- **trend** (string, optional) – e.g., `improving`, `worsening`
- **notes** (string, optional)

#### rep set
- **faction** (string, required)
- **amount** (integer, required) – absolute score to set
- **trend** (string, optional)
- **notes** (string, optional)

#### rep note
Append a note (and optional trend) without changing score.
- **faction** (string, required)
- **notes** (string, required)
- **trend** (string, optional)

#### rep show
Show all reputations, or filter with case-insensitive partials.
- **faction** (string, optional) – partial OK (e.g., `harp` matches `Harpers`)

### notes (group)
Durable GM notes (party-scoped; can pin, edit, search, and list).

#### notes add
- **title** (string, required)
- **body** (string, required)
- **scope** (string, optional; default `party`) – `party`, `session`, `adventure`, etc.
- **visibility** (string, optional; default `gm`) – future permissions
- **pin** (boolean, optional)

#### notes edit
- **id** (integer, required)
- **title** (string, optional)
- **body** (string, optional)
- **scope** (string, optional)
- **visibility** (string, optional)
- **pin** (boolean, optional)

#### notes pin / notes unpin
- **id** (integer, required)

#### notes list
- **page** (integer, optional; default 1)

#### notes show
Show a single note by id (if implemented) **or** use `/gmlog search` to find text across notes and logs.

### events (group)
Structured event logging (also writes to `gm_logs`).

#### events add
- **type** (choice, required) – `combat`, `quest`, `discovery`, `npc`, `travel`, `milestone`, `downtime`, `rumor`, `hazard`, `rest`
- **text** (string, required)
- **tags** (string, optional) – space/comma separated hashtags
- **adv** (string, optional) – adventure code
- **node** (string, optional) – node key within the adventure graph

#### events list
- **limit** (integer, optional; default 10)

#### events search
Full-text search across event **text** and also matches partials of **type**.
- **query** (string, required)

### add (generic log)
Freeform log line.
- **category** (string, required)
- **text** (string, required)
- **tags** (string, optional)
- **adv** (string, optional)
- **node** (string, optional)
- **visibility** (string, optional; default `gm`)

### show (generic log)
- **limit** (integer, optional; default 10)

### search (generic; logs + notes)
- **query** (string, required)
Searches `gm_logs.category/content/tags` and `party_notes.title/body` (party-scoped and unscoped).

---

## /adv
Adventure compendium access (requires an active session to *run*, but you can still reference data where permitted). Current behavior is read/preview oriented while the “auto-GM” layer is being designed.

### open
Open a specific adventure graph node or the start of the adventure.
- **code** (string, required) – adventure code (e.g., `cos`, `ditlcot`)
- **node** (string, optional) – specific node key

*(Other utility subcommands like browse/search may exist in your tree; keep their help inline with your in-code registration.)*

---

## Reference Utilities

### /ref
Lightweight reference lookup into your rules/compendium index.

### /ask
RAG-backed Q&A across ingested rules and adventures.

### /bestiary
Monster lookup and statblock rendering.

---

## Quickstart Flows

1) **Spin up a new table**
   - `/party new name "The Copper Serpents" adventure AITFR`
   - `/session start note "Onboarding + hooks"`
   - `/party add name "Aegis"` → have the player post `!vsheet`
   - `/party add name "Sera"`  → have the player post `!vsheet`

2) **Track play**
   - `/gmlog events add type quest text "Accepted the job from Ismark" tags #barovia`
   - `/party stash add item "Gold Pieces" qty 25 unit gp`
   - `/gmlog rep add faction "Harpers" amount 2 trend improving notes "Returned stolen relic"`
   - `/gmlog notes add title "Leads" body "Madam Eva mentioned a wizard by the lake…" pin:true`

3) **Pause / resume**
   - `/session end note "Reached Vallaki; long rest"`
   - Later: `/session start note "Vallaki hooks"` then `/party roster` and pick up where you left off.

---

### Permissions & Visibility (future-ready)
All log/note/stash rows carry `visibility`, `allow_roles`, `allow_users` fields. Today: defaults mostly to `gm` or `players` and no enforcement. Tomorrow: add checks to filter who can view/modify based on Discord roles and explicit allow lists.

