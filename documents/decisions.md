# Architectural Decisions (ADR Log)

> Living record of key technical decisions for the D&D GM Bot. Each ADR captures context, the decision, alternatives considered, and when to revisit.

---

## ADR-001 — Party Identity & Scoping
**Status:** Accepted  
**Context:** Multiple parties can exist per guild/channel; members, logs, notes, stash, rep must scope to a specific party.  
**Decision:** Introduced `parties` table with surrogate `id` (party_id). All party-scoped tables reference `guild_id, channel_id, party_id`. Active party is tracked per channel.  
**Alternatives:** Composite PK `guild+channel+name`; rejected (renames are hard; foreign keys verbose).  
**Revisit:** If we support cross-channel parties or multi-channel campaigns.

---

## ADR-002 — Two-DB Split (Read-only RAG vs Read-write State)
**Status:** Accepted  
**Context:** Adventure content (RAG) is large, modified by offline ingests; party state changes live.  
**Decision:** Keep adventure DB(s) opened read-only (with `fileMustExist`, `readonly: true`); party state in a separate `party.db` read–write.  
**Alternatives:** Single DB; rejected (locks, blast radius, backup granularity).  
**Revisit:** If we move to a server DB (e.g., Postgres) or host multiple shards.

---

## ADR-003 — SQLite Pragmas & Concurrency
**Status:** Accepted  
**Decision:** Enable WAL + `synchronous=NORMAL` for `party.db`; set conservative timeouts; keep writes small and frequent.  
**Alternatives:** Journal `DELETE` (more blocking), or full client-server DB (overkill now).  
**Revisit:** If write contention grows (e.g., heavy auto-GM logging).

---

## ADR-004 — Schema Evolution via Code-first Migrations
**Status:** Accepted  
**Decision:** `ensurePartySchema()` & `ensurePartyLogSchema()` run on boot: create-if-missing and `ALTER TABLE ADD COLUMN` per need; add idempotent indices & unique constraints.  
**Alternatives:** External migration tool; deferred for simplicity.  
**Revisit:** When we introduce environments or need reversible migrations.

---

## ADR-005 — Vsheet Parsing Strategy
**Status:** Accepted  
**Context:** Avrae `!vsheet` appears as embeds or text; formats vary.  
**Decision:** "Loose" detector + tolerant regex parser; merge multi-line ability rows; keep raw payload in `data_json`.  
**Alternatives:** Strict schema or Avrae API (not available / brittle).  
**Revisit:** If Avrae changes formatting substantially.

---

## ADR-006 — Pending Vsheet Capture UX
**Status:** Accepted  
**Decision:** `/party update <name>` arms a 2‑minute window per `channelId::charName`; first matching vsheet is consumed and stored; name fallback uses pending or parsed header.  
**Alternatives:** Always-on listener (too noisy); reaction-based confirmation.  
**Revisit:** When supporting multi-character updates in bulk.

---

## ADR-007 — Stash Canonicalization & Uniqueness
**Status:** Accepted  
**Decision:** Normalize item (`trim/lower for matching; store canonical case`) and unit (empty string for "no unit"); unique index on `(guild_id, channel_id, party_id, item, unit)`; additive upsert for adds, clamp-on-remove, delete on zero.  
**Alternatives:** Free-form rows; rejected (duplication).  
**Revisit:** If we add item metadata (rarity, attunement, owner).

---

## ADR-008 — Reputation Matching (CI, Partial)
**Status:** Accepted  
**Decision:** Case-insensitive, token-inclusion matching for `/gmlog rep show faction <query>`; exact name still unique; notes/trend append semantics.  
**Alternatives:** Exact-only; rejected for UX.  
**Revisit:** If factions require canonical registry.

---

## ADR-009 — Explicit Sessions
**Status:** Accepted  
**Decision:** `/session start|end` drives `sessions` records; other commands may warn/limit without an active session; session carries context (title, adv_code, node_key, summary).  
**Alternatives:** Auto-start on activity; rejected to empower players to bracket sessions.  
**Revisit:** When introducing scheduled sessions or multi-table events.

---

## ADR-010 — GM Logs & Notes Visibility (Permissions‑Ready)
**Status:** Accepted  
**Decision:** All loggable artifacts (`gm_logs`, `party_notes`, `party_reputation`, `party_stash`) include `visibility`, `allow_roles`, `allow_users` for future ACLs. Default: GM/private for logs & notes; players for stash & rep.  
**Alternatives:** No visibility; rejected (future-proofing).  
**Revisit:** When building role-based policy.

---

## ADR-011 — /adv Gating & Strategy
**Status:** Accepted  
**Decision:** `/adv` is compendium/driver but does not run without an active `/session`; starting state and progress are tracked per party/session; adventure graph nodes are consumed by the Auto‑GM layer.  
**Alternatives:** Free-use `/adv open`; rejected (players fiddling).  
**Revisit:** When implementing the Auto‑GM controller.

---

## ADR-012 — Command Design & Registration
**Status:** Accepted  
**Decision:** Required options before optional (Discord constraint); grouped subcommands for `gmlog rep|notes|events|stash` (later moved stash to `/party stash`), descriptive replies are ephemeral by default.  
**Alternatives:** Flat commands; rejected for clutter.  
**Revisit:** As we add more flows.

---

## ADR-013 — Error Handling & Messaging
**Status:** Accepted  
**Decision:** Guard against missing rows; give actionable ephemeral errors; log stack traces server-side; avoid throwing raw SQLite errors at users.  
**Alternatives:** Silent failures; rejected.  
**Revisit:** Add structured error IDs and telemetry.

---

