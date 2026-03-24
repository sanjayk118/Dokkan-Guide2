/**
 * Dokkan Battle Reddit Community Scraper
 * Fetches community discussions from r/DBZDokkanBattle and extracts
 * gameplay-specific knowledge per unit.
 *
 * Usage: node scrape-reddit.js
 * Outputs: dokkan-reddit.json
 * Then run: node embed-reddit.js
 */

const https = require("https");
const fs = require("fs");

const SUBREDDIT = "DBZDokkanBattle";
const DATA_FILE = "dokkan-data.json";
const OUTPUT_FILE = "dokkan-reddit.json";
const RATE_LIMIT_MS = 1500;
const USER_AGENT = "DokkanGuideApp/1.0 (community scraper)";

// ---- HTTP helper ----
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetch(res.headers.location).then(resolve).catch(reject);
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

// ---- Build STRICT unit search index ----
// Only use specific, unique name combinations — no bare "Goku" or "Vegeta"
function buildUnitSearchIndex(units) {
  const index = {};

  for (const u of units) {
    const terms = new Set();
    const name = u.name;
    const title = u.title || "";

    // 1. Full name (most specific) — always include
    terms.add(name.toLowerCase());

    // 2. Full name with title (for Reddit posts that cite the card title)
    if (title.length > 5) {
      terms.add(`${name} ${title}`.toLowerCase());
    }

    // 3. Rarity prefix + name ("LR Gogeta", "LR Broly")
    if (u.rarity === "LR") {
      terms.add(`lr ${name}`.toLowerCase());
      // Also "LR" + just the character part for multi-word names
      const charPart = extractCharacterName(name);
      if (charPart && charPart.length >= 6) {
        terms.add(`lr ${charPart}`.toLowerCase());
      }
    }

    // 4. Generate Dokkan community shorthand (these are specific enough)
    const shorthands = generateShorthands(name, u.id);
    shorthands.forEach(s => terms.add(s.toLowerCase()));

    // Store — require minimum 8 chars to avoid false positives
    for (const t of terms) {
      if (t.length < 8) continue;
      if (!index[t]) index[t] = [];
      // Don't add duplicate unit IDs
      if (!index[t].includes(u.id)) index[t].push(u.id);
    }
  }

  return index;
}

// Extract the "character name" part, keeping form identifiers
function extractCharacterName(name) {
  // "Super Saiyan 4 Goku & Vegeta" -> "SSJ4 Goku & Vegeta"
  // "Majin Vegeta" -> "Majin Vegeta" (keep as-is, it's specific)
  // "Goku (Youth)" -> "Kid Goku"

  // Remove generic prefixes but keep identifying ones
  let result = name
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return result;
}

function generateShorthands(name, id) {
  const shorthands = [];
  const lower = name.toLowerCase();

  // SSJ4 Gogeta, SSJ4 Goku, etc.
  if (/super saiyan 4/i.test(name)) {
    const char = name.replace(/super saiyan 4\s*/i, "").trim();
    if (char.length >= 4) shorthands.push(`ssj4 ${char}`);
    if (char.length >= 4) shorthands.push(`ss4 ${char}`);
  }
  // Ultra Instinct / MUI
  if (/ultra instinct/i.test(name) && /goku/i.test(name)) {
    shorthands.push("mui goku");
    shorthands.push("ultra instinct goku");
  }
  // SSBE Vegeta
  if (/super saiyan god ss.*evolved/i.test(name) && /vegeta/i.test(name)) {
    shorthands.push("ssbe vegeta");
    shorthands.push("blue evolved vegeta");
  }
  // Blue Goku/Vegeta
  if (/super saiyan god ss/i.test(name) && !/evolved/i.test(name)) {
    const char = name.replace(/super saiyan god ss\s*/i, "").trim();
    if (char.length >= 4) shorthands.push(`blue ${char}`);
    if (char.length >= 4) shorthands.push(`ssgss ${char}`);
  }
  // Beast Gohan
  if (/beast/i.test(name) && /gohan/i.test(name)) {
    shorthands.push("beast gohan");
  }
  // Orange Piccolo
  if (/orange/i.test(name) && /piccolo/i.test(name)) {
    shorthands.push("orange piccolo");
  }
  // Black Frieza
  if (/black/i.test(name) && /frieza/i.test(name)) {
    shorthands.push("black frieza");
  }
  // Golden Frieza
  if (/golden/i.test(name) && /frieza/i.test(name)) {
    shorthands.push("golden frieza");
  }
  // Kid Goku / Kid Gohan
  if (/\(youth\)/i.test(name) || /\(kid\)/i.test(name)) {
    const char = name.replace(/\s*\(youth\)\s*/i, "").replace(/\s*\(kid\)\s*/i, "").trim();
    shorthands.push(`kid ${char}`);
  }
  // Future Trunks / Future Gohan
  if (/\(future\)/i.test(name)) {
    const char = name.replace(/\s*\(future\)\s*/i, "").trim();
    shorthands.push(`future ${char}`);
  }
  // Duo units: "Goku & Vegeta", "Goku and Vegeta"
  if (/&/.test(name)) {
    shorthands.push(name.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim());
  }
  // Majin Vegeta
  if (/majin vegeta/i.test(name)) {
    shorthands.push("majin vegeta");
  }

  return shorthands;
}

