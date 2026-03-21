/**
 * Dokkan Battle Wiki Scraper
 * Fetches unit data from dbz-dokkanbattle.fandom.com MediaWiki API
 * and outputs dokkan-data.json in the same format the guide app expects.
 *
 * Usage: node scrape-dokkan.js
 * Takes ~8-15 minutes depending on connection speed.
 */

const https = require("https");
const fs = require("fs");

const API_BASE = "https://dbz-dokkanbattle.fandom.com/api.php";
const CATEGORIES = ["UR", "LR"]; // Skip SSR to keep it focused on usable units
const MIN_YEAR = 2020; // Only include units released 2020 or later on Global
const OUTPUT_FILE = "dokkan-data-wiki.json";
const RATE_LIMIT_MS = 200; // 5 requests per second

// ---- HTTP helper ----
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "DokkanGuide/1.0 (unit guide scraper)" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Step 1: Get all page titles from categories ----
async function getCategoryPages(category) {
  const pages = [];
  let cmcontinue = "";
  while (true) {
    let url = `${API_BASE}?action=query&list=categorymembers&cmtitle=Category:${category}&cmlimit=500&cmnamespace=0&format=json`;
    if (cmcontinue) url += `&cmcontinue=${encodeURIComponent(cmcontinue)}`;
    const result = await fetch(url);
    const members = result.query.categorymembers || [];
    members.forEach((m) => pages.push(m.title));
    if (result.continue && result.continue.cmcontinue) {
      cmcontinue = result.continue.cmcontinue;
    } else break;
    await sleep(RATE_LIMIT_MS);
  }
  return pages;
}