## ADR-014 — Title Normalization for Adventures
**Status:** Accepted  
**Decision:** Post‑ingest fixer matches filename acronym to JSON title; optional online verification against curated lists; logs when unable to verify or match.  
**Alternatives:** Manual curation only.  
**Revisit:** If we adopt a canonical adventure registry.

---

## ADR-015 — Observability & Debugging
**Status:** Accepted  
**Decision:** Targeted `console.warn` for weak vsheet parses; timing summaries for ingest; log DB migrations; avoid chat spam.  
**Revisit:** Switch to structured logs and per-guild debug levels.

---

## ADR-016 — Performance & Scale
**Status:** Accepted  
**Decision:** Keep statements prepared (hot paths); indexes for common lookups; small payloads; avoid long transactions; use epoch ms in integers.  
**Revisit:** If we exceed thousands of rows per table or add FTS.

---

## ADR-017 — Security & Privacy
**Status:** Accepted  
**Decision:** No external calls from runtime except optional title verification tool; store Discord IDs (no PII beyond usernames shown in-channel); visibility flags for future policy.  
**Revisit:** When introducing web dashboards or exports.

---

## ADR-018 — Data Retention & Cleanup
**Status:** Accepted  
**Decision:** No auto-purge yet; archives via `is_active=0` parties, ended sessions; logs persist.  
**Revisit:** Add pruning/archival and export/import later.

---

## ADR-019 — Search Semantics
**Status:** Accepted  
**Decision:** LIKE-based search over `gm_logs.content|tags` and `party_notes.title|body`; case-insensitive; unified `/gmlog search` shows both.  
**Alternatives:** FTS5 (planned).  
**Revisit:** When notes/logs volume warrants FTS.

---

## ADR-020 — Moving Stash to /party
**Status:** Accepted  
**Decision:** Stash management is a party concern; moved from `/gmlog` to `/party stash`; command replies now report resulting totals; partial unit inference preserved.  
**Revisit:** If we add per‑member inventories.

---

## ADR-021 — Time Representation
**Status:** Accepted  
**Decision:** Store timestamps as integer epoch ms; format with `<t:...:f>` in Discord as needed.  
**Revisit:** If we add time zones or scheduling.

---

## ADR-022 — Adventure Progress
**Status:** Proposed (partial)  
**Decision:** Track `adv_code`, `node_key`, and `milestones_json` per session; persist party-specific state (flags, discovered clues) in `party_notes`/`gm_logs` until dedicated `party_progress` table lands.  
**Revisit:** Before Auto‑GM ships.

---

## ADR-023 — Permissions Placeholder Strategy
**Status:** Accepted  
**Decision:** Write fields now (`visibility`, `allow_roles`, `allow_users`) even if enforcement is permissive; later, a policy layer will gate view/mutation based on user/role and scope (party, session).  
**Revisit:** When we implement role config commands.

---

## ADR-024 — Bot Feedback Style
**Status:** Accepted  
**Decision:** Ephemeral confirmations for administrative actions; richer, public narration will come from Auto‑GM only.  
**Revisit:** If players need to see certain bookkeeping publicly by default.

---

## ADR-025 — Duplicate Prevention & Canonicalization
**Status:** Accepted  
**Decision:** Use `UNIQUE` indices where sensible; normalize text tokens for matching (case-insensitive); show friendly errors on conflicts; consolidate rows instead of duplicating.  
**Revisit:** If we add internationalization.

---

## ADR-026 — Testing Approach
**Status:** Accepted  
**Decision:** Manual functional tests via Discord slash commands and representative data; step-by-step QA checklist in docs; focus on idempotency and schema survival across restarts.  
**Revisit:** Add scripted harness/mocks for CI as project grows.

---

## ADR-027 — Auto‑GM Controller (Roadmap)
**Status:** Planned  
**Decision:** Event-driven loop observing channel messages; uses session + party context, adventure graph, party facts (notes/rep/stash) to choose next narration & challenges; emits structured `gm_logs` automatically.  
**Revisit:** During implementation; likely generates ADRs for safety, pacing, and state checkpoints.

---

## ADR-028 — Title Verification (Online)
**Status:** Accepted (optional utility)  
**Decision:** Standalone Node script does best-effort HTTP check against curated sources to confirm acronym↔title mapping; logs unverifiable items without blocking ingest.  
**Revisit:** When we curate a local canonical list.

---

## ADR-029 — Error Classes & User Copy Consistency
**Status:** Accepted  
**Decision:** Consistent phrasing for missing-state errors (no active party/session), not-found (member, item, faction), and parse-warnings; all ephemeral.  
**Revisit:** Localize/brand voice later.

---

## ADR-030 — Data Shapes in Columns
**Status:** Accepted  
**Decision:** Keep both columnar fields for hot queries (AC, HP, PP, etc.) and full payload JSON blobs (`data_json`) for fidelity; prefer read paths that choose column then JSON fallback.  
**Revisit:** If we migrate to typed DB.

---

## Open Questions
- Should `party_progress` be its own table now (flags, discovered nodes, quest journal)?
- Do we want soft-deletes for notes/logs?
- Should we snapshot character sheets per session start?
- How do we expose visibility ACLs (role mapping, `/gm roles`)?

---

## Change Control
- Keep this ADR log in source (canvas/docs) and update when decisions change.  
- Reference ADR numbers in commit messages for related changes.


## Decision: High-signal persistence, transcript for narration
We do **not** persist every roll/event. Rationale:
• DB size & noise control; replays come from Avrae + summaries.
• We keep a per-combat transcript in memory (signal or full mode) and flush one summary to `gm_logs`.
• GPT summarizes from a cleaned transcript; if GPT is off or fails, heuristic summary is stored.
• Participants/outcome hints reduce hallucinations; Avrae is the dice authority.
Trade-offs considered: full persistence (rejected for size/noise), GPT-only (rejected for reliability).