// ---- GAMEPLAY-ONLY content extraction ----
// Strict filters: only extract sentences that contain actual gameplay info

const GAMEPLAY_PATTERNS = [
  // Slot/rotation advice
  /slot\s*[123]|main\s*rotation|off[\s-]*rotation|float(?:er|ing)?/i,
  // Tanking/defense observations
  /tank(?:s|ing|ed)?\s+(?:well|poorly|fine|everything|nothing|supers?|normals?)|(?:can(?:'t|not)?|doesn't|does)\s+tank/i,
  /takes?\s+(?:double|triple|no|little|too much)\s+(?:damage|hit)/i,
  /def(?:ense)?\s+(?:is|was|feels?|looks?|gets?|reaches?|after|before|pre|post)\s/i,
  // Stacking observations
  /stack(?:s|ing|ed)?\s+(?:def|atk|attack|defense|quickly|slowly|fast|well|poorly)/i,
  /(?:fully|done|finished)\s+stack/i,
  // Damage observations
  /(?:hits?|does|deals?|puts?\s+out|averages?)\s+(?:hard|soft|\d+\s*(?:mil|k|million))/i,
  /damage\s+(?:is|was|feels?|looks?)/i,
  /apt\s+(?:is|of|around|\d)/i,
  // Hidden potential / build
  /(?:go|give|run|build|invest)\s+(?:full\s+)?(?:crit|additional|aa|dodge)/i,
  /(?:crit|additional|aa|dodge)\s+(?:is|are)\s+(?:better|best|worse|useless)/i,
  /hidden\s+potential/i,
  // Team/partner/link observations
  /(?:pair|partner|link|run|works?)\s+(?:with|well|great|amazing|perfectly)/i,
  /best\s+(?:partner|linking|rotation|team|leader)/i,
  /(?:shares?|activates?)\s+(?:\d+\s+)?links?/i,
  // Event-specific performance
  /(?:clears?|cleared|beats?|beat|no-item|no\s+item)\s+(?:red\s*zone|cell\s*max|sbr|esbr|tamagami)/i,
  /(?:red\s*zone|cell\s*max|sbr|esbr|tamagami)\s+(?:clear|run|stage|boss)/i,
  /(?:usable|unusable|viable|good|bad|mid|great|goated?)\s+(?:in|for|against)\s+/i,
  // Transformation/active skill timing
  /transform(?:s|ation|ing)?\s+(?:on|at|by|after)\s+(?:turn|round)\s*\d/i,
  /active\s+skill\s+(?:on|at|by|turn|condition|timing|easy|hard|restrictive)/i,
  // Ki management
  /ki\s+(?:issue|problem|hungry|starved|self[\s-]*sufficient|links)/i,
  /(?:gets?|needs?|struggles?\s+(?:for|with))\s+ki/i,
  // Guard / DR / dodge observations
  /guard\s+(?:is|makes|helps|saves|means|against)/i,
  /(?:damage\s+reduction|dr)\s+(?:is|of|at|\d+%|helps|makes|stacks)/i,
  /dodge\s+(?:chance|rate|saved|clutch|cancel|is|helps|unreliable)/i,
  // Counter / additional
  /counter(?:s|ing|ed)?\s+(?:super|attack|normal|are|is|so)/i,
  /additional\s+(?:super|attack|normal|is|are|helps)/i,
  // EZA observations
  /(?:eza|extreme z)\s+(?:made|makes|fixed|saved|is|was|buffed|turned)/i,
  /(?:pre|post|after|before)[\s-]*eza/i,
  // Overall unit rating in gameplay context
  /(?:best|top|worst)\s+(?:unit|card|tur|lr|eza)\s+(?:in|for|of|right\s+now)/i,
  /(?:aged|ages?|aging)\s+(?:well|poorly|badly|like\s+(?:wine|milk))/i,
];

// Stuff to REJECT even if it matches gameplay patterns
const REJECT_PATTERNS = [
  /\b(lmao|lol|bruh|bro|💀|😂|😭|🗿|GOATT+|copium|hopium)\b/i,
  /summon|pull|stone|banner|shaft|dragon\s*stone|coin|wish|sold/i,
  /^(I|me|my|we)\s+(want|need|hope|wish|pray|love|hate|miss|remember)/i,
  /art\s+(is|looks|so)|animations?\s+(is|are|looks)/i,
  /wallpaper|desktop|edit|meme|concept|joke|funny/i,
  /\$|money|price|sale|deal|buy|purchase|whale|f2p\s+btw/i,
];

function isGameplayRelevant(text) {
  const trimmed = text.trim();
  if (trimmed.length < 25 || trimmed.length > 250) return false;

  // Reject non-gameplay
  for (const r of REJECT_PATTERNS) {
    if (r.test(trimmed)) return false;
  }

  // Must match at least one gameplay pattern
  for (const p of GAMEPLAY_PATTERNS) {
    if (p.test(trimmed)) return true;
  }

  return false;
}

// Extract only gameplay-relevant sentences from text, contextualized to a specific unit name
function extractGameplayInsights(text, unitName) {
  const insights = { defense: [], offense: [], slot: [], partners: [], events: [], build: [], general: [] };
  const sentences = text.split(/[.\n!?]+/).map(s => s.trim()).filter(s => s.length > 20 && s.length < 300);

  // Only keep sentences that reference this specific unit (or are clearly about it in context)
  const unitTerms = getUnitMatchTerms(unitName);

  for (const sentence of sentences) {
    if (!isGameplayRelevant(sentence)) continue;

    // Check if sentence is about this unit (or is in a unit-specific thread)
    const lower = sentence.toLowerCase();

    // Categorize
    if (/slot|rotation|float/i.test(lower)) {
      insights.slot.push(sentence);
    } else if (/tank|def(?:ense)?|guard|damage\s+reduction|dr\s+|takes?\s+damage|stack.*def|survive/i.test(lower)) {
      insights.defense.push(sentence);
    } else if (/hits?\s|damage|apt|attack|crit|counter|additional.*super/i.test(lower)) {
      insights.offense.push(sentence);
    } else if (/partner|link|pair|run\s+with|works?\s+with/i.test(lower)) {
      insights.partners.push(sentence);
    } else if (/red\s*zone|cell\s*max|sbr|esbr|tamagami|clear|event|stage|boss/i.test(lower)) {
      insights.events.push(sentence);
    } else if (/crit|additional|aa|dodge|hidden.*potential|build|equip|orb/i.test(lower)) {
      insights.build.push(sentence);
    } else {
      insights.general.push(sentence);
    }
  }

  // Deduplicate and limit each category
  for (const key of Object.keys(insights)) {
    insights[key] = [...new Set(insights[key])].slice(0, 4);
  }

  return insights;
}

function getUnitMatchTerms(name) {
  const terms = [name.toLowerCase()];
  const cleaned = name.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  terms.push(cleaned);
  // Also add last word (character name) if multi-word
  const words = cleaned.split(" ");
  if (words.length > 1) terms.push(words[words.length - 1]);
  return terms;
}

// ---- Fetch functions (same as before) ----
async function searchSubreddit(query, limit = 25) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.reddit.com/r/${SUBREDDIT}/search.json?q=${encoded}&restrict_sr=on&sort=relevance&t=year&limit=${limit}&raw_json=1`;
  console.log(`  Searching: "${query}"`);
  try {
    const data = await fetch(url);
    if (!data || !data.data || !data.data.children) return [];
    return data.data.children.map(c => c.data).filter(p => p && !p.stickied);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    return [];
  }
}

async function fetchPostComments(permalink, limit = 10) {
  const url = `https://www.reddit.com${permalink}.json?limit=${limit}&sort=top&raw_json=1`;
  try {
    const data = await fetch(url);
    if (!Array.isArray(data) || data.length < 2) return [];
    const listing = data[1];
    if (!listing || !listing.data || !listing.data.children) return [];
    return listing.data.children
      .filter(c => c.kind === "t1" && c.data && c.data.body)
      .map(c => ({ body: c.data.body.slice(0, 1000), score: c.data.score || 0 }))
      .filter(c => c.score >= 5)
      .slice(0, 10);
  } catch (err) { return []; }
}

