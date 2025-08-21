// set_adv_title.js
// Usage:
//   node set_adv_title.js adventure-lmop "Lost Mine of Phandelver"
//   node set_adv_title.js lmop "Lost Mine of Phandelver"  <-- 'adventure-' is added automatically

require('dotenv').config();
const Database = require('better-sqlite3');

const RAG_DB = process.env.RAG_DB || 'rules.db';

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const [, , rawCode, ...titleParts] = process.argv;
if (!rawCode || titleParts.length === 0) {
  die('Usage: node set_adv_title.js <adventure-code-or-slug> "<New Title>"\nExample: node set_adv_title.js adventure-lmop "Lost Mine of Phandelver"');
}

let code = String(rawCode).trim().replace(/\.json$/i, '');
if (!/^adventure-/.test(code)) code = 'adventure-' + code;

const newTitle = titleParts.join(' ').trim();
if (!newTitle) die('Error: title is empty');

let db;
try {
  db = new Database(RAG_DB, { timeout: 5000 });
} catch (e) {
  die(`Failed to open DB at ${RAG_DB}: ${e.message}`);
}

try {
  const sel = db.prepare('SELECT id, code, title FROM adventures WHERE code = ?');
  const row = sel.get(code);

  if (!row) {
    die(`No adventure found with code "${code}".`);
  }

  if (row.title === newTitle) {
    console.log(`No change: "${row.code}" title already "${row.title}".`);
    process.exit(0);
  }

  const upd = db.prepare('UPDATE adventures SET title = ? WHERE id = ?');
  const info = upd.run(newTitle, row.id);

  if (info.changes === 1) {
    console.log(`Updated ${row.code}: "${row.title}" → "${newTitle}"`);
    process.exit(0);
  } else {
    die('Update failed (no rows changed).');
  }
} catch (e) {
  die(`SQL error: ${e.message}`);
} finally {
  try { db.close(); } catch {}
}
