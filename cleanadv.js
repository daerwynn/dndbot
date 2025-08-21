// clean_adventure_data.js
require('dotenv').config();
const readline = require('readline');
const Database = require('better-sqlite3');

const DB_PATH = process.env.RAG_DB || 'rules.db';
const AUTO_YES = process.argv.includes('--yes') || process.argv.includes('-y');

function hasTable(db, name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name);
  return !!row;
}

function confirmPrompt(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

(async () => {
  if (!AUTO_YES) {
    const ans = await confirmPrompt(
      `This will DELETE all adventure data from "${DB_PATH}" (tables: adv_* and docs w/ path 'adv:%').\n` +
      `Type EXACTLY "DELETE" to proceed (or anything else to cancel): `
    );
    if (ans.trim() !== 'DELETE') {
      console.log('Canceled. No changes made.');
      process.exit(0);
    }
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const deletions = [];

  const tryDelete = (label, sql, params = []) => {
    try {
      const info = db.prepare(sql).run(...params);
      deletions.push({ label, changes: info.changes || 0 });
    } catch (e) {
      // If table doesn't exist, just note and continue
      deletions.push({ label, changes: 0, note: e.message.includes('no such table') ? 'table missing (skipped)' : e.message });
    }
  };

  console.log(`Opening DB: ${DB_PATH}`);
  db.exec('BEGIN IMMEDIATE');

  try {
    // Only delete adventure docs, not book docs
    if (hasTable(db, 'docs')) {
      tryDelete("docs (adv:%)", "DELETE FROM docs WHERE path LIKE 'adv:%'");
    }

    // Child tables first → parent tables last
    if (hasTable(db, 'adv_triggers'))    tryDelete('adv_triggers',    'DELETE FROM adv_triggers');
    if (hasTable(db, 'adv_assets'))      tryDelete('adv_assets',      'DELETE FROM adv_assets');
    if (hasTable(db, 'adv_encounters'))  tryDelete('adv_encounters',  'DELETE FROM adv_encounters');
    if (hasTable(db, 'adv_objectives'))  tryDelete('adv_objectives',  'DELETE FROM adv_objectives');
    if (hasTable(db, 'adv_nodes'))       tryDelete('adv_nodes',       'DELETE FROM adv_nodes');
    if (hasTable(db, 'adventures'))      tryDelete('adventures',      'DELETE FROM adventures');

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('ERROR during deletion, rolled back:', e.message);
    process.exit(1);
  }

  // VACUUM must be outside a transaction
  try {
    db.exec('VACUUM');
  } catch (e) {
    console.warn('VACUUM failed (non-fatal):', e.message);
  }

  console.log('\nDeletion summary:');
  for (const d of deletions) {
    const extra = d.note ? ` — ${d.note}` : '';
    console.log(`  • ${d.label}: ${d.changes} row(s)${extra}`);
  }
  console.log('\nDone.');
})();
