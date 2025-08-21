// ingest_adventures.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const OpenAI = require('openai');

const ADVENTURE_DIR   = process.env.ADVENTURE_DIR || path.join(process.cwd(), 'resources', 'adventure');
const RAG_DB_PATH     = process.env.RAG_DB || 'rules.db';
const EMBED_MODEL     = process.env.RAG_EMBED_MODEL || 'text-embedding-3-small';
const EMBED_BATCH     = parseInt(process.env.EMBED_BATCH || '64', 10);
const CHUNK_SIZE      = parseInt(process.env.ADV_CHUNK_SIZE || '1200', 10);

// Prefer 2024 sources when name clashes arise (used as hints on encounters/assets)
const PREFER_2024_SOURCES = new Set(['XMM', 'XPHB', 'XDMG']); // extend as needed

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ──────────────────────────────────────────────────────────────────────────
   5etools-ish helpers
────────────────────────────────────────────────────────────────────────── */
function expand5eInline(s) {
  if (!s) return '';
  let t = String(s);

  // Attack/Hit/DC/Damage
  t = t.replace(/\{@atk\s+([^}]+)\}/gi, (_, code) => {
    const parts = code.toLowerCase().split(/\s*,\s*/);
    const map = { mw:'Melee Weapon Attack', rw:'Ranged Weapon Attack', ms:'Melee Spell Attack', rs:'Ranged Spell Attack', m:'Melee Attack', r:'Ranged Attack' };
    return parts.map(p => map[p] || p).join(' or ') + ':';
  });
  t = t.replace(/\{@hit\s+([+-]?\d{1,2})\}/gi, (_, n) => {
    const v = parseInt(n, 10);
    return `${v >= 0 ? `+${v}` : v} to hit`;
  });
  t = t.replace(/\{@h\}/gi, 'Hit: ');
  t = t.replace(/\{@damage\s+([^}]+)\}/gi, (_, dmg) => dmg.trim());
  t = t.replace(/\{@dc\s+(\d{1,2})\}/gi, (_, n) => `DC ${n}`);

  // Link-ish tags: keep left side (label), drop pipes/source
  const SIMPLE = [
    'spell','item','condition','status','skill','book','adventure',
    'variantrule','class','subclass','background','feat','creature','filter'
  ];
  for (const tag of SIMPLE) {
    const re = new RegExp(`\\{@${tag}\\s+([^}|]+)(?:\\|[^}]+)?}`, 'gi');
    t = t.replace(re, '$1');
  }

  // Links/images/formatting
  t = t.replace(/\{@link\s+([^}|]+)\|[^}]+}/gi, '$1');
  t = t.replace(/\{@5etoolsImg\s+([^}|]+)\|[^}]+}/gi, '$1');
  t = t.replace(/\{@italics?\s+([^}]+)}/gi, '$1');
  t = t.replace(/\{@bold\s+([^}]+)}/gi, '$1');
  t = t.replace(/\{@b\s+([^}]+)}/gi, '$1');

  // Fallback: unknown tags → inner text
  t = t.replace(/\{@[^}]+}/g, m => m.replace(/^\{@[^ |}]+(?:\s+)?/, '').replace(/}$/, ''));
  return t.replace(/\s+/g, ' ').trim();
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function walkJsonFiles(dir) {
  const out = [];
  (function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && /\.json$/i.test(ent.name)) out.push(p);
    }
  })(dir);
  return out;
}

function chunkText(text, max = CHUNK_SIZE) {
  const clean = (text || '').replace(/\n{3,}/g, '\n\n');
  const out = [];
  let cur = '';
  for (const para of clean.split('\n')) {
    const p = para.trim();
    if (!p) { if (cur) { out.push(cur.trim()); cur = ''; } continue; }
    if ((cur + '\n' + p).length > max) { if (cur) out.push(cur.trim()); cur = p; }
    else cur = cur ? (cur + '\n' + p) : p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function embedBatch(inputs) {
  if (!inputs.length) return [];
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: inputs });
  return res.data.map(d => d.embedding);
}

