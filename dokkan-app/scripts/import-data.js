/**
 * Imports dokkan-data.json into SQLite database.
 * Usage: node scripts/import-data.js
 */

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const DATA_FILE = path.join(__dirname, "..", "..", "dokkan-data.json");
const DB_FILE = path.join(__dirname, "..", "data", "dokkan.db");

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error("Error: dokkan-data.json not found at", DATA_FILE);
    process.exit(1);
  }

  const SQL = await initSqlJs();

  // Load existing DB or create new
  let db;
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
    console.log("Opened existing database.");
  } else {
    db = new SQL.Database();
    console.log("Created new database.");
  }

  // Create units table
  db.run(`CREATE TABLE IF NOT EXISTS units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT,
    rarity TEXT,
    class TEXT,
    type TEXT,
    cost INTEGER,
    imageURL TEXT,
    leaderSkill TEXT,
    superAttack TEXT,
    ultraSuperAttack TEXT,
    passive TEXT,
    activeSkill TEXT,
    activeSkillCondition TEXT,
    links TEXT,
    categories TEXT,
    kiMultiplier TEXT,
    maxLevelHP INTEGER,
    maxLevelAttack INTEGER,
    maxDefence INTEGER,
    freeDupeHP INTEGER,
    freeDupeAttack INTEGER,
    freeDupeDefence INTEGER,
    rainbowHP INTEGER,
    rainbowAttack INTEGER,
    rainbowDefence INTEGER,
    transformations TEXT,
    glbReleaseDate TEXT,
    ezaLeaderSkill TEXT,
    ezaPassive TEXT,
    ezaSuperAttack TEXT,
    ezaUltraSuperAttack TEXT
  )`);

  const units = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  console.log(`Importing ${units.length} units...`);

  const stmt = db.prepare(`INSERT OR REPLACE INTO units (
    id, name, title, rarity, class, type, cost, imageURL,
    leaderSkill, superAttack, ultraSuperAttack, passive,
    activeSkill, activeSkillCondition, links, categories,
    kiMultiplier, maxLevelHP, maxLevelAttack, maxDefence,
    freeDupeHP, freeDupeAttack, freeDupeDefence,
    rainbowHP, rainbowAttack, rainbowDefence,
    transformations, glbReleaseDate,
    ezaLeaderSkill, ezaPassive, ezaSuperAttack, ezaUltraSuperAttack
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?
  )`);

  for (const u of units) {
    stmt.run([
      u.id || u.name,
      u.name || "",
      u.title || null,
      u.rarity || null,
      u.class || null,
      u.type || null,
      u.cost || 0,
      u.imageURL || null,
      u.leaderSkill || null,
      u.superAttack || null,
      u.ultraSuperAttack || null,
      u.passive || null,
      u.activeSkill || null,
      u.activeSkillCondition || null,
      JSON.stringify(u.links || []),
      JSON.stringify(u.categories || []),
      u.kiMultiplier || null,
      u.maxLevelHP || 0,
      u.maxLevelAttack || 0,
      u.maxDefence || 0,
      u.freeDupeHP || 0,
      u.freeDupeAttack || 0,
      u.freeDupeDefence || 0,
      u.rainbowHP || 0,
      u.rainbowAttack || 0,
      u.rainbowDefence || 0,
      JSON.stringify(u.transformations || []),
      u.glbReleaseDate || null,
      u.ezaLeaderSkill || null,
      u.ezaPassive || null,
      u.ezaSuperAttack || null,
      u.ezaUltraSuperAttack || null,
    ]);
  }
  stmt.free();

  // Save
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
  db.close();

  console.log(`Done! ${units.length} units imported to ${DB_FILE}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
