// ingest-books.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const OpenAI = require('openai');

const BOOK_DIR         = process.env.BOOK_DIR || path.join(process.cwd(), 'resources', 'book');
const RAG_DB_PATH      = process.env.RAG_DB || 'rules.db';
const EMBED_MODEL      = process.env.RAG_EMBED_MODEL || 'text-embedding-3-small'; // default to SMALL
const EMBED_BATCH      = parseInt(process.env.EMBED_BATCH || '64', 10);            // batch size
const BOOK_CHUNK_SIZE  = parseInt(process.env.BOOK_CHUNK_SIZE || '1200', 10);      // chars per chunk

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------------
   5etools inline expander
------------------------ */
function expand5eInline(s) {
  if (!s) return '';
  let t = String(s);

  // Attack/Hit/DC/Damage
  t = t.replace(/\{@atk\s+([^}]+)\}/gi, (_, code) => {
    const parts = code.toLowerCase().split(/\s*,\s*/);
    const map = { mw:'Melee Weapon Attack', rw:'Ranged Weapon Attack', ms:'Melee Spell Attack', rs:'Ranged Spell Attack', m:'Melee Attack', r:'Ranged Attack' };
    return parts.map(p => map[p] || p).join(' or ') + ':';
  });
  t = t.replace(/\{@hit\s+([+-]?\d{1,2})\}/gi, (_, n) => `${parseInt(n,10) >= 0 ? `+${parseInt(n,10)}` : n} to hit`);
  t = t.replace(/\{@h\}/gi, 'Hit: ');
  t = t.replace(/\{@damage\s+([^}]+)\}/gi, (_, dmg) => dmg.trim());
  t = t.replace(/\{@dc\s+(\d{1,2})\}/gi, (_, n) => `DC ${n}`);

  // Common link-ish tags → keep the label, drop pipes/source
  const SIMPLE = [
    'spell','item','condition','status','skill','book',
    'adventure','variantrule','class','subclass','background','feat',
    'creature','filter'
  ];
  for (const tag of SIMPLE) {
    const re = new RegExp(`\\{@${tag}\\s+([^}|]+)(?:\\|[^}]+)?}`, 'gi');
    t = t.replace(re, '$1');
  }

  // Links / images / formatting
  t = t.replace(/\{@link\s+([^}|]+)\|[^}]+}/gi, '$1');
  t = t.replace(/\{@5etoolsImg\s+([^}|]+)\|[^}]+}/gi, '$1');
  t = t.replace(/\{@italics?\s+([^}]+)}/gi, '$1');
  t = t.replace(/\{@bold\s+([^}]+)}/gi, '$1');
  t = t.replace(/\{@b\s+([^}]+)}/gi, '$1');

  // Fallback: strip unknown {@...} to inner text
  t = t.replace(/\{@[^}]+}/g, m => m.replace(/^\{@[^ |}]+(?:\s+)?/, '').replace(/}$/, ''));
  return t.replace(/\s+/g, ' ').trim();
}

/* ------------------------
   JSON walkers / formatters
------------------------ */
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

function linesFromTable(tbl) {
  if (!tbl || typeof tbl !== 'object') return [];
  const name = tbl.caption || tbl.name || tbl.title || 'Table';
  const head = Array.isArray(tbl.colLabels) ? tbl.colLabels.map(expand5eInline).join(' | ') : '';
  const rows = Array.isArray(tbl.rows)
    ? tbl.rows.map(r => (Array.isArray(r) ? r : [r]).map(expand5eInline).join(' | '))
    : [];
  const out = [`${name}`, head ? head : ''];
  return out.concat(rows);
}

// Recursively flatten a book node to plain text sections (with pages + images/galleries)
function flattenEntries(node, acc) {
  if (node == null) return;

  if (typeof node === 'string') {
    const t = expand5eInline(node);
    if (t) acc.push(t);
    return;
  }

  if (Array.isArray(node)) { for (const it of node) flattenEntries(it, acc); return; }

  const t = (node.type || '').toLowerCase();
  const name = expand5eInline(node.name || node.caption || '');
  const heading = name ? `# ${name}${node.page != null ? ` (p. ${node.page})` : ''}` : '';

  // Containers
  if (['section','chapter','entries','inset','variant','quote','insetReadaloud'].includes(t)) {
    if (heading) acc.push(heading);
    flattenEntries(node.entries || node.items || node.content || [], acc);
    return;
  }

  // Lists
  if (t === 'list' && Array.isArray(node.items)) {
    if (heading) acc.push(heading);
    node.items.forEach(it => {
      const body = it && typeof it === 'object'
        ? (it.name ? `${it.name}. ${it.entry || it.entries || ''}` : (it.entry || it.entries || ''))
        : it;
      acc.push('• ' + expand5eInline(body));
    });
    return;
  }

  // Tables
  if (t === 'table') {
    if (heading) acc.push(heading);
    linesFromTable(node).forEach(line => line && acc.push(line));
    return;
  }

  // Galleries / Images (DMG maps, tracking sheets)
  if (t === 'gallery' && Array.isArray(node.images)) {
    if (heading) acc.push(heading);
    node.images.forEach(img => flattenEntries(img, acc));
    return;
  }
  if (t === 'image') {
    const title = expand5eInline(node.title || '');
    const label = node.imageType === 'map' ? 'Map' : 'Image';
    const imgPath = node?.href?.path || node.path || '';
    const line = [label, title, imgPath].filter(Boolean).join(': ');
    if (line) acc.push(line);
    return;
  }

  // Statblock placeholder
  if (t === 'statblock' || t === 'statblockInline') {
    const sc = expand5eInline(node?.statblock || node?.name || '');
    if (sc) acc.push(`(Statblock: ${sc} — try /bestiary show ${sc})`);
    return;
  }

  // Generic objects
  if (node.entries) { if (heading) acc.push(heading); flattenEntries(node.entries, acc); return; }
  const maybe = [node.text, node.caption, node.summary].map(expand5eInline).filter(Boolean).join(' ');
  if (maybe) acc.push(maybe);
}