/* ──────────────────────────────────────────────────────────────────────────
   SQLite (minimal, hardened schema) — keeps compatibility with books
────────────────────────────────────────────────────────────────────────── */
function openDB() {
  const db = new Database(RAG_DB_PATH);

  // Pragmas via API (safer than embedding in template strings)
  try { db.pragma('journal_mode = WAL'); } catch {}
  try { db.pragma('synchronous = NORMAL'); } catch {}
  try { db.pragma('busy_timeout = 5000'); } catch {}

  db.exec(`
    /* RAG vector table (shared with books) */
    CREATE TABLE IF NOT EXISTS docs(
      path TEXT NOT NULL,            -- e.g., 'adv:wdmm/node/0-3/gm/1'
      chunk_index INTEGER NOT NULL,  -- 0-based
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,       -- JSON array
      sha TEXT,                      -- SHA-256 of 'text'
      PRIMARY KEY (path, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);

    /* Adventure graph */
    CREATE TABLE IF NOT EXISTS adventures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,     -- file stem, e.g., 'adventure-wdmm'
      title TEXT NOT NULL,
      source TEXT,
      year INTEGER
    );

    CREATE TABLE IF NOT EXISTS adv_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adventure_id INTEGER NOT NULL,
      node_key TEXT NOT NULL,        -- stable traversal key, e.g., '0-3-2'
      parent_key TEXT,               -- parent's node_key
      type TEXT,                     -- chapter|section|location|area|scene
      name TEXT,
      page INTEGER,
      order_index INTEGER NOT NULL,  -- traversal order
      expected_min_level INTEGER,
      expected_max_level INTEGER,
      readaloud TEXT,                -- combined RA paragraphs
      gm_notes TEXT,                 -- combined non-RA text
      dc_calls TEXT,                 -- JSON array of parsed DC notes
      refs TEXT,                     -- JSON array of cross refs
      treasure TEXT,                 -- free text
      UNIQUE (adventure_id, node_key),
      FOREIGN KEY (adventure_id) REFERENCES adventures(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_adv_nodes_adv     ON adv_nodes(adventure_id);
    CREATE INDEX IF NOT EXISTS idx_adv_nodes_key     ON adv_nodes(node_key);
    CREATE INDEX IF NOT EXISTS idx_adv_nodes_parent  ON adv_nodes(adventure_id, parent_key);
    CREATE INDEX IF NOT EXISTS idx_adv_nodes_order   ON adv_nodes(adventure_id, order_index);

    CREATE TABLE IF NOT EXISTS adv_encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adventure_id INTEGER NOT NULL,
      node_key TEXT NOT NULL,
      name TEXT,
      kind TEXT,                     -- combat|social|hazard|skill
      creatures TEXT,                -- JSON array [{name, qty, source_hint}]
      setup TEXT,
      tactics TEXT,
      developments TEXT,
      rewards TEXT,
      FOREIGN KEY (adventure_id) REFERENCES adventures(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_adv_encounters_node ON adv_encounters(adventure_id, node_key);

    CREATE TABLE IF NOT EXISTS adv_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adventure_id INTEGER NOT NULL,
      node_key TEXT NOT NULL,
      type TEXT,                     -- map|image|handout|table
      title TEXT,
      path TEXT,
      player_safe INTEGER DEFAULT 0,
      meta TEXT,                     -- JSON
      FOREIGN KEY (adventure_id) REFERENCES adventures(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_adv_assets_node ON adv_assets(adventure_id, node_key);

    CREATE TABLE IF NOT EXISTS adv_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adventure_id INTEGER NOT NULL,
      name TEXT,
      kind TEXT,                     -- main|side|secret
      text TEXT,
      prereqs TEXT,                  -- JSON array
      completes_on TEXT,             -- JSON array
      rewards TEXT,
      FOREIGN KEY (adventure_id) REFERENCES adventures(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_adv_objectives_adv ON adv_objectives(adventure_id);

    CREATE TABLE IF NOT EXISTS adv_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adventure_id INTEGER NOT NULL,
      node_key TEXT NOT NULL,
      when_type TEXT,                -- renamed from 'when' (reserved-ish)
      condition TEXT,
      effect TEXT,
      FOREIGN KEY (adventure_id) REFERENCES adventures(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_adv_triggers_node ON adv_triggers(adventure_id, node_key);
  `);

  return db;
}


