import fs from "node:fs";
const c = fs.readFileSync(".env.production.local", "utf8");
const idx = c.indexOf("GOOGLE_SERVICE_ACCOUNT_JSON");
const endIdx = c.indexOf("\n", idx + 400);
const chunk = c.slice(idx, idx + 200);
console.log("raw first 200 chars:");
console.log(JSON.stringify(chunk));
