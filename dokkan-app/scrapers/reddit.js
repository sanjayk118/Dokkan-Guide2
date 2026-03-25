/**
 * Reddit scraper adapted for SQLite.
 * Can be called from server.js (scheduled) or standalone.
 *
 * Standalone: node scrapers/reddit.js
 * From server: const { scrapeReddit } = require("./scrapers/reddit"); await scrapeReddit(db, saveDb);
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const SUBREDDIT = "DBZDokkanBattle";
const RATE_LIMIT_MS = 1500;
const USER_AGENT = "DokkanGuideApp/1.0 (community scraper)";

// ---- HTTP helper ----
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + data.slice(0, 300))); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---- Unit search index (same logic as scrape-reddit.js) ----
function buildUnitSearchIndex(units) {
  const index = {};
  for (const u of units) {
    const terms = new Set();
    const name = u.name;
    const title = u.title || "";
    terms.add(name.toLowerCase());
    if (title.length > 5) terms.add(`${name} ${title}`.toLowerCase());
    if (u.rarity === "LR") {
      terms.add(`lr ${name}`.toLowerCase());
      const charPart = name.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
      if (charPart.length >= 6) terms.add(`lr ${charPart}`.toLowerCase());
    }
    const shorthands = generateShorthands(name);
    shorthands.forEach(s => terms.add(s.toLowerCase()));
    for (const t of terms) {
      if (t.length < 8) continue;
      if (!index[t]) index[t] = [];
      if (!index[t].includes(u.id)) index[t].push(u.id);
    }
  }
  return index;
}

function generateShorthands(name) {
  const shorthands = [];
  if (/super saiyan 4/i.test(name)) { const c = name.replace(/super saiyan 4\s*/i, "").trim(); if (c.length >= 4) { shorthands.push(`ssj4 ${c}`); shorthands.push(`ss4 ${c}`); } }
  if (/ultra instinct/i.test(name) && /goku/i.test(name)) { shorthands.push("mui goku"); shorthands.push("ultra instinct goku"); }
  if (/super saiyan god ss.*evolved/i.test(name) && /vegeta/i.test(name)) { shorthands.push("ssbe vegeta"); shorthands.push("blue evolved vegeta"); }
  if (/super saiyan god ss/i.test(name) && !/evolved/i.test(name)) { const c = name.replace(/super saiyan god ss\s*/i, "").trim(); if (c.length >= 4) { shorthands.push(`blue ${c}`); shorthands.push(`ssgss ${c}`); } }
  if (/beast/i.test(name) && /gohan/i.test(name)) shorthands.push("beast gohan");
  if (/orange/i.test(name) && /piccolo/i.test(name)) shorthands.push("orange piccolo");
  if (/black/i.test(name) && /frieza/i.test(name)) shorthands.push("black frieza");
  if (/golden/i.test(name) && /frieza/i.test(name)) shorthands.push("golden frieza");
  if (/\(youth\)/i.test(name) || /\(kid\)/i.test(name)) { const c = name.replace(/\s*\(youth\)\s*/i, "").replace(/\s*\(kid\)\s*/i, "").trim(); shorthands.push(`kid ${c}`); }
  if (/\(future\)/i.test(name)) { const c = name.replace(/\s*\(future\)\s*/i, "").trim(); shorthands.push(`future ${c}`); }
  if (/&/.test(name)) shorthands.push(name.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim());
  if (/majin vegeta/i.test(name)) shorthands.push("majin vegeta");
  return shorthands;
}