/* ──────────────────────────────────────────────────────────────────────────
   Adventure JSON → Graph (nodes/encounters/assets) with stable keys
────────────────────────────────────────────────────────────────────────── */

/** Gather arrays to iterate as roots — different adventures vary a bit */
function getAdventureRoots(json) {
  if (Array.isArray(json?.adventure)) return json.adventure;
  if (json?.adventure && typeof json.adventure === 'object') return [json.adventure];
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json)) return json;
  return [json];
}

/** Extract top-level metadata */
function readAdventureMeta(filePath, rootObj) {
  const code = path.basename(filePath).replace(/\.json$/i, '');
  const title = rootObj?.name || rootObj?.title || code;
  const source = rootObj?.source || rootObj?._source || rootObj?.shortName || '';
  const year = (() => {
    const y = (rootObj?.published || rootObj?.release || '').toString().match(/\b(20\d{2})\b/);
    return y ? parseInt(y[1], 10) : null;
  })();
  return { code, title, source, year };
}

/** Detect & collect read-aloud blocks from a node subtree */
function collectReadAloud(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (node.type && /insetreadaloud/i.test(node.type)) {
    const ra = expand5eInline(node.entries || node.text || node.name || node.caption || '');
    if (ra) acc.push(ra);
  }
  const kids = node.entries || node.items || node.content || node.sections || node.blocks || node.children || [];
  if (Array.isArray(kids)) for (const k of kids) collectReadAloud(k, acc);
}

/** Tables → plain lines */
function linesFromTable(tbl) {
  if (!tbl || typeof tbl !== 'object') return [];
  const name = tbl.caption || tbl.name || tbl.title || 'Table';
  const head = Array.isArray(tbl.colLabels) ? tbl.colLabels.map(expand5eInline).join(' | ') : '';
  const rows = Array.isArray(tbl.rows)
    ? tbl.rows.map(r => (Array.isArray(r) ? r : [r]).map(expand5eInline).join(' | '))
    : [];
  const out = [`${name}`, head ? head : ''];
  return out.concat(rows).filter(Boolean);
}

/** Detect images/maps/handouts/tables */
function collectAssets(node, acc) {
  if (!node || typeof node !== 'object') return;

  // Images/maps
  if ((node.type && /image/i.test(node.type)) || node.imageType || node.href?.path || node.path) {
    const title = expand5eInline(node.title || node.name || '');
    const p = node.href?.path || node.path || '';
    const isMap = (node.imageType || '').toLowerCase() === 'map' || /map/i.test(title);
    const playerSafe = /player/i.test(title || '') || node.isPlayer === true ? 1 : 0;
    acc.push({
      type: isMap ? 'map' : 'image',
      title, path: p, player_safe: playerSafe,
      meta: { imageType: node.imageType || null }
    });
  }

  // Tables
  if (node.type && /table/i.test(node.type)) {
    linesFromTable(node).forEach((line, i) => {
      acc.push({
        type: 'table',
        title: (node.caption || node.name || node.title || 'Table') + ` (${i === 0 ? 'meta' : 'row'})`,
        path: null,
        player_safe: 0,
        meta: { text: line }
      });
    });
  }

  const kids = node.entries || node.items || node.content || node.sections || node.blocks || node.children || [];
  if (Array.isArray(kids)) for (const k of kids) collectAssets(k, acc);
}

