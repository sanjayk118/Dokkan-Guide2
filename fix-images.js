/**
 * Fixes broken image URLs in dokkan-data.json by querying the wiki API
 * for the actual image file URLs, and sorts units by release date (newest first).
 *
 * Usage: node fix-images.js
 */

const https = require("https");
const fs = require("fs");

const API_BASE = "https://dbz-dokkanbattle.fandom.com/api.php";
const INPUT_FILE = "dokkan-data.json";
const OUTPUT_FILE = "dokkan-data.json";
const RATE_LIMIT_MS = 200;
const BATCH_SIZE = 50; // Wiki API supports up to 50 titles per request

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "DokkanGuide/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error")); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Parse "11 Oct 2024" to a Date object
function parseDate(str) {
  if (!str) return new Date(0);
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const m = str.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!m) return new Date(0);
  const mon = months[m[2].toLowerCase().slice(0,3)];
  if (mon === undefined) return new Date(0);
  return new Date(parseInt(m[3]), mon, parseInt(m[1]));
}

async function getImageURLs(fileNames) {
  // Use the wiki API to get actual image URLs for a batch of File: titles
  const titles = fileNames.join("|");
  const url = `${API_BASE}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=url&format=json`;
  const result = await fetch(url);
  const pages = result.query.pages;
  const urlMap = {};
  for (const pageId of Object.keys(pages)) {
    const page = pages[pageId];
    if (page.imageinfo && page.imageinfo[0]) {
      urlMap[page.title] = page.imageinfo[0].url;
    }
  }
  return urlMap;
}

async function main() {
  console.log("Loading data...");
  const data = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));

  // Find units with broken (constructed) image URLs
  const needsFix = data.filter((u) => u.imageURL && u.imageURL.includes("/thumb/Card_"));
  console.log(`Units needing image fix: ${needsFix.length}`);
  console.log(`Units with working images: ${data.length - needsFix.length}`);

  if (needsFix.length > 0) {
    // Extract Card IDs and build File: titles
    const cardIdMap = new Map(); // cardId -> unit references
    for (const u of needsFix) {
      const match = u.imageURL.match(/Card_(\d+)_thumb/);
      if (match) {
        const cardId = match[1];
        if (!cardIdMap.has(cardId)) cardIdMap.set(cardId, []);
        cardIdMap.get(cardId).push(u);
      }
    }

    const allCardIds = [...cardIdMap.keys()];
    console.log(`\nFetching ${allCardIds.length} image URLs in batches of ${BATCH_SIZE}...`);

    let fixed = 0;
    for (let i = 0; i < allCardIds.length; i += BATCH_SIZE) {
      const batch = allCardIds.slice(i, i + BATCH_SIZE);
      const fileNames = batch.map((id) => `File:Card ${id} thumb.png`);

      try {
        const urlMap = await getImageURLs(fileNames);

        for (const id of batch) {
          const fileTitle = `File:Card ${id} thumb.png`;
          if (urlMap[fileTitle]) {
            const units = cardIdMap.get(id);
            for (const u of units) {
              u.imageURL = urlMap[fileTitle];
              fixed++;
            }
          }
        }
      } catch (err) {
        console.log(`  Error on batch ${i}: ${err.message}`);
      }

      process.stdout.write(`\r  Progress: ${Math.min(i + BATCH_SIZE, allCardIds.length)}/${allCardIds.length} | Fixed: ${fixed}   `);
      await sleep(RATE_LIMIT_MS);
    }

    console.log(`\n\nFixed ${fixed} image URLs.`);
  }

  // Sort by release date (newest first)
  console.log("\nSorting by release date (newest first)...");
  data.sort((a, b) => {
    const dateA = parseDate(a.glbReleaseDate);
    const dateB = parseDate(b.glbReleaseDate);
    return dateB.getTime() - dateA.getTime();
  });

  // Verify sort
  if (data.length > 0) {
    console.log(`  Newest: ${data[0].name} (${data[0].glbReleaseDate})`);
    console.log(`  Oldest: ${data[data.length-1].name} (${data[data.length-1].glbReleaseDate})`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\nSaved to ${OUTPUT_FILE}`);

  // Verify images
  const working = data.filter((u) => u.imageURL && !u.imageURL.includes("/thumb/Card_")).length;
  const still_broken = data.filter((u) => u.imageURL && u.imageURL.includes("/thumb/Card_")).length;
  console.log(`Working images: ${working}, Still broken: ${still_broken}, No image: ${data.filter((u) => !u.imageURL).length}`);
}

main().catch(console.error);