// ---- Gameplay filters ----
const GAMEPLAY_PATTERNS = [
  /slot\s*[123]|main\s*rotation|off[\s-]*rotation|float(?:er|ing)?/i,
  /tank(?:s|ing|ed)?\s+(?:well|poorly|fine|everything|nothing|supers?|normals?)|(?:can(?:'t|not)?|doesn't|does)\s+tank/i,
  /takes?\s+(?:double|triple|no|little|too much)\s+(?:damage|hit)/i,
  /def(?:ense)?\s+(?:is|was|feels?|looks?|gets?|reaches?|after|before|pre|post)\s/i,
  /stack(?:s|ing|ed)?\s+(?:def|atk|attack|defense|quickly|slowly|fast|well|poorly)/i,
  /(?:fully|done|finished)\s+stack/i,
  /(?:hits?|does|deals?|puts?\s+out|averages?)\s+(?:hard|soft|\d+\s*(?:mil|k|million))/i,
  /damage\s+(?:is|was|feels?|looks?)/i,
  /apt\s+(?:is|of|around|\d)/i,
  /(?:go|give|run|build|invest)\s+(?:full\s+)?(?:crit|additional|aa|dodge)/i,
  /(?:crit|additional|aa|dodge)\s+(?:is|are)\s+(?:better|best|worse|useless)/i,
  /hidden\s+potential/i,
  /(?:pair|partner|link|run|works?)\s+(?:with|well|great|amazing|perfectly)/i,
  /best\s+(?:partner|linking|rotation|team|leader)/i,
  /(?:shares?|activates?)\s+(?:\d+\s+)?links?/i,
  /(?:clears?|cleared|beats?|beat|no-item|no\s+item)\s+(?:red\s*zone|cell\s*max|sbr|esbr|tamagami)/i,
  /(?:red\s*zone|cell\s*max|sbr|esbr|tamagami)\s+(?:clear|run|stage|boss)/i,
  /(?:usable|unusable|viable|good|bad|mid|great|goated?)\s+(?:in|for|against)\s+/i,
  /transform(?:s|ation|ing)?\s+(?:on|at|by|after)\s+(?:turn|round)\s*\d/i,
  /active\s+skill\s+(?:on|at|by|turn|condition|timing|easy|hard|restrictive)/i,
  /ki\s+(?:issue|problem|hungry|starved|self[\s-]*sufficient|links)/i,
  /(?:gets?|needs?|struggles?\s+(?:for|with))\s+ki/i,
  /guard\s+(?:is|makes|helps|saves|means|against)/i,
  /(?:damage\s+reduction|dr)\s+(?:is|of|at|\d+%|helps|makes|stacks)/i,
  /dodge\s+(?:chance|rate|saved|clutch|cancel|is|helps|unreliable)/i,
  /counter(?:s|ing|ed)?\s+(?:super|attack|normal|are|is|so)/i,
  /additional\s+(?:super|attack|normal|is|are|helps)/i,
  /(?:eza|extreme z)\s+(?:made|makes|fixed|saved|is|was|buffed|turned)/i,
  /(?:pre|post|after|before)[\s-]*eza/i,
  /(?:best|top|worst)\s+(?:unit|card|tur|lr|eza)\s+(?:in|for|of|right\s+now)/i,
  /(?:aged|ages?|aging)\s+(?:well|poorly|badly|like\s+(?:wine|milk))/i,
];
const REJECT_PATTERNS = [
  /\b(lmao|lol|bruh|bro|💀|😂|😭|🗿|GOATT+|copium|hopium)\b/i,
  /summon|pull|stone|banner|shaft|dragon\s*stone|coin|wish|sold/i,
  /^(I|me|my|we)\s+(want|need|hope|wish|pray|love|hate|miss|remember)/i,
  /art\s+(is|looks|so)|animations?\s+(is|are|looks)/i,
  /wallpaper|desktop|edit|meme|concept|joke|funny/i,
  /\$|money|price|sale|deal|buy|purchase|whale|f2p\s+btw/i,
];

function isGameplayRelevant(text) {
  const t = text.trim();
  if (t.length < 25 || t.length > 250) return false;
  for (const r of REJECT_PATTERNS) { if (r.test(t)) return false; }
  for (const p of GAMEPLAY_PATTERNS) { if (p.test(t)) return true; }
  return false;
}

function extractGameplayInsights(text, unitName) {
  const insights = { defense: [], offense: [], slot: [], partners: [], events: [], build: [], general: [] };
  const sentences = text.split(/[.\n!?]+/).map(s => s.trim()).filter(s => s.length > 20 && s.length < 300);
  for (const sentence of sentences) {
    if (!isGameplayRelevant(sentence)) continue;
    const lower = sentence.toLowerCase();
    if (/slot|rotation|float/i.test(lower)) insights.slot.push(sentence);
    else if (/tank|def(?:ense)?|guard|damage\s+reduction|dr\s+|takes?\s+damage|stack.*def|survive/i.test(lower)) insights.defense.push(sentence);
    else if (/hits?\s|damage|apt|attack|crit|counter|additional.*super/i.test(lower)) insights.offense.push(sentence);
    else if (/partner|link|pair|run\s+with|works?\s+with/i.test(lower)) insights.partners.push(sentence);
    else if (/red\s*zone|cell\s*max|sbr|esbr|tamagami|clear|event|stage|boss/i.test(lower)) insights.events.push(sentence);
    else if (/crit|additional|aa|dodge|hidden.*potential|build|equip|orb/i.test(lower)) insights.build.push(sentence);
    else insights.general.push(sentence);
  }
  for (const key of Object.keys(insights)) { insights[key] = [...new Set(insights[key])].slice(0, 4); }
  return insights;
}

function matchUnitsInText(text, searchIndex) {
  const lower = text.toLowerCase();
  const matched = new Map();
  for (const [term, unitIds] of Object.entries(searchIndex)) {
    const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
    if (regex.test(lower)) {
      for (const id of unitIds) {
        const existing = matched.get(id);
        if (!existing || term.length > existing.matchedTerm.length) {
          matched.set(id, { score: term.length, matchedTerm: term });
        }
      }
    }
  }
  return matched;
}

// ---- Core scrape function ----
async function scrapeRedditCore(units) {
  console.log("[Reddit] Starting gameplay-focused scrape...");
  console.log(`[Reddit] ${units.length} units in search index`);

  const searchIndex = buildUnitSearchIndex(units);
  const unitMap = {};
  for (const u of units) unitMap[u.id] = u;

  const allPosts = [];
  const seenUrls = new Set();
  function addPosts(posts) {
    for (const p of posts) {
      const info = { title: p.title || "", body: (p.selftext || "").slice(0, 3000), score: p.score || 0, comments: p.num_comments || 0, flair: p.link_flair_text || "", permalink: p.permalink || "", url: `https://reddit.com${p.permalink}` };
      if (!seenUrls.has(info.url) && info.score >= 5) { seenUrls.add(info.url); allPosts.push(info); }
    }
  }

  // Fetch top posts
  for (const t of ["week", "month", "year"]) {
    try {
      const data = await fetchJson(`https://www.reddit.com/r/${SUBREDDIT}/top.json?t=${t}&limit=50&raw_json=1`);
      if (data?.data?.children) addPosts(data.data.children.map(c => c.data).filter(p => !p?.stickied));
    } catch (err) { console.error(`[Reddit] top/${t} error:`, err.message); }
    await sleep(RATE_LIMIT_MS);
  }

  // Search queries
  const queries = [
    "unit analysis defensive", "unit showcase red zone", "best rotation partner",
    "hidden potential build crit additional", "stacking defense turns", "tank slot 1 slot 2",
    "eza review gameplay", "tier list ranking units", "unit aged well mid",
    "dodge cancel guard damage reduction", "best linking partner rotation",
    "cell max tamagami clear team", "active skill transformation condition",
    "counter attack additional super", "ki management self sufficient", "underrated slept on unit",
  ];
  for (const q of queries) {
    try {
      const encoded = encodeURIComponent(q);
      const data = await fetchJson(`https://www.reddit.com/r/${SUBREDDIT}/search.json?q=${encoded}&restrict_sr=on&sort=relevance&t=year&limit=20&raw_json=1`);
      if (data?.data?.children) addPosts(data.data.children.map(c => c.data).filter(p => !p?.stickied));
    } catch (err) { /* skip */ }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[Reddit] ${allPosts.length} posts collected`);

  // Filter gameplay posts
  const gameplayPosts = allPosts.filter(p => {
    const text = (p.title + " " + p.body + " " + p.flair).toLowerCase();
    if (/meme|pull\s*post|fan\s*art|fluff/i.test(p.flair)) return false;
    if (p.body.length < 30 && p.comments < 25) return false;
    return /tank|slot|rotation|stack|def|atk|guard|dodge|crit|additional|partner|link|team|clear|red\s*zone|sbr|esbr|eza|tier|rank|mid|aged|showcase|analysis|hidden.*potential|active.*skill|transform|counter/i.test(text);
  });

  // Fetch comments
  const topDiscussions = gameplayPosts.filter(p => p.comments >= 10).sort((a, b) => b.score - a.score).slice(0, 40);
  for (const post of topDiscussions) {
    try {
      const data = await fetchJson(`https://www.reddit.com${post.permalink}.json?limit=12&sort=top&raw_json=1`);
      if (Array.isArray(data) && data.length >= 2 && data[1]?.data?.children) {
        post.topComments = data[1].data.children
          .filter(c => c.kind === "t1" && c.data?.body)
          .map(c => ({ body: c.data.body.slice(0, 1000), score: c.data.score || 0 }))
          .filter(c => c.score >= 5).slice(0, 10);
      }
    } catch (err) { /* skip */ }
    await sleep(RATE_LIMIT_MS);
  }

  // Match and extract
  const unitInsights = {};
  for (const post of gameplayPosts) {
    const allText = post.title + "\n" + post.body + "\n" + (post.topComments || []).map(c => c.body).join("\n");
    const matches = matchUnitsInText(allText, searchIndex);
    for (const [unitId, match] of matches) {
      if (!unitMap[unitId]) continue;
      const insights = extractGameplayInsights(allText, unitMap[unitId].name);
      if (Object.values(insights).flat().length === 0) continue;
      if (!unitInsights[unitId]) {
        unitInsights[unitId] = { unitName: unitMap[unitId].name, matchQuality: match.score, defense: [], offense: [], slot: [], partners: [], events: [], build: [], general: [], postCount: 0, topPostScore: 0 };
      }
      const ui = unitInsights[unitId];
      ui.postCount++;
      ui.topPostScore = Math.max(ui.topPostScore, post.score);
      if (match.score > ui.matchQuality) ui.matchQuality = match.score;
      for (const cat of ["defense", "offense", "slot", "partners", "events", "build", "general"]) {
        for (const tip of insights[cat]) { if (!ui[cat].includes(tip)) ui[cat].push(tip); }
      }
    }
  }

  // Trim
  const result = {};
  for (const [id, ui] of Object.entries(unitInsights)) {
    for (const cat of ["defense", "offense", "slot", "partners", "events", "build", "general"]) { ui[cat] = ui[cat].slice(0, 4); }
    const total = ["defense", "offense", "slot", "partners", "events", "build", "general"].reduce((s, c) => s + ui[c].length, 0);
    if (total >= 1) result[id] = ui;
  }

  console.log(`[Reddit] ${Object.keys(result).length} units with gameplay insights`);
  return result;
}