/** Very light DC mining + refs */
const SKILL_WORDS = [' Acrobatics',' Animal Handling',' Arcana',' Athletics',' Deception',' History',' Insight',' Intimidation',' Investigation',' Medicine',' Nature',' Perception',' Performance',' Persuasion',' Religion',' Sleight of Hand',' Stealth',' Survival'];
const SKILL_RE = new RegExp(`\\b(${SKILL_WORDS.map(s => s.trim()).join('|')})\\b`, 'i');
function mineSignalsFromText(t) {
  const dcHits = [];
  const refs = [];

  const text = t || '';
  // DCs
  const reDC = /\bDC\s*(\d{1,2})\b(?:[^.\n]*?\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\b)?(?:[^.\n]*?\b(Save|Saving Throw|Check))?/gi;
  let m;
  while ((m = reDC.exec(text)) !== null) {
    const dc = parseInt(m[1], 10);
    const ability = (m[2] || '').toUpperCase();
    const kind = (m[3] || '').toLowerCase();
    const skill = (text.slice(Math.max(0, m.index - 40), m.index + 40).match(SKILL_RE) || [null])[1];
    dcHits.push({ dc, ability, kind, skill });
  }

  // Heuristically record common source shorthands
  const refRE = /\b(PHB|DMG|MM|XPHB|XDMG|XMM|TCoE|Xanathar|RotFM|RotF|WDMM|ToFW)\b/g;
  while ((m = refRE.exec(text)) !== null) refs.push(m[1]);

  return { dcHits, refs: Array.from(new Set(refs)) };
}

/** Collect encounters by scanning readable blocks. */
function collectEncounters(node, acc) {
  if (!node || typeof node !== 'object') return;

  const nm = expand5eInline(node.name || node.title || '');
  const rawBlockText = (() => {
    const items = [];
    const arr = node.entries || node.items || node.content || [];
    if (Array.isArray(arr)) {
      for (const it of arr) {
        if (typeof it === 'string') items.push(expand5eInline(it));
        else if (it && typeof it === 'object') {
          if (typeof it.text === 'string') items.push(expand5eInline(it.text));
          if (typeof it.entries === 'string') items.push(expand5eInline(it.entries));
          if (Array.isArray(it.entries)) items.push(it.entries.map(expand5eInline).join(' '));
        }
      }
    }
    return items.filter(Boolean).join('\n');
  })();

  // Pull creature-like capitalized terms (very forgiving)
  const creatureNameRE = /\b([A-Z][a-z]+(?: [A-Z][a-z]+)*)\b/g;
  const creatures = [];
  let m;
  while ((m = creatureNameRE.exec(rawBlockText)) !== null) {
    const name = m[1];
    if (/^(Chapter|Part|Area|Room|Map|Treasure|Dungeon|Statblock|Appendix|Figure)$/.test(name)) continue;
    creatures.push({ name, qty: 1, source_hint: null });
  }

  const parts = { setup: '', tactics: '', developments: '', rewards: '' };
  const labeledRE = /\*\*(Tactics|Developments|Treasure|Rewards|Setup)\.\*\s*([^]*?)(?=\n\*\*|$)/gi;
  let mm;
  while ((mm = labeledRE.exec(rawBlockText)) !== null) {
    const key = mm[1].toLowerCase();
    const val = mm[2].trim();
    if (key === 'treasure' || key === 'rewards') parts.rewards += (parts.rewards ? '\n' : '') + val;
    else if (key === 'setup') parts.setup += (parts.setup ? '\n' : '') + val;
    else parts[key] += (parts[key] ? '\n' : '') + val;
  }
  if (!parts.setup && !parts.tactics && !parts.developments && !parts.rewards && rawBlockText) {
    parts.setup = rawBlockText;
  }

  if (creatures.length || parts.setup || parts.tactics || parts.developments) {
    acc.push({
      name: nm || 'Encounter',
      kind: 'combat',
      creatures: mergeCreatureList(creatures),
      setup: parts.setup || null,
      tactics: parts.tactics || null,
      developments: parts.developments || null,
      rewards: parts.rewards || null
    });
  }

  const kids = node.entries || node.items || node.content || node.sections || node.blocks || node.children || [];
  if (Array.isArray(kids)) for (const k of kids) collectEncounters(k, acc);
}

