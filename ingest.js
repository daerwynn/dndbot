require('dotenv').config();
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const Database = require('better-sqlite3');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DB_PATH = process.env.RAG_DB || 'rules.db';
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || 'text-embedding-3-large';
const GLOB_PATTERN = process.env.RESOURCES_GLOB || 'resources/**/*.{md,txt}';

// ------------ helpers ------------
/** sentence-aware soft split for long text (fallback if a section is huge) */
function subchunk(text, size = 1400, overlap = 200) {
  const clean = text.replace(/\r/g, '');
  const out = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    // try to end at a sentence boundary
    const slice = clean.slice(i, end);
    const lastPunct = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
    if (lastPunct > size * 0.6) end = i + lastPunct + 1;
    out.push(clean.slice(i, end));
    i = Math.max(end - overlap, i + 1);
  }
  return out;
}

/** Parse Markdown into sections keyed by heading hierarchy (#, ##, ###) */
function markdownToSections(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const sections = [];
  let current = { level: 0, title: null, content: [] };
  let h1 = null, h2 = null, h3 = null;

  const flush = () => {
    if (current.title || current.content.length) {
      sections.push({
        titlePath: [h1, h2, h3].filter(Boolean).join(' > ') || current.title || 'Untitled',
        content: current.content.join('\n').trim()
      });
    }
    current = { level: 0, title: null, content: [] };
  };

  for (const raw of lines) {
    const m = raw.match(/^(\#{1,3})\s+(.*)$/); // # / ## / ###
    if (m) {
      // close previous section before starting a new one
      flush();
      const level = m[1].length;
      const title = m[2].trim();

      if (level === 1) { h1 = title; h2 = null; h3 = null; }
      if (level === 2) { h2 = title; h3 = null; }
      if (level === 3) { h3 = title; }

      current.level = level;
      current.title = title;
    } else {
      current.content.push(raw);
    }
  }
  flush();

  // Remove empties
  return sections
    .map(s => ({ ...s, content: s.content.trim() }))
    .filter(s => s.content);
}

/** Build final chunks: one per section; split only if the section is large */
function buildChunksFromMarkdown(text, fileLabel) {
  const sections = markdownToSections(text);
  const chunks = [];
  for (const s of sections) {
    const header = `# ${fileLabel} • ${s.titlePath}\n\n`;
    const payload = header + s.content;
    if (payload.length <= 1600) {
      chunks.push(payload);
    } else {
      const parts = subchunk(s.content, 1400, 180);
      parts.forEach((p, idx) => {
        chunks.push(`${header}${p}\n\n[part ${idx + 1}]`);
      });
    }
  }

  // Fallback: if file had no headings at all, chunk the whole file
  if (chunks.length === 0) {
    return subchunk(text, 1400, 180).map((p, i) => `# ${fileLabel}\n\n${p}\n\n[part ${i + 1}]`);
  }
  return chunks;
}

// ------------ DB setup ------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);
`);

// batched embedding helper
async function embedTexts(texts) {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts
  });
  return res.data.map(d => d.embedding);
}

// ------------ ingest ------------
(async () => {
  const files = glob.sync(GLOB_PATTERN, { nodir: true });
  if (files.length === 0) {
    console.log('No files matched. Set RESOURCES_GLOB or add files to resources/');
    process.exit(0);
  }

  db.exec('DELETE FROM docs');
  const insert = db.prepare('INSERT INTO docs (path, chunk_index, text, embedding) VALUES (?, ?, ?, ?)');
  const tx = db.transaction((rows) => rows.forEach(r => insert.run(r.path, r.chunk_index, r.text, r.embedding)));

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const baseLabel = path.basename(file);

    let raw = fs.readFileSync(file, 'utf8');

    // Strip front-matter (--- ... ---) if present; we’ll rely on headings + body
    raw = raw.replace(/^\s*---[\s\S]*?---\s*/m, '').trim();

    let chunks;
    if (ext === '.md') {
      chunks = buildChunksFromMarkdown(raw, baseLabel);
    } else {
      // plain text: just subchunk with a file header
      chunks = subchunk(raw, 1400, 180).map((p, i) => `# ${baseLabel}\n\n${p}\n\n[part ${i + 1}]`);
    }

    // embed in small batches
    const batchSize = 16;
    let rows = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embs = await embedTexts(batch);
      for (let j = 0; j < batch.length; j++) {
        rows.push({
          path: file,
          chunk_index: i + j,
          text: batch[j],
          embedding: JSON.stringify(embs[j])
        });
      }
      if (rows.length >= 64) {
        tx(rows);
        rows = [];
      }
    }
    if (rows.length) tx(rows);
    console.log(`Ingested ${file} (${chunks.length} section-chunks)`);
  }

  console.log('Done. DB at', DB_PATH);
})();
