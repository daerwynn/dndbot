// fix_adv_titles.js
// Usage: node fix_adv_titles.js ./adventures.pdf ./canonical_titles.txt
//
// 1) Match adventures by the PDF link slug (adventure.html#<slug>)
// 2) Read that row's raw text (reconstructed with proper spaces)
// 3) Walk canonical_titles.txt top-to-bottom and pick the first title
//    that is a full substring of the row text (case-insensitive)
// 4) Update adventures.title accordingly
//
// No web lookups. No heuristics beyond substring match.
// If the DB title already equals the canonical title, it is kept.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ---- CLI args & config
const PDF_PATH = process.argv[2] || path.join(process.cwd(), 'adventures.pdf');
const CANON_PATH = process.argv[3] || path.join(process.cwd(), 'canonical_titles.txt');
const RAG_DB = process.env.RAG_DB || 'rules.db';

// ---- PDF loader (pdfjs-dist)
function loadPdfJs() {
  const candidates = [
    'pdfjs-dist/legacy/build/pdf.js',
    'pdfjs-dist/build/pdf.js'
  ];
  for (const c of candidates) {
    try {
      const lib = require(c);
      // Try to set worker (best effort)
      const workerCandidates = [
        'pdfjs-dist/legacy/build/pdf.worker.js',
        'pdfjs-dist/build/pdf.worker.js'
      ];
      for (const w of workerCandidates) {
        try {
          const wsrc = require.resolve(w);
          if (lib && lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = wsrc;
          break;
        } catch {}
      }
      return lib;
    } catch {}
  }
  throw new Error('Could not load pdfjs-dist. Install with: npm i pdfjs-dist@^3');
}

const normWS = s => String(s || '').replace(/\s+/g, ' ').trim();

// Rebuild lines with spaces by grouping text runs by their Y and inserting space on gaps.
function groupTextIntoLines(items, yTol = 3) {
  const lines = [];
  for (const it of items) {
    if (!it || !it.str || !it.str.trim()) continue;
    const x = it.transform?.[4];
    const y = it.transform?.[5];
    if (typeof x !== 'number' || typeof y !== 'number') continue;

    let row = lines.find(L => Math.abs(L.y - y) <= yTol);
    if (!row) { row = { y, parts: [] }; lines.push(row); }
    row.parts.push({ x, str: it.str, width: it.width || 0 });
  }
  for (const L of lines) {
    L.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let lastRight = null;
    for (const p of L.parts) {
      const gap = lastRight == null ? 0 : (p.x - lastRight);
      if (gap > 1.0) text += ' ';
      text += p.str;
      lastRight = p.x + (p.width || 0);
    }
    L.text = normWS(text);
  }
  // visual order top-to-bottom
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

async function extractSlugToRowText(pdfPath) {
  const pdfjsLib = loadPdfJs();
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);

  const doc = await pdfjsLib.getDocument({ url: pdfPath }).promise;
  const map = new Map(); // slug -> raw row text

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [annots, textContent] = await Promise.all([
      page.getAnnotations({ intent: 'display' }),
      page.getTextContent()
    ]);
    const lines = groupTextIntoLines(textContent.items);

    function nearestLineToAnnot(a) {
      // Estimate center y of annotation
      let cy = null;
      if (Array.isArray(a.quadPoints) && a.quadPoints.length >= 8) {
        const ys = [a.quadPoints[1], a.quadPoints[3], a.quadPoints[5], a.quadPoints[7]];
        cy = ys.reduce((acc, v) => acc + v, 0) / ys.length;
      } else if (Array.isArray(a.rect) && a.rect.length === 4) {
        cy = (a.rect[1] + a.rect[3]) / 2;
      }
      if (cy == null) return lines.find(L => (L.text || '').trim());
      let best = null, bestDy = Infinity;
      for (const L of lines) {
        const dy = Math.abs(L.y - cy);
        if (dy < bestDy) { bestDy = dy; best = L; }
      }
      return best;
    }

    for (const a of annots) {
      if (!a || a.subtype !== 'Link') continue;
      const url = a.url || '';
      const m = url.match(/adventure\.html#([A-Za-z0-9-]+)/);
      if (!m) continue;
      const slug = m[1].toLowerCase();

      const line = nearestLineToAnnot(a);
      const raw = line?.text || '';
      if (raw) {
        // Keep the FIRST row we see for a slug.
        if (!map.has(slug)) map.set(slug, raw);
      }
    }
  }

  return map;
}

function loadCanonicalTitles(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`canonical_titles.txt not found at ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const titles = raw
    .split(/\r?\n/)
    .map(s => s.replace(/#.*/, '').trim())
    .filter(Boolean);
  return titles;
}

// case-insensitive substring test, but keep original strings intact
function containsCanonical(rowText, canonical) {
  const a = normWS(rowText).toLowerCase();
  const b = normWS(canonical).toLowerCase();
  return a.includes(b);
}

function openDb() {
  const db = new Database(RAG_DB);
  try { db.pragma('journal_mode = WAL'); } catch {}
  try { db.pragma('synchronous = NORMAL'); } catch {}
  return db;
}

(async () => {
  try {
    const slugToRow = await extractSlugToRowText(PDF_PATH);
    console.log(`Loaded ${slugToRow.size} slug→row mappings from PDF.`);

    const canon = loadCanonicalTitles(CANON_PATH);
    console.log(`Loaded ${canon.length} canonical titles from ${CANON_PATH}.`);

    const db = openDb();
    const rows = db.prepare(`SELECT id, code, title FROM adventures`).all();
    const upd  = db.prepare(`UPDATE adventures SET title = ? WHERE id = ?`);

    let updated = 0, kept = 0, noLink = 0, noMatch = 0;

    for (const r of rows) {
      const stem = String(r.code || '').replace(/\.json$/i, '');
      const m = stem.match(/^adventure-([a-z0-9-]+)$/i);
      if (!m) {
        console.log(`✖ ${r.code}: unexpected code format — left as "${r.title}"`);
        noLink++;
        continue;
      }
      const slug = m[1].toLowerCase();

      const rowText = slugToRow.get(slug);
      if (!rowText) {
        console.log(`✖ ${r.code}: no PDF link/row found — left as "${r.title}"`);
        noLink++;
        continue;
      }

      // Step 3: go canonical list in order, pick first that is a full substring of rowText
      let chosen = null;
      for (const ct of canon) {
        if (containsCanonical(rowText, ct)) { chosen = ct; break; }
      }

      if (!chosen) {
        console.log(`⚠ ${r.code}: no canonical substring found in PDF row — left as "${r.title}"`);
        // Uncomment to debug:
        // console.log('   row:', rowText);
        noMatch++;
        continue;
      }

      if (chosen === r.title) {
        console.log(`↷ ${r.code}: kept "${r.title}" (already canonical)`);
        kept++;
      } else {
        upd.run(chosen, r.id);
        console.log(`✔ ${r.code}: "${r.title}" → "${chosen}"`);
        updated++;
      }
    }

    console.log(`\nDone. Updated ${updated}; kept ${kept}; no-link ${noLink}; no-canonical-match ${noMatch}.`);
  } catch (e) {
    console.error('ERROR:', e.stack || e.message);
    process.exit(1);
  }
})();
