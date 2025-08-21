# Project Roadmap — Auto‑GM for Discord (D&D)

> **End Goal**: A largely hands‑off, session‑gated Auto‑GM that listens to a Discord channel, understands player and Avrae activity, narrates scenes, presents choices, tracks state (party/session/adventure), and advances the story. Dice and mechanical resolution remain with Avrae/players; Auto‑GM generates copy‑paste combat lines and adjudication guidance.

---

## 1) Vision & Success Criteria

### What “Auto‑GM v1.0” does
- Reacts only during an active **/session start**.
- Follows a party’s **adventure graph** (from `ingest-adventure.js`), maintains scene state, presents choices (durable buttons), and narrates results.
- Understands **common Avrae outputs** (rolls, attacks, initiative, rests) and **player intents** (IC/OOC/action/GM-asks).
- Pulls rules/monster/item info from local resources (RAG/bestiary) and **party state** (sheets, stash, reputation, notes, quests).
- Produces clear, theatrical narration and **copy/paste lines** for combat.

### Observable success
- Sessions finish with an auto‑generated **Recap** and **Summary**.
- Players can traverse a published adventure with minimal manual GM UI.
- Errors, rate‑limits, and ambiguous inputs are resolved gracefully.

---

## 2) Guiding Principles
- **Session‑first**: Auto‑GM is dormant unless a session is active.
- **Fail-safe**: Prefer asking a concise clarifying question over guessing wildly.
- **Traceable**: Always log why/what happened (`gm_logs`, notes, debug stream).
- **Composable**: Keep state in DB tables; keep the model’s prompt thin and deterministic.

---

## 3) Current Foundation (see other docs)
- Party & member management (`/party`), Avrae **!vsheet** import, **stash**, **reputation**, **notes**, sessions (`/session`), and GM logging (`/gmlog`).
- Adventures ingested into SQLite (nodes, links, encounters, assets).
- Canonical docs: `ARCHITECTURE.md`, `DB_SCHEMA.sql`, `STATEMENTS.md`, `COMMANDS.md`, `SESSION_MODEL.md`, `GM_LOGS.md`, `DECISIONS.md`, `TEST_CHECKLIST.md`, `GPT_INSTRUCTIONS.md`.

---

## 4) Phased Roadmap

### Phase 0 — Hardening & QA (baseline)
- **Schema cleanup**: finalize migrations; unique indexes; WAL pragmas.
- **Permissions placeholders**: `visibility`, `allow_roles`, `allow_users` everywhere.
- **Test pass**: run `TEST_CHECKLIST.md` end‑to‑end.
- **Docs up‑to‑date**: keep canonical docs in sync.

**Exit**: Stable CRUD for party/session/stash/rep/notes; no schema drift.

---

### Phase 1 — Event Sensing & Intent Understanding
- **Detectors**: parsers for Avrae messages: ability/skill checks, attacks/damage/crit, saves, initiative blocks, rests, death saves, heal.
- **Generic roll inference**: map `!roll`/freeform to likely context (Stealth, Perception, etc.).
- **Intent classifier**: IC talk vs. OOC vs. table question vs. declared action; GM‑directed mentions.
- **Choice hooks**: durable button/select handlers tied to current node.

**Deliverables**: Detector utilities + unit tests; `gm_logs` instrumentation.

---

### Phase 2 — Scene & Flow Control
- **Scene state machine** per session: current node, phase (hook/explore/challenge/social/combat/wrap‑up), breadcrumb stack, beat tracker (spotlight).
- **Choice resolver**: map button clicks/short text decisions → outgoing links; write to `gm_logs` and advance node.
- **Timekeeping**: in‑world clock, travel/rest durations, spell/light timers.

**Deliverables**: `sessions.scene_state` JSON; helpers to load/save/advance.

---

### Phase 3 — Knowledge & Retrieval Glue
- **Rules RAG** for SRD/DMG lookups (grapple, cover, environment, DCs).
- **Adventure adapter**: normalize node types (narrative/choice/combat/hazard/puzzle/loot), outcomes (success/failure/partial), and fallbacks (nearest relevant node when off‑script).
- **Compendiums**: bestiary & items quick access + templated stat blocks.

**Deliverables**: Thin retrieval API used by the Auto‑GM planner.

---

### Phase 4 — Memory‑Rich Party State
- **Quests/Objectives**: goals, steps, status.
- **NPC Registry**: name, role, location, tags, relationship score, last interaction.
- **Location Registry**: places visited, discoveries, hazards, keys/locks.
- **Clue Board**: clues with source & confidence.
- **Progress Clocks**: 4/6/8‑tick meters for chases/heists/investigations.

**Deliverables**: New tables + `/gmlog` and passive auto‑updates.

---