// ---- SQLite integration: called from server.js ----
async function scrapeReddit(db, saveDb) {
  // Read units from DB
  const stmt = db.prepare("SELECT id, name, title, rarity FROM units");
  const units = [];
  while (stmt.step()) { units.push(stmt.getAsObject()); }
  stmt.free();

  const insights = await scrapeRedditCore(units);

  // Ensure table exists
  db.run(`CREATE TABLE IF NOT EXISTS reddit_insights (
    unitId TEXT PRIMARY KEY, unitName TEXT, matchQuality INTEGER,
    postCount INTEGER, topPostScore INTEGER,
    defense TEXT, offense TEXT, slot TEXT, partners TEXT,
    events TEXT, build TEXT, general TEXT, scrapedAt TEXT
  )`);

  // Clear old data and insert new
  db.run("DELETE FROM reddit_insights");
  const ins = db.prepare(`INSERT INTO reddit_insights (unitId, unitName, matchQuality, postCount, topPostScore, defense, offense, slot, partners, events, build, general, scrapedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  for (const [id, ci] of Object.entries(insights)) {
    ins.run([id, ci.unitName, ci.matchQuality, ci.postCount, ci.topPostScore,
      JSON.stringify(ci.defense), JSON.stringify(ci.offense), JSON.stringify(ci.slot),
      JSON.stringify(ci.partners), JSON.stringify(ci.events), JSON.stringify(ci.build),
      JSON.stringify(ci.general), now]);
  }
  ins.free();

  // Update metadata
  db.run(`CREATE TABLE IF NOT EXISTS scrape_metadata (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT OR REPLACE INTO scrape_metadata VALUES ('reddit_last_scraped', ?)`, [now]);

  saveDb();
  console.log(`[Reddit] Saved ${Object.keys(insights).length} insights to DB.`);
}

// ---- Standalone mode ----
if (require.main === module) {
  const initSqlJs = require("sql.js");
  const DB_FILE = path.join(__dirname, "..", "data", "dokkan.db");

  (async () => {
    if (!fs.existsSync(DB_FILE)) { console.error("DB not found. Run npm run import first."); process.exit(1); }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_FILE));
    const saveDb = () => fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
    await scrapeReddit(db, saveDb);
    db.close();
  })().catch(err => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { scrapeReddit };