function mergeCreatureList(arr) {
  const by = new Map();
  for (const c of arr) {
    const key = c.name.toLowerCase();
    if (!by.has(key)) by.set(key, { name: c.name, qty: 0, source_hint: c.source_hint || null });
    by.get(key).qty += c.qty || 1;
  }
  return Array.from(by.values());
}

/** Traverse adventure tree and emit nodes */
function traverseAdventureTree(root, onNode) {
  function walk(node, parentKey, pathIdx = []) {
    const type = String(node?.type || '').toLowerCase();
    const name = expand5eInline(node?.name || node?.title || node?.caption || '');
    const page = Number.isFinite(node?.page) ? node.page : null;

    const kids = node?.entries || node?.items || node?.content || node?.sections || node?.blocks || node?.children || [];
    const shouldEmit = name || /chapter|section|entries/i.test(type);

    if (shouldEmit) {
      const nodeKey = pathIdx.join('-');
      const parent = parentKey || null;

      const readaloud = [];
      collectReadAloud(node, readaloud);

      const assets = [];
      collectAssets(node, assets);

      // GM notes (non-RA)
      const gmBits = [];
      function collectGM(nodeX) {
        if (!nodeX || typeof nodeX !== 'object') return;
        if (nodeX.type && /insetreadaloud/i.test(nodeX.type)) return;
        const fields = [];
        if (typeof nodeX.text === 'string') fields.push(expand5eInline(nodeX.text));
        if (typeof nodeX.entries === 'string') fields.push(expand5eInline(nodeX.entries));
        if (Array.isArray(nodeX.entries)) fields.push(nodeX.entries.map(expand5eInline).join(' '));
        if (typeof nodeX.caption === 'string') fields.push(expand5eInline(nodeX.caption));
        if (typeof nodeX.summary === 'string') fields.push(expand5eInline(nodeX.summary));
        const joined = fields.filter(Boolean).join('\n').trim();
        if (joined) gmBits.push(joined);
        const kids2 = nodeX.entries || nodeX.items || nodeX.content || nodeX.sections || nodeX.blocks || nodeX.children || [];
        if (Array.isArray(kids2)) for (const k of kids2) collectGM(k);
      }
      collectGM(node);

      const gmText = gmBits.join('\n').trim();
      const { dcHits, refs } = mineSignalsFromText(gmText + '\n' + readaloud.join('\n'));

      const encounters = [];
      collectEncounters(node, encounters);

      onNode({
        nodeKey,
        parentKey: parent,
        type: type || (kids && kids.length ? 'section' : 'scene'),
        name: name || '(untitled)',
        page,
        readaloud,
        gmText,
        dcHits,
        refs: Array.from(new Set(refs)),
        assets,
        encounters
      });
    }

    if (Array.isArray(kids)) {
      kids.forEach((child, i) => walk(child, shouldEmit ? pathIdx.join('-') : parentKey, pathIdx.concat(i)));
    }
  }
  walk(root, null, [0]); // root starts at [0]
}