### Phase 5 — Narration & UX
- **Response policy**: when Auto‑GM speaks (direct address, action resolution, node narration, choice prompts) + cooldowns/batching.
- **Presentation**: public narration; ephemerals/DMs for secrets; combat/downtime threads.
- **Recaps**: auto “Session Start Recap” and “Session End Summary”.

**Deliverables**: Reusable narration templates; whisper helper.

---

### Phase 6 — Safety, Permissions & Controls
- **Session gating**: engage only during `/session start`; `/session pause/resume`.
- **RBAC (future‑ready)**: wire `visibility/allow_*` to roles/users.
- **Manual overrides**: `/gm pause|resume|nudge|setnode|rewind|retcon`.
- **Tone & boundaries**: lines/veils stored in campaign metadata.

**Deliverables**: Admin utilities + enforcement hooks.

---

### Phase 7 — Pacing & Encounter Building
- **Encounter templating**: from node → monsters/terrain; compute APL & difficulty; emit boxed text + combat copy/paste.
- **Skill challenge framework**: success/failure tracks, suggested skills, consequences.

**Deliverables**: Builders + message composers.

---

### Phase 8 — Observability & Debug
- **GM debug stream** (private/ephemeral): detected intent, chosen node, DCs, reasons.
- **Telemetry**: rate‑limit awareness; aggregate rapid Avrae events per round.

**Deliverables**: Toggleable debug channel; structured logs.

---

### Phase 9 — Whispering & Passive Checks
- **Whispers**: secrets to individuals; fallback to ephemeral if DMs closed.
- **Passive triggers**: compare scene DCs vs. stored PP; auto‑notify successes; log outcomes.

**Deliverables**: `sendWhisper()` utility; passive check engine.

---

### Phase 10 — Data Hygiene & Resilience
- **Multi‑party/thread**: carry session/party context into side threads (e.g., combat).
- **Ambiguity handling**: quick disambiguation prompts with buttons.
- **Persistence**: guard against crashes; idempotent handlers.

**Deliverables**: Context propagation + defensive coding patterns.

---

## 5) Minimal Next Additions (Pre‑Auto‑GM)
1. Detectors for Avrae rolls/initiative/rests + lightweight intent classifier.
2. `sessions.scene_state` JSON with phase, node, beats, pending choices.
3. Add Quest/NPC/Location/Clue/Clock tables and simple CLI via `/gmlog`.
4. `sendWhisper()` helper with DM→ephemeral fallback.
5. Auto‑recap at session start/end.
6. Choice UI helper + resolver wiring to the adventure graph.

---

## 6) Integration Constraints & Tactics
- **Avrae**: read‑only; parse embeds; **emit copy/paste** lines for players (attacks, damage, saves). Do not attempt to command Avrae.
- **RAG**: prefer local corpora; short, cited snippets; cache frequent lookups.
- **Rate limits**: batch noisy turns; debounce reactions; respect cooldowns.

---

## 7) Risks & Mitigations
- **Ambiguous inputs** → Ask concise clarifying question with buttons.
- **Schema drift** → Centralize migrations; keep `DB_SCHEMA.sql` authoritative.
- **Prompt bloat** → Keep prompts modular; store state in DB, not in context.
- **Performance** → Pre‑index lookups; reuse prepared statements.

---

## 8) Metrics
- Session runtime; narration/choice latency; number of clarifications;
- Completion rate of nodes; combat round duration; error counts;
- Player satisfaction (simple `/gmlog feedback`).

---

## 9) Testing Strategy (see `TEST_CHECKLIST.md`)
- Unit tests for detectors/parsers; integration tests for scene advance;
- Replay transcripts; property‑based tests for choice resolution; soak tests for rate‑limits.

---

## 10) Timeline (suggested)
- **Sprint 1–2**: Phase 0–1
- **Sprint 3**: Phase 2 (scene state) + 5 (recaps)
- **Sprint 4**: Phase 3 (RAG) + 4 (NPC/Quest/Location)
- **Sprint 5**: Phase 7 (encounters/skill challenges)
- **Sprint 6**: Phase 8–10 (debug/whispers/hardening)

---

## 11) Open Decisions (see `DECISIONS.md`)
- DC selection policy (flat SRD vs. scene‑informed variance).
- How aggressively to auto‑narrate vs. wait for explicit @GM signals.
- Combat scope: minimal narration only vs. full round‑by‑round pacing.
- Long‑term RBAC model; multi‑guild campaign sharing.

---

## 12) Ownership & Tracking
- **Owner**: Auto‑GM lead
- **Backlog**: Issues labeled by Phase (1..10) + type (detector, UX, RAG, schema)
- **Docs**: Keep this Roadmap, Decisions, and Instructions current after each sprint.

