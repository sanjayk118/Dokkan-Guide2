/**
 * Embeds Reddit community gameplay data into dokkan-guide.html
 * Usage: node embed-reddit.js
 */

const fs = require("fs");

const REDDIT_FILE = "dokkan-reddit.json";
const HTML_FILE = "dokkan-guide.html";

if (!fs.existsSync(REDDIT_FILE)) {
  console.error(`Error: ${REDDIT_FILE} not found. Run "node scrape-reddit.js" first.`);
  process.exit(1);
}
if (!fs.existsSync(HTML_FILE)) {
  console.error(`Error: ${HTML_FILE} not found.`);
  process.exit(1);
}

const redditData = JSON.parse(fs.readFileSync(REDDIT_FILE, "utf-8"));
let html = fs.readFileSync(HTML_FILE, "utf-8");

const marker = "const EMBEDDED_REDDIT";
const scriptTag = `<script>\nconst EMBEDDED_REDDIT = ${JSON.stringify(redditData)};\n</script>`;

if (html.includes(marker)) {
  html = html.replace(
    /<script>\s*const EMBEDDED_REDDIT\s*=[\s\S]*?<\/script>/,
    scriptTag
  );
  console.log("Updated existing EMBEDDED_REDDIT.");
} else {
  const insertPoint = html.indexOf("const EMBEDDED_DATA");
  if (insertPoint !== -1) {
    const scriptStart = html.lastIndexOf("<script>", insertPoint);
    html = html.slice(0, scriptStart) + scriptTag + "\n" + html.slice(scriptStart);
  } else {
    html = html.replace("</head>", scriptTag + "\n</head>");
  }
  console.log("Inserted EMBEDDED_REDDIT.");
}

fs.writeFileSync(HTML_FILE, html);
console.log(`Done! ${redditData.unitsWithInsights} units with gameplay insights.`);