function extractPostInfo(post) {
  return {
    title: post.title || "",
    body: (post.selftext || "").slice(0, 3000),
    score: post.score || 0,
    comments: post.num_comments || 0,
    flair: post.link_flair_text || "",
    created: post.created_utc || 0,
    permalink: post.permalink || "",
    url: `https://reddit.com${post.permalink}`,
  };
}

// ---- Match text to units (STRICT) ----
function matchUnitsInText(text, searchIndex) {
  const lower = text.toLowerCase();
  const matched = new Map(); // unitId -> { score, matchedTerm }

  for (const [term, unitIds] of Object.entries(searchIndex)) {
    const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
    if (regex.test(lower)) {
      for (const id of unitIds) {
        const existing = matched.get(id);
        // Prefer longer (more specific) matches
        if (!existing || term.length > existing.matchedTerm.length) {
          matched.set(id, { score: term.length, matchedTerm: term });
        }
      }
    }
  }

  return matched;
}

// ---- Main ----
async function main() {
  console.log("=== Dokkan Battle Reddit Scraper (Gameplay-Focused) ===\n");

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Error: ${DATA_FILE} not found.`);
    process.exit(1);
  }
  const units = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  console.log(`Loaded ${units.length} units`);

  const searchIndex = buildUnitSearchIndex(units);
  console.log(`Search index: ${Object.keys(searchIndex).length} terms\n`);

  // Collect posts
  const allPosts = [];
  const seenUrls = new Set();
  function addPosts(posts) {
    for (const p of posts) {
      const info = extractPostInfo(p);
      if (!seenUrls.has(info.url) && info.score >= 5) {
        seenUrls.add(info.url);
        allPosts.push(info);
      }
    }
  }

  // 1. Top posts
  console.log("--- Fetching top posts ---");
  for (const t of ["week", "month", "year"]) {
    const url = `https://www.reddit.com/r/${SUBREDDIT}/top.json?t=${t}&limit=50&raw_json=1`;
    console.log(`  top/${t}`);
    try {
      const data = await fetch(url);
      if (data?.data?.children) addPosts(data.data.children.map(c => c.data).filter(p => !p?.stickied));
    } catch (err) { console.error(`  Error: ${err.message}`); }
    await sleep(RATE_LIMIT_MS);
  }

  // 2. Gameplay-focused searches
  console.log("\n--- Searching gameplay discussions ---");
  const queries = [
    "unit analysis defensive",
    "unit showcase red zone",
    "best rotation partner",
    "hidden potential build crit additional",
    "stacking defense turns",
    "tank slot 1 slot 2",
    "eza review gameplay",
    "tier list ranking units",
    "unit aged well mid",
    "dodge cancel guard damage reduction",
    "best linking partner rotation",
    "cell max tamagami clear team",
    "active skill transformation condition",
    "counter attack additional super",
    "ki management self sufficient",
    "underrated slept on unit",
  ];

  for (const q of queries) {
    const posts = await searchSubreddit(q, 20);
    addPosts(posts);
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nCollected ${allPosts.length} posts (score >= 5)`);

  // 3. Filter for gameplay-relevant posts (skip memes, art, pulls)
  const gameplayPosts = allPosts.filter(p => {
    const text = (p.title + " " + p.body + " " + p.flair).toLowerCase();
    // Reject non-gameplay flairs
    if (/meme|pull\s*post|fan\s*art|fluff/i.test(p.flair)) return false;
    // Must have some substance
    if (p.body.length < 30 && p.comments < 25) return false;
    // Should mention gameplay concepts
    return /tank|slot|rotation|stack|def|atk|guard|dodge|crit|additional|partner|link|team|clear|red\s*zone|sbr|esbr|eza|tier|rank|mid|aged|showcase|analysis|hidden.*potential|active.*skill|transform|counter/i.test(text);
  });
  console.log(`${gameplayPosts.length} gameplay-relevant posts`);

  // 4. Fetch comments from top discussion posts
  console.log("\n--- Fetching comments ---");
  const topDiscussions = gameplayPosts
    .filter(p => p.comments >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  for (const post of topDiscussions) {
    const comments = await fetchPostComments(post.permalink, 12);
    post.topComments = comments;
    if (comments.length > 0) {
      console.log(`  ${post.title.slice(0, 55)}... (${comments.length} comments)`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  // 5. Match to units and extract GAMEPLAY insights only
  console.log("\n--- Extracting gameplay insights per unit ---");
  const unitMap = {};
  for (const u of units) unitMap[u.id] = u;

  const unitInsights = {}; // unitId -> merged gameplay insights

  for (const post of gameplayPosts) {
    const fullText = post.title + "\n" + post.body;
    const commentText = (post.topComments || []).map(c => c.body).join("\n");
    const allText = fullText + "\n" + commentText;

    const matches = matchUnitsInText(allText, searchIndex);

    for (const [unitId, match] of matches) {
      if (!unitMap[unitId]) continue;
      const unit = unitMap[unitId];

      // Extract gameplay insights filtered to this unit
      const insights = extractGameplayInsights(allText, unit.name);

      // Check if we actually got anything useful
      const totalInsights = Object.values(insights).flat().length;
      if (totalInsights === 0) continue;

      if (!unitInsights[unitId]) {
        unitInsights[unitId] = {
          unitName: unit.name,
          matchQuality: match.score,
          defense: [], offense: [], slot: [], partners: [],
          events: [], build: [], general: [],
          postCount: 0,
          topPostScore: 0,
        };
      }

      const ui = unitInsights[unitId];
      ui.postCount++;
      ui.topPostScore = Math.max(ui.topPostScore, post.score);
      if (match.score > ui.matchQuality) ui.matchQuality = match.score;

      // Merge insights (deduplicate)
      for (const cat of ["defense", "offense", "slot", "partners", "events", "build", "general"]) {
        for (const tip of insights[cat]) {
          if (!ui[cat].includes(tip)) ui[cat].push(tip);
        }
      }
    }
  }

  // 6. Trim and finalize
  let matchedCount = 0;
  const communityData = {};

  for (const [id, ui] of Object.entries(unitInsights)) {
    // Limit each category
    for (const cat of ["defense", "offense", "slot", "partners", "events", "build", "general"]) {
      ui[cat] = ui[cat].slice(0, 4);
    }

    const totalTips = ["defense", "offense", "slot", "partners", "events", "build", "general"]
      .reduce((sum, cat) => sum + ui[cat].length, 0);

    // Only include units with actual gameplay content
    if (totalTips < 1) continue;

    matchedCount++;
    communityData[id] = {
      unitName: ui.unitName,
      matchQuality: ui.matchQuality,
      postCount: ui.postCount,
      topPostScore: ui.topPostScore,
      // Gameplay insights by category — these feed into analyzeUnit()
      defense: ui.defense,
      offense: ui.offense,
      slot: ui.slot,
      partners: ui.partners,
      events: ui.events,
      build: ui.build,
      general: ui.general,
    };
  }

  const output = {
    scrapedAt: new Date().toISOString(),
    subreddit: SUBREDDIT,
    totalPostsScraped: allPosts.length,
    gameplayPostsUsed: gameplayPosts.length,
    unitsWithInsights: matchedCount,
    unitInsights: communityData,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n=== Done! ===`);
  console.log(`${matchedCount} units with gameplay insights`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log(`Next: node embed-reddit.js`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