// ---- Step 2: Fetch wikitext for a page ----
async function getWikitext(title) {
  const url = `${API_BASE}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
  const result = await fetch(url);
  if (result.error) return null;
  return result.parse.wikitext["*"];
}

// ---- Step 3: Parse wikitext infobox into structured data ----
function cleanWikiMarkup(text) {
  if (!text) return "";
  return text
    // Remove <ref>...</ref> tags
    .replace(/<ref[^>]*>.*?<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    // Remove {{Passive|...}} templates
    .replace(/\{\{Passive\|[^}]*\}\}/gi, "")
    // Remove [[File:...]] embeds
    .replace(/\[\[File:[^\]]*\]\]/gi, "")
    // Convert [[Link Text|Display]] or [[Link Text]] to just the text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    // Remove HTML tags but keep text
    .replace(/<\/?b>/gi, "")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/<hr\s*\/?>/gi, "; ")
    .replace(/<[^>]+>/g, "")
    // Clean up multiple semicolons/spaces
    .replace(/;\s*;/g, ";")
    .replace(/^[\s;]+|[\s;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractField(wikitext, fieldName) {
  // Match |fieldName = value (until next |field or end of template)
  const regex = new RegExp(`\\|\\s*${fieldName}\\s*=\\s*([\\s\\S]*?)(?=\\n\\|[\\w\\s]+=|\\n\\}\\})`, "i");
  const match = wikitext.match(regex);
  return match ? match[1].trim() : "";
}

function parseLinks(raw) {
  if (!raw) return [];
  // Links are [[Link Name]] - [[Link Name]] format
  const matches = [...raw.matchAll(/\[\[([^\]|]+?)(?:\s*\([^)]*\))?\]\]/g)];
  return matches
    .map((m) => m[1].replace(/ \(Link Skill\)/i, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("File:"));
}

function parseCategories(raw) {
  if (!raw) return [];
  const matches = [...raw.matchAll(/\[\[([^\]|]+)\]\]/g)];
  return matches
    .map((m) => m[1].trim())
    .filter((c) => c.length > 0 && !c.startsWith("File:"));
}

function parseType(raw) {
  if (!raw) return { type: "?", class: "?" };
  const clean = raw.trim().toUpperCase();
  // Format: SAGL, ETEQ, etc. First char = S(uper)/E(xtreme), rest = type
  const classChar = clean.charAt(0);
  const unitClass = classChar === "S" ? "Super" : classChar === "E" ? "Extreme" : "?";
  const type = clean.slice(1);
  const validTypes = ["AGL", "TEQ", "INT", "STR", "PHY"];
  return { type: validTypes.includes(type) ? type : "?", class: unitClass };
}

function parseDate(raw) {
  if (!raw) return null;
  // Format: "17 Feb 2020" or "2 Apr 2021"
  const match = raw.trim().match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!match) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const monthNum = months[match[2].toLowerCase().slice(0, 3)];
  if (monthNum === undefined) return null;
  return new Date(parseInt(match[3]), monthNum, parseInt(match[1]));
}

function extractImageFilename(wikitext) {
  // Try thumb apng first (animated), then thumb
  const apng = extractField(wikitext, "thumb apng");
  if (apng && apng.startsWith("http")) return apng.trim(); // Already a full URL

  // Try to extract from thumb field [[File:Card XXXXX thumb.png|...]]
  const thumb = extractField(wikitext, "thumb");
  const fileMatch = thumb.match(/Card[_ ](\d+)[_ ]thumb[^.]*\.png/);
  if (fileMatch) {
    return `Card_${fileMatch[1]}_thumb.png`;
  }

  // Try from ID
  const id = extractField(wikitext, "ID");
  if (id) {
    return `Card_10${id}_thumb.png`;
  }

  return null;
}

// Batch resolve image filenames to real Fandom CDN URLs via API (up to 50 at a time)
async function resolveImageURLs(filenames) {
  const urlMap = {};
  const toResolve = filenames.filter(f => f && f.indexOf("http") === -1);
  const alreadyURLs = filenames.filter(f => f && f.startsWith("http"));
  alreadyURLs.forEach(u => { urlMap[u] = u; });

  const batchSize = 50;
  for (let i = 0; i < toResolve.length; i += batchSize) {
    const batch = toResolve.slice(i, i + batchSize);
    const titles = batch.map(f => "File:" + f).join("|");
    const url = `${API_BASE}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=url&format=json`;
    try {
      const data = await fetch(url);
      const pages = data.query && data.query.pages ? data.query.pages : {};
      for (const pageId of Object.keys(pages)) {
        const page = pages[pageId];
        if (page.imageinfo && page.imageinfo[0] && page.imageinfo[0].url) {
          // API returns spaces in title, we use underscores — normalize both
          const fname = page.title.replace(/^File:/, "").replace(/ /g, "_");
          urlMap[fname] = page.imageinfo[0].url;
        }
      }
    } catch (e) {
      console.error("  Error resolving image batch:", e.message);
    }
    if (i + batchSize < toResolve.length) {
      await new Promise(r => setTimeout(r, 200));
    }
    if ((i / batchSize) % 10 === 0 && i > 0) {
      console.log(`  Resolved ${i}/${toResolve.length} images...`);
    }
  }
  return urlMap;
}

// ---- Tabber / multi-form helpers ----

function splitTabber(wikitext) {
  // Returns array of { label, content } for each tab, or null if no tabber
  const tabberMatch = wikitext.match(/<tabber>([\s\S]*?)<\/tabber>/i);
  if (!tabberMatch) return null;

  const tabberContent = tabberMatch[1];
  // Split on |-| which separates tabs (first tab has no prefix)
  const rawTabs = tabberContent.split(/\|-\|/);
  const tabs = [];

  for (const raw of rawTabs) {
    // Each tab: "Label=\n{{Characters...}}"
    const eqIndex = raw.indexOf("=");
    if (eqIndex === -1) continue;
    const label = raw.slice(0, eqIndex).trim();
    const content = raw.slice(eqIndex + 1).trim();
    if (label && content) {
      tabs.push({ label, content });
    }
  }
  return tabs.length > 0 ? tabs : null;
}

function parseFormData(templateText) {
  // Parse a single {{Characters}} template into form data
  const name1 = extractField(templateText, "name1");
  const name2 = extractField(templateText, "name2");
  const passive = cleanWikiMarkup(extractField(templateText, "PS description"));
  const superAttack = cleanWikiMarkup(extractField(templateText, "SA description"));
  const ultraSuperAttack = cleanWikiMarkup(extractField(templateText, "UltraSA description")) || null;
  const activeSkill = cleanWikiMarkup(extractField(templateText, "Active description")) || null;
  const activeSkillCondition = cleanWikiMarkup(extractField(templateText, "Active condition")) || null;
  const leaderSkill = cleanWikiMarkup(extractField(templateText, "LS description"));
  const imageURL = extractImageFilename(templateText);
  const links = parseLinks(extractField(templateText, "Link skill"));
  const categories = parseCategories(extractField(templateText, "Category"));

  // Ki multiplier
  const ki12 = extractField(templateText, "12 ki");
  const ki24 = extractField(templateText, "24 ki");
  let kiMultiplier = null;
  if (ki12) kiMultiplier = "12 Ki: " + ki12 + (ki24 ? " | 24 Ki: " + ki24 : "");

  // Stats
  const maxLevelHP = parseInt(extractField(templateText, "HP max")) || 0;
  const maxLevelAttack = parseInt(extractField(templateText, "ATK max")) || 0;
  const maxDefence = parseInt(extractField(templateText, "DEF max")) || 0;

  // EZA
  const ezaPassive = cleanWikiMarkup(extractField(templateText, "PS description Z")) || null;
  const ezaSuperAttack = cleanWikiMarkup(extractField(templateText, "SA description Z")) || null;
  const ezaUltraSuperAttack = cleanWikiMarkup(extractField(templateText, "UltraSA description Z")) || null;
  const ezaActiveSkill = cleanWikiMarkup(extractField(templateText, "Active description Z")) || null;
  const ezaActiveSkillCondition = cleanWikiMarkup(extractField(templateText, "Active condition Z")) || null;
  const ezaLeaderSkill = cleanWikiMarkup(extractField(templateText, "LS description Z")) || null;

  // Transform metadata
  const transformType = cleanWikiMarkup(extractField(templateText, "Transform type")) || null;
  const transformCondition = cleanWikiMarkup(extractField(templateText, "Transform condition")) || null;
  const activeSkillTransform = cleanWikiMarkup(extractField(templateText, "Active skill transform")) || null;
  const acquired = cleanWikiMarkup(extractField(templateText, "acquired")) || null;

  // EX Super Attack
  const exSuperAttack = cleanWikiMarkup(extractField(templateText, "EXSA description")) || null;
  const exSuperCondition = cleanWikiMarkup(extractField(templateText, "EXSA condition")) || null;

  return {
    name: name2 || name1 || "",
    title: name1 || "",
    passive: passive || "None",
    superAttack: superAttack || "None",
    ultraSuperAttack,
    activeSkill,
    activeSkillCondition,
    leaderSkill: leaderSkill || null,
    imageURL,
    links,
    categories,
    kiMultiplier,
    maxLevelHP,
    maxLevelAttack,
    maxDefence,
    transformType,
    transformCondition,
    activeSkillTransform,
    acquired,
    exSuperAttack,
    exSuperCondition,
    ...(ezaPassive ? { ezaPassive } : {}),
    ...(ezaSuperAttack ? { ezaSuperAttack } : {}),
    ...(ezaUltraSuperAttack ? { ezaUltraSuperAttack } : {}),
    ...(ezaActiveSkill ? { ezaActiveSkill } : {}),
    ...(ezaActiveSkillCondition ? { ezaActiveSkillCondition } : {}),
    ...(ezaLeaderSkill ? { ezaLeaderSkill } : {}),
  };
}

function parseUnit(wikitext, pageTitle) {
  // Check for tabber (multi-form cards)
  const tabs = splitTabber(wikitext);
  const baseText = tabs ? tabs[0].content : wikitext;

  const name1 = extractField(baseText, "name1");
  const name2 = extractField(baseText, "name2");
  const rarity = extractField(baseText, "rarity").toUpperCase();
  const typeRaw = extractField(baseText, "type");
  const { type, class: unitClass } = parseType(typeRaw);
  const cost = parseInt(extractField(baseText, "cost")) || 0;
  const id = extractField(baseText, "ID");
  const glbDate = extractField(baseText, "GLBdate");

  // Date filter
  const parsedDate = parseDate(glbDate);
  if (parsedDate && parsedDate.getFullYear() < MIN_YEAR) return null;
  if (!glbDate) {
    const jpDate = extractField(baseText, "JPdate");
    const parsedJP = parseDate(jpDate);
    if (parsedJP && parsedJP.getFullYear() < MIN_YEAR) return null;
  }

  // Skills
  const leaderSkill = cleanWikiMarkup(extractField(baseText, "LS description"));
  const passive = cleanWikiMarkup(extractField(baseText, "PS description"));
  const superAttack = cleanWikiMarkup(extractField(baseText, "SA description"));
  const ultraSuperAttack = cleanWikiMarkup(extractField(baseText, "UltraSA description")) || null;
  const activeSkill = cleanWikiMarkup(extractField(baseText, "Active description")) || null;
  const activeSkillCondition = cleanWikiMarkup(extractField(baseText, "Active condition")) || null;

  // EZA versions
  const ezaLeaderSkill = cleanWikiMarkup(extractField(baseText, "LS description Z")) || null;
  const ezaPassive = cleanWikiMarkup(extractField(baseText, "PS description Z")) || null;
  const ezaSuperAttack = cleanWikiMarkup(extractField(baseText, "SA description Z")) || null;
  const ezaUltraSuperAttack = cleanWikiMarkup(extractField(baseText, "UltraSA description Z")) || null;
  const ezaActiveSkill = cleanWikiMarkup(extractField(baseText, "Active description Z")) || null;
  const ezaActiveSkillCondition = cleanWikiMarkup(extractField(baseText, "Active condition Z")) || null;

  // Links and Categories
  const links = parseLinks(extractField(baseText, "Link skill"));
  const categories = parseCategories(extractField(baseText, "Category"));

  // Stats
  const maxLevelHP = parseInt(extractField(baseText, "HP max")) || 0;
  const maxLevelAttack = parseInt(extractField(baseText, "ATK max")) || 0;
  const maxDefence = parseInt(extractField(baseText, "DEF max")) || 0;

  // Ki multiplier
  const ki12 = extractField(baseText, "12 ki");
  const ki24 = extractField(baseText, "24 ki");
  let kiMultiplier = null;
  if (ki12) kiMultiplier = "12 Ki: " + ki12 + (ki24 ? " | 24 Ki: " + ki24 : "");

  // Image
  const imageURL = extractImageFilename(baseText);

  // Transform metadata from base form
  const transformType = cleanWikiMarkup(extractField(baseText, "Transform type")) || null;
  const transformCondition = cleanWikiMarkup(extractField(baseText, "Transform condition")) || null;
  const activeSkillTransform = cleanWikiMarkup(extractField(baseText, "Active skill transform")) || null;

  // EX Super Attack
  const exSuperAttack = cleanWikiMarkup(extractField(baseText, "EXSA description")) || null;
  const exSuperCondition = cleanWikiMarkup(extractField(baseText, "EXSA condition")) || null;

  if (!name2 && !name1) return null;
  if (!passive && !leaderSkill) return null;

  // Parse transformation forms from additional tabs
  const transformations = [];
  if (tabs && tabs.length > 1) {
    for (let t = 1; t < tabs.length; t++) {
      const form = parseFormData(tabs[t].content);
      if (form.name || form.passive !== "None") {
        form.tabLabel = tabs[t].label;
        // Determine form type from base form's Transform type or tab context
        if (!form.transformType && transformType) {
          form.formType = transformType;
        } else if (form.transformType) {
          form.formType = form.transformType;
        } else {
          // Infer from acquired field or label
          form.formType = form.acquired ? "Transformation" : "Alternate";
        }
        transformations.push(form);
      }
    }
  }

  return {
    name: name2 || pageTitle,
    title: name1 || "",
    rarity,
    class: unitClass,
    type,
    cost,
    id: id || pageTitle,
    imageURL,
    leaderSkill: leaderSkill || "None",
    superAttack: superAttack || "None",
    ultraSuperAttack,
    passive: passive || "None",
    activeSkill,
    activeSkillCondition,
    links,
    categories,
    kiMultiplier,
    maxLevelHP,
    maxLevelAttack,
    maxDefence,
    freeDupeHP: Math.round(maxLevelHP * 1.25),
    freeDupeAttack: Math.round(maxLevelAttack * 1.25),
    freeDupeDefence: Math.round(maxDefence * 1.25),
    rainbowHP: Math.round(maxLevelHP * 1.55),
    rainbowAttack: Math.round(maxLevelAttack * 1.55),
    rainbowDefence: Math.round(maxDefence * 1.55),
    transformations,
    ...(transformType ? { transformType } : {}),
    ...(transformCondition ? { transformCondition } : {}),
    ...(activeSkillTransform ? { activeSkillTransform } : {}),
    ...(exSuperAttack ? { exSuperAttack } : {}),
    ...(exSuperCondition ? { exSuperCondition } : {}),
    ...(ezaLeaderSkill ? { ezaLeaderSkill } : {}),
    ...(ezaPassive ? { ezaPassive } : {}),
    ...(ezaSuperAttack ? { ezaSuperAttack } : {}),
    ...(ezaUltraSuperAttack ? { ezaUltraSuperAttack } : {}),
    ...(ezaActiveSkill ? { ezaActiveSkill } : {}),
    ...(ezaActiveSkillCondition ? { ezaActiveSkillCondition } : {}),
    glbReleaseDate: glbDate || null,
  };
}

// ---- Main ----
async function main() {
  console.log("=== Dokkan Battle Wiki Scraper ===\n");

  // Step 1: Gather all page titles
  console.log("Step 1: Fetching page lists...");
  const allTitles = new Set();
  for (const cat of CATEGORIES) {
    const pages = await getCategoryPages(cat);
    pages.forEach((p) => allTitles.add(p));
    console.log(`  ${cat}: ${pages.length} pages`);
  }
  console.log(`  Total unique pages: ${allTitles.size}\n`);

  // Step 2: Fetch and parse each page
  console.log("Step 2: Fetching unit data (this takes a few minutes)...");
  const titles = [...allTitles];
  const units = [];
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    try {
      const wikitext = await getWikitext(title);
      if (!wikitext) { skipped++; continue; }

      const unit = parseUnit(wikitext, title);
      if (unit) {
        units.push(unit);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      if (errors <= 5) console.log(`  Error on "${title}": ${err.message}`);
    }

    // Progress update every 50 units
    if ((i + 1) % 50 === 0 || i === titles.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = (((i + 1) / titles.length) * 100).toFixed(1);
      const eta = ((Date.now() - startTime) / (i + 1) * (titles.length - i - 1) / 1000).toFixed(0);
      process.stdout.write(`\r  Progress: ${i + 1}/${titles.length} (${pct}%) | ${units.length} units | ${elapsed}s elapsed | ~${eta}s remaining   `);
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log("\n");

  // Step 3: Resolve image URLs via Fandom API
  console.log("Step 3: Resolving image URLs...");
  const allFilenames = new Set();
  for (const u of units) {
    if (u.imageURL && u.imageURL.indexOf("http") === -1) allFilenames.add(u.imageURL);
    for (const t of u.transformations) {
      if (t.imageURL && t.imageURL.indexOf("http") === -1) allFilenames.add(t.imageURL);
    }
  }
  console.log(`  ${allFilenames.size} unique image filenames to resolve`);
  const urlMap = await resolveImageURLs([...allFilenames]);
  const resolved = Object.keys(urlMap).length;
  console.log(`  Resolved ${resolved}/${allFilenames.size} images`);

  // Apply resolved URLs
  for (const u of units) {
    if (u.imageURL && urlMap[u.imageURL]) {
      u.imageURL = urlMap[u.imageURL];
    } else if (u.imageURL && u.imageURL.indexOf("http") === -1) {
      u.imageURL = null; // Could not resolve
    }
    for (const t of u.transformations) {
      if (t.imageURL && urlMap[t.imageURL]) {
        t.imageURL = urlMap[t.imageURL];
      } else if (t.imageURL && t.imageURL.indexOf("http") === -1) {
        t.imageURL = null;
      }
    }
  }

  console.log(`\nStep 4: Writing ${OUTPUT_FILE}...`);
  const withTransforms = units.filter(u => u.transformations.length > 0).length;
  const withEZA = units.filter(u => u.ezaPassive).length;
  const totalForms = units.reduce((s, u) => s + u.transformations.length, 0);
  console.log(`  Total units scraped: ${units.length}`);
  console.log(`  Units with transformations/exchange/tag/etc: ${withTransforms} (${totalForms} extra forms)`);
  console.log(`  Units with EZA: ${withEZA}`);
  console.log(`  Skipped (pre-${MIN_YEAR} or empty): ${skipped}`);
  console.log(`  Errors: ${errors}`);

  // Sort by ID (newest first)
  units.sort((a, b) => {
    const idA = parseInt(a.id) || 0;
    const idB = parseInt(b.id) || 0;
    return idB - idA;
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(units, null, 2));
  const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`  File size: ${sizeMB} MB`);
  console.log("\nDone! Rename to dokkan-data.json to use in the guide.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
