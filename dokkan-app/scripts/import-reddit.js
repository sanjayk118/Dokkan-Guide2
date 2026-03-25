/**
 * Imports dokkan-reddit.json into SQLite database.
 * Usage: node scripts/import-reddit.js
 */

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const REDDIT_FILE = path.join(__dirname, "..", "..", "dokkan-reddit.json");
const DB_FILE = path.join(__dirname, "..", "data", "dokkan.db");

async function main() {
  if (!fs.existsSync(REDDIT_FILE)) {
    console.error("Error: dokkan-reddit.json not found at", REDDIT_FILE);
    process.exit(1);
  }
  if (!fs.existsSync(DB_FILE)) {
    console.error("Error: dokkan.db not found. Run import-data.js first.");
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_FILE);
  const db = new SQL.Database(buffer);

  db.run(`CREATE TABLE IF NOT EXISTS reddit_insights (
    unitId TEXT PRIMARY KEY,
    unitName TEXT,
    matchQuality INTEGER,
    postCount INTEGER,
    topPostScore INTEGER,
    defense TEXT,
    offense TEXT,
    slot TEXT,
    partners TEXT,
    events TEXT,
    build TEXT,
    general TEXT,
    scrapedAt TEXT
  )`);

  const reddit = JSON.parse(fs.readFileSync(REDDIT_FILE, "utf-8"));
  const insights = reddit.unitInsights || {};
  const ids = Object.keys(insights);
  console.log(`Importing ${ids.length} unit insights...`);

  const stmt = db.prepare(`INSERT OR REPLACE INTO reddit_insights (
    unitId, unitName, matchQuality, postCount, topPostScore,
    defense, offense, slot, partners, events, build, general, scrapedAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const id of ids) {
    const ci = insights[id];
    stmt.run([
      id,
      ci.unitName || "",
      ci.matchQuality || 0,
      ci.postCount || 0,
      ci.topPostScore || 0,
      JSON.stringify(ci.defense || []),
      JSON.stringify(ci.offense || []),
      JSON.stringify(ci.slot || []),
      JSON.stringify(ci.partners || []),
      JSON.stringify(ci.events || []),
      JSON.stringify(ci.build || []),
      JSON.stringify(ci.general || []),
      reddit.scrapedAt || new Date().toISOString(),
    ]);
  }
  stmt.free();

  // Save metadata
  db.run(`CREATE TABLE IF NOT EXISTS scrape_metadata (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT OR REPLACE INTO scrape_metadata VALUES ('reddit_last_scraped', ?)`, [reddit.scrapedAt || ""]);
  db.run(`INSERT OR REPLACE INTO scrape_metadata VALUES ('reddit_posts_scraped', ?)`, [String(reddit.totalPostsScraped || 0)]);

  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
  db.close();

  console.log(`Done! ${ids.length} insights imported.`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