function chunk(text, max = BOOK_CHUNK_SIZE) {
  const clean = text.replace(/\n{3,}/g, '\n\n');
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

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function embedBatch(inputs) {
  if (!inputs.length) return [];
  // (Optionally add retry/backoff here if you hit rate limits)
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: inputs });
  return res.data.map(d => d.embedding);
}

/* ------------------------
   DB (minimal hardened schema + migration)
------------------------ */
function openDB() {
  const db = new Database(RAG_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs(
      path TEXT NOT NULL,            -- e.g., 'book:xmm/12'
      chunk_index INTEGER NOT NULL,  -- 0-based index for ordering
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,       -- JSON stringified embedding
      sha TEXT,                      -- SHA-256 of 'text' for change detection
      PRIMARY KEY (path, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);
  `);

  // Migrate: add 'sha' if the table exists from an older run
  try {
    const cols = db.prepare(`PRAGMA table_info(docs)`).all();
    const hasSha = cols.some(c => String(c.name).toLowerCase() === 'sha');
    if (!hasSha) {
      db.exec(`ALTER TABLE docs ADD COLUMN sha TEXT;`);
      console.log('DB migration: added docs.sha');
    }
  } catch (e) {
    console.warn('DB migration check failed:', e.message);
  }
  return db;
}

/* ------------------------
   Main
------------------------ */
(async () => {
  const db = openDB();

  const selExistingForNs = db.prepare(
    `SELECT chunk_index, sha FROM docs WHERE path LIKE ?`
  );
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO docs(path, chunk_index, text, embedding, sha)
     VALUES (?,?,?,?,?)`
  );
  const delStale = db.prepare(
    `DELETE FROM docs WHERE path LIKE ? AND chunk_index >= ?`
  );

  const files = walkJsonFiles(BOOK_DIR);
  console.log(`Found ${files.length} book file(s) in ${BOOK_DIR}`);

  // Graceful Ctrl-C
  let abort = false;
  process.once('SIGINT', () => {
    abort = true;
    console.log('\nSIGINT received — will stop after the current book.');
  });

  let totalEmbedded = 0;
  let totalSkipped = 0;
  let totalDeleted = 0;

  for (const f of files) {
    if (abort) break;

    let json;
    try {
      json = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      console.warn('Skip bad JSON:', f, e.message);
      continue;
    }

    const short = path.basename(f).replace(/\.json$/i, '');
    const ns = `book:${short}/`;

    // 5etools books often sit under json.book or json.data
    const hay = json.book || json.data || json.contents || json;
    const acc = [];
    flattenEntries(hay, acc);
    const text = acc.join('\n').trim();
    const chunks = chunk(text, BOOK_CHUNK_SIZE);

    console.log(`\n• ${short}: ${chunks.length} chunk(s)  [model=${EMBED_MODEL}, batch=${EMBED_BATCH}]`);
    console.time(`ingest:${short}`);

    db.exec('BEGIN IMMEDIATE');
    try {
      // load existing for this book namespace
      const existing = new Map(); // idx -> sha
      for (const row of selExistingForNs.all(`${ns}%`)) {
        existing.set(row.chunk_index, row.sha || null);
      }

      // Decide which chunks changed
      const toEmbedIdx = [];
      const toEmbedTxt = [];
      const toEmbedSha = [];
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const digest = sha256(ch);
        if (existing.get(i) === digest) { totalSkipped++; continue; }
        toEmbedIdx.push(i);
        toEmbedTxt.push(ch);
        toEmbedSha.push(digest);
      }

      // Batch embed changed chunks
      for (let i = 0; i < toEmbedTxt.length; i += EMBED_BATCH) {
        const batchTxt = toEmbedTxt.slice(i, i + EMBED_BATCH);
        const batchIdx = toEmbedIdx.slice(i, i + EMBED_BATCH);
        const batchSha = toEmbedSha.slice(i, i + EMBED_BATCH);

        const embs = await embedBatch(batchTxt);
        for (let j = 0; j < batchTxt.length; j++) {
          const idx = batchIdx[j];
          const pathKey = `${ns}${idx + 1}`; // human-friendly suffix
          upsert.run(pathKey, idx, batchTxt[j], JSON.stringify(embs[j]), batchSha[j]);
          totalEmbedded++;
        }
      }

      // Delete stale trailing rows if book shrank
      const delInfo = delStale.run(`${ns}%`, chunks.length);
      const deleted = delInfo?.changes || 0;
      totalDeleted += deleted;

      db.exec('COMMIT');

      const changed = toEmbedTxt.length;
      const skipped = chunks.length - changed;
      console.timeEnd(`ingest:${short}`);
      console.log(`   changed: ${changed}, skipped (unchanged): ${skipped}, stale deleted: ${deleted}`);
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`   ERROR in ${short}:`, e.message);
      if (abort) break;
    }
  }

  console.log(`\nDone. Embedded ${totalEmbedded} changed chunk(s); skipped ${totalSkipped}; deleted ${totalDeleted} stale row(s).`);
})();
