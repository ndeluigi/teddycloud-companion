// Generate docs/GUIDE.md from server/static/guide.js (the in-app guide), all four languages.
//   node scripts/gen_guide_md.js
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "server", "static", "guide.js"), "utf8") + "\n;return GUIDE;";
const GUIDE = new Function(src)();
const LANGS = [["en", "English"], ["de", "Deutsch"], ["fr", "Français"], ["it", "Italiano"]];
let md = "# User guide\n\n*Generated from `server/static/guide.js` (the guide shown inside the app) by `scripts/gen_guide_md.js` — edit that file, not this one.*\n\n";
md += LANGS.map(([code, name]) => `[${name}](#${code})`).join(" · ") + "\n";
for (const [code, name] of LANGS) {
  md += `\n<a id="${code}"></a>\n\n## ${name}\n`;
  for (const s of GUIDE) {
    md += `\n### ${s.icon} ${s.title[code]}\n\n`;
    for (const it of s.items) md += `- ${it[code]}\n`;
  }
}
fs.writeFileSync(path.join(__dirname, "..", "docs", "GUIDE.md"), md);
console.log("docs/GUIDE.md written:", md.length, "chars");
