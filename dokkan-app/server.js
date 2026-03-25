/**
 * Dokkan Guide — Express Server
 * Serves the web app and provides API routes for unit data.
 * Reddit scraper runs automatically every 24 hours.
 *
 * Usage: node server.js
 * Then open http://localhost:3000
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const initSqlJs = require("sql.js");

const PORT = 3000;
const DB_FILE = path.join(__dirname, "data", "dokkan.db");

let db = null;

// ---- Database helpers ----
function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// Parse JSON columns back to arrays/objects
function parseUnit(row) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    rarity: row.rarity,
    class: row.class,
    type: row.type,
    cost: row.cost,
    imageURL: row.imageURL,
    leaderSkill: row.leaderSkill,
    superAttack: row.superAttack,
    ultraSuperAttack: row.ultraSuperAttack,
    passive: row.passive,
    activeSkill: row.activeSkill,
    activeSkillCondition: row.activeSkillCondition,
    links: safeJsonParse(row.links, []),
    categories: safeJsonParse(row.categories, []),
    kiMultiplier: row.kiMultiplier,
    maxLevelHP: row.maxLevelHP,
    maxLevelAttack: row.maxLevelAttack,
    maxDefence: row.maxDefence,
    freeDupeHP: row.freeDupeHP,
    freeDupeAttack: row.freeDupeAttack,
    freeDupeDefence: row.freeDupeDefence,
    rainbowHP: row.rainbowHP,
    rainbowAttack: row.rainbowAttack,
    rainbowDefence: row.rainbowDefence,
    transformations: safeJsonParse(row.transformations, []),
    glbReleaseDate: row.glbReleaseDate,
    ezaLeaderSkill: row.ezaLeaderSkill,
    ezaPassive: row.ezaPassive,
    ezaSuperAttack: row.ezaSuperAttack,
    ezaUltraSuperAttack: row.ezaUltraSuperAttack,
  };
}

function parseRedditInsight(row) {
  return {
    unitName: row.unitName,
    matchQuality: row.matchQuality,
    postCount: row.postCount,
    topPostScore: row.topPostScore,
    defense: safeJsonParse(row.defense, []),
    offense: safeJsonParse(row.offense, []),
    slot: safeJsonParse(row.slot, []),
    partners: safeJsonParse(row.partners, []),
    events: safeJsonParse(row.events, []),
    build: safeJsonParse(row.build, []),
    general: safeJsonParse(row.general, []),
  };
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); }
  catch { return fallback; }
}

// Convert sql.js result set to array of objects
function resultToObjects(result) {
  if (!result || result.length === 0) return [];
  const res = result[0];
  return res.values.map(row => {
    const obj = {};
    res.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ---- Express app ----
async function startServer() {
  // Init database
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
    console.log("Database loaded.");
  } else {
    console.error("Error: data/dokkan.db not found. Run 'npm run import' first.");
    process.exit(1);
  }

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // ---- API: Get all units ----
  app.get("/api/units", (req, res) => {
    try {
      const rows = queryAll("SELECT * FROM units ORDER BY CAST(id AS INTEGER) DESC");
      const units = rows.map(parseUnit);
      res.json({ units, total: units.length });
    } catch (err) {
      console.error("Error fetching units:", err);
      res.status(500).json({ error: "Failed to fetch units" });
    }
  });

  // ---- API: Get single unit ----
  app.get("/api/units/:id", (req, res) => {
    try {
      const row = queryOne("SELECT * FROM units WHERE id = ?", [req.params.id]);
      if (!row) return res.status(404).json({ error: "Unit not found" });
      res.json(parseUnit(row));
    } catch (err) {
      console.error("Error fetching unit:", err);
      res.status(500).json({ error: "Failed to fetch unit" });
    }
  });

  // ---- API: Get all Reddit insights (bulk) ----
  app.get("/api/reddit", (req, res) => {
    try {
      // Check if table exists
      const tableCheck = queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='reddit_insights'");
      if (!tableCheck) return res.json({ unitInsights: {} });

      const rows = queryAll("SELECT * FROM reddit_insights");
      const unitInsights = {};
      for (const row of rows) {
        unitInsights[row.unitId] = parseRedditInsight(row);
      }
      res.json({ unitInsights });
    } catch (err) {
      console.error("Error fetching reddit data:", err);
      res.status(500).json({ error: "Failed to fetch reddit insights" });
    }
  });

  // ---- API: Get Reddit insights for specific unit ----
  app.get("/api/reddit/:unitId", (req, res) => {
    try {
      const tableCheck = queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='reddit_insights'");
      if (!tableCheck) return res.json(null);

      const row = queryOne("SELECT * FROM reddit_insights WHERE unitId = ?", [req.params.unitId]);
      if (!row) return res.json(null);
      res.json(parseRedditInsight(row));
    } catch (err) {
      console.error("Error fetching reddit insight:", err);
      res.status(500).json({ error: "Failed to fetch reddit insight" });
    }
  });

  // ---- API: Trigger Reddit scraper manually ----
  app.post("/api/scrape/reddit", (req, res) => {
    res.json({ message: "Reddit scraper started. Check server console for progress." });
    runRedditScraper();
  });

  // ---- API: Get scrape metadata ----
  app.get("/api/meta", (req, res) => {
    try {
      const tableCheck = queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='scrape_metadata'");
      if (!tableCheck) return res.json({});
      const rows = queryAll("SELECT * FROM scrape_metadata");
      const meta = {};
      for (const row of rows) { meta[row.key] = row.value; }
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch metadata" });
    }
  });

  // Start server
  app.listen(PORT, () => {
    const unitCount = queryOne("SELECT COUNT(*) as count FROM units");
    console.log(`\nDokkan Guide running at http://localhost:${PORT}`);
    console.log(`${unitCount ? unitCount.count : 0} units in database`);
    console.log("Reddit scraper scheduled every 24 hours.\n");
  });

  // Schedule Reddit scraper every 24 hours
  setInterval(() => {
    console.log("\n[Auto] Running scheduled Reddit scraper...");
    runRedditScraper();
  }, 24 * 60 * 60 * 1000);
}

// ---- Reddit Scraper (runs in background) ----
async function runRedditScraper() {
  try {
    const scraperPath = path.join(__dirname, "scrapers", "reddit.js");
    if (!fs.existsSync(scraperPath)) {
      console.log("[Scraper] scrapers/reddit.js not found, skipping.");
      return;
    }
    const { scrapeReddit } = require(scraperPath);
    await scrapeReddit(db, saveDb);
    console.log("[Scraper] Reddit scrape complete.");
  } catch (err) {
    console.error("[Scraper] Reddit scrape failed:", err.message);
  }
}

startServer();