/* ──────────────────────────────────────────────────────────────────────────
   Ingest runner (batching, SHA skipping, no long write transactions)
────────────────────────────────────────────────────────────────────────── */
(async () => {
  const db = openDB();

  const selAdvByCode = db.prepare(`SELECT id FROM adventures WHERE code = ?`);
  const insAdv = db.prepare(`
    INSERT INTO adventures(code, title, source, year)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET title=excluded.title, source=excluded.source, year=excluded.year
  `);

  const delNodes   = db.prepare(`DELETE FROM adv_nodes      WHERE adventure_id = ?`);
  const delEnc     = db.prepare(`DELETE FROM adv_encounters WHERE adventure_id = ?`);
  const delAssets  = db.prepare(`DELETE FROM adv_assets     WHERE adventure_id = ?`);
  const delObj     = db.prepare(`DELETE FROM adv_objectives WHERE adventure_id = ?`);
  const delTrig    = db.prepare(`DELETE FROM adv_triggers   WHERE adventure_id = ?`);

  const insNode = db.prepare(`
    INSERT INTO adv_nodes(adventure_id, node_key, parent_key, type, name, page, order_index,
                          expected_min_level, expected_max_level,
                          readaloud, gm_notes, dc_calls, refs, treasure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insEnc = db.prepare(`
    INSERT INTO adv_encounters(adventure_id, node_key, name, kind, creatures, setup, tactics, developments, rewards)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insAsset = db.prepare(`
    INSERT INTO adv_assets(adventure_id, node_key, type, title, path, player_safe, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // docs table reuse
  const selDocShas   = db.prepare(`SELECT chunk_index, sha FROM docs WHERE path LIKE ?`);
  const upsertDoc    = db.prepare(`INSERT OR REPLACE INTO docs(path, chunk_index, text, embedding, sha) VALUES (?, ?, ?, ?, ?)`);
  const delStaleDocs = db.prepare(`DELETE FROM docs WHERE path LIKE ? AND chunk_index >= ?`);

  // Upsert many docs in a short transaction
  const upsertDocBatch = db.transaction((rows) => {
    for (const r of rows) {
      upsertDoc.run(r.pathKey, r.idx, r.text, r.embeddingJson, r.sha);
    }
  });

  const files = walkJsonFiles(ADVENTURE_DIR);
  console.log(`Found ${files.length} adventure file(s) in ${ADVENTURE_DIR}`);

  // SIGINT graceful stop
  let abort = false;
  process.once('SIGINT', () => {
    abort = true;
    console.log('\nSIGINT received — will stop after the current adventure.');
  });

  for (const f of files) {
    if (abort) break;

    let json;
    try {
      json = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      console.warn('Skip bad JSON:', f, e.message);
      continue;
    }

    const roots = getAdventureRoots(json);
    if (!roots.length) { console.warn('No adventure roots found:', f); continue; }

    // Use first root for meta
    const meta = readAdventureMeta(f, roots[0]);
    console.log(`\n• ${meta.code} — "${meta.title}" [${meta.source || 'source?'} ${meta.year || ''}]`);
    console.time(`ingest:${meta.code}`);

    // Build graph in a short transaction
    db.exec('BEGIN IMMEDIATE');
    let advId;
    try {
      insAdv.run(meta.code, meta.title, meta.source || null, meta.year || null);
      advId = selAdvByCode.get(meta.code).id;

      delNodes.run(advId);
      delEnc.run(advId);
      delAssets.run(advId);
      delObj.run(advId);
      delTrig.run(advId);

      const nodes = [];
      roots.forEach((r, ridx) => {
        traverseAdventureTree(r, (n) => nodes.push({ ...n, _root: ridx }));
      });

        function keyWithRoot(rootIdx, key) {
        return key == null ? null : `${rootIdx}-${key}`;
        }


      nodes.forEach((n, i) => {
        // make keys unique across roots
        const nodeKey   = keyWithRoot(n._root, n.nodeKey);
        const parentKey = n.parentKey ? keyWithRoot(n._root, n.parentKey) : null;

        insNode.run(
            advId,
            nodeKey,                     // << prefixed
            parentKey,                   // << prefixed
            n.type,
            n.name,
            Number.isFinite(n.page) ? n.page : null,
            i,
            null, null,                  // expected level band (unused for now)
            n.readaloud.join('\n').trim() || null,
            n.gmText || null,
            JSON.stringify(n.dcHits || []),
            JSON.stringify(n.refs || []),
            null                         // treasure
        );

        // Encounters
        for (const e of (n.encounters || [])) {
            for (const c of e.creatures || []) c.source_hint = c.source_hint || null;
            insEnc.run(
            advId,
            nodeKey,                   // << prefixed
            e.name || null,
            e.kind || 'combat',
            JSON.stringify(e.creatures || []),
            e.setup || null,
            e.tactics || null,
            e.developments || null,
            e.rewards || null
            );
        }

        // Assets
        for (const a of (n.assets || [])) {
            insAsset.run(
            advId,
            nodeKey,                   // << prefixed
            a.type || 'image',
            a.title || null,
            a.path || null,
            a.player_safe ? 1 : 0,
            JSON.stringify(a.meta || {})
            );
        }
        });


      db.exec('COMMIT');
      console.log(`   graph: ${nodes.length} node(s), encounters & assets inserted/merged.`);
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`   ERROR building graph for ${meta.code}:`, e.stack || e.message);
      continue;
    }

    // ── RAG embeddings per node (SHA-skip + batching)
    const advNs = `adv:${meta.code}/`;

    // Embed helper that never holds a write tx across awaits
    async function embedRoleForNode(nodeKey, role, text) {
      if (!text) return { embedded: 0, skipped: 0, deleted: 0 };
      const chunks = chunkText(text, CHUNK_SIZE);
      const pathPrefix = `${advNs}node/${nodeKey}/${role}/`;
      const existing = new Map();
      for (const row of selDocShas.all(`${pathPrefix}%`)) {
        existing.set(row.chunk_index, row.sha || null);
      }

      const toEmbedIdx = [];
      const toEmbedTxt = [];
      const toEmbedSha = [];
      for (let i = 0; i < chunks.length; i++) {
        const digest = sha256(chunks[i]);
        if (existing.get(i) === digest) continue;
        toEmbedIdx.push(i);
        toEmbedTxt.push(chunks[i]);
        toEmbedSha.push(digest);
      }

      // Batch embed (network) — no DB writes here
      let embedded = 0;
      for (let i = 0; i < toEmbedTxt.length; i += EMBED_BATCH) {
        const batchTxt = toEmbedTxt.slice(i, i + EMBED_BATCH);
        const batchIdx = toEmbedIdx.slice(i, i + EMBED_BATCH);
        const batchSha = toEmbedSha.slice(i, i + EMBED_BATCH);

        const embs = await embedBatch(batchTxt);

        // Now do the DB writes in one short tx
        const rows = [];
        for (let j = 0; j < batchTxt.length; j++) {
          rows.push({
            pathKey: `${pathPrefix}${batchIdx[j] + 1}`,
            idx: batchIdx[j],
            text: batchTxt[j],
            embeddingJson: JSON.stringify(embs[j]),
            sha: batchSha[j]
          });
        }
        upsertDocBatch(rows);
        embedded += rows.length;
      }

      // Delete stale trailing chunks if shrank (single quick write)
      const delInfo = delStaleDocs.run(`${pathPrefix}%`, chunks.length);
      const deleted = delInfo?.changes || 0;
      const skipped = chunks.length - embedded;
      return { embedded, skipped, deleted };
    }

    // Stream nodes and embed sequentially (single connection)
    const selNodesForAdv = db.prepare(`
      SELECT node_key, readaloud, gm_notes
      FROM adv_nodes
      WHERE adventure_id = ?
      ORDER BY order_index ASC
    `);

    let totalEmbedded = 0, totalSkipped = 0, totalDeleted = 0;
    try {
      const rows = selNodesForAdv.all(advId);
      for (const row of rows) {
        if (abort) break;
        const k = row.node_key;

        const ra = await embedRoleForNode(k, 'ra', row.readaloud);
        const gm = await embedRoleForNode(k, 'gm', row.gm_notes);

        totalEmbedded += (ra.embedded + gm.embedded);
        totalSkipped  += (ra.skipped  + gm.skipped);
        totalDeleted  += (ra.deleted  + gm.deleted);
      }
    } catch (e) {
      console.error(`   ERROR embedding ${meta.code}:`, e.stack || e.message);
    }

    console.timeEnd(`ingest:${meta.code}`);
    console.log(`   embeddings: +${totalEmbedded}  skipped:${totalSkipped}  stale-deleted:${totalDeleted}`);
  }

  console.log('\nDone.');
})();
