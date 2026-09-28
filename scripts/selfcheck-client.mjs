/**
 * Client-half self-check: run the REAL lib/client.js inside a REAL Chromium
 * (headless Edge) and assert the boot-cover behaviour on a real DOM.
 *
 *   cd _hei-poster/plugin
 *   node scripts/selfcheck-client.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (edge === undefined) {
  console.error("[selfcheck-client] no headless browser found; tried:");
  for (const p of EDGE_CANDIDATES) console.error("  " + p);
  process.exit(2);
}

const TYPE = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };

const server = createServer((req, res) => {
  let pathname = "/";
  try { pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname; } catch { /* keep root */ }
  // Match the host route on the RAW path (forward slashes), then normalize:
  // path.normalize() turns "/" into "\\" on Windows and would break the prefix test.
  let rel = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const assetPrefix = "plugins/dsh-client-hei-poster/assets/";
  if (rel.startsWith(assetPrefix)) rel = "assets/" + rel.slice(assetPrefix.length);
  rel = normalize(rel);
  const file = join(PACKAGE_ROOT, rel === "" ? "test/harness.html" : rel);
  if (!file.startsWith(PACKAGE_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "X-Content-Type-Options": "nosniff" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPE[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = "http://127.0.0.1:" + port + "/test/harness.html";

const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--window-size=1280,800", "--virtual-time-budget=15000", "--dump-dom", url];

const dump = await new Promise((resolve, reject) => {
  const child = spawn(edge, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = "";
  child.stdout.on("data", (c) => { out += c.toString("utf8"); });
  child.stderr.on("data", (c) => { err += c.toString("utf8"); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ out, err, code }));
  setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 90000);
});

server.close();

const match = /<pre id="results">([\s\S]*?)<\/pre>/.exec(dump.out);
if (match === null) {
  console.error("[selfcheck-client] the harness never wrote its results.");
  console.error("  edge exit code: " + dump.code);
  console.error("  stderr tail: " + dump.err.slice(-600));
  console.error("  stdout tail: " + dump.out.slice(-600));
  process.exit(1);
}

function decode(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, String.fromCharCode(34)).replace(/&#39;/g, String.fromCharCode(39))
    .replace(/&amp;/g, "&");
}

let results;
try { results = JSON.parse(decode(match[1])); } catch (error) {
  console.error("[selfcheck-client] could not parse the harness results: " + error.message);
  process.exit(1);
}

let passed = 0;
const failures = [];
for (const row of results) {
  if (row.ok) { passed += 1; console.log("  ok   " + row.label); }
  else { failures.push(row.label + (row.detail ? " -- " + row.detail : "")); console.log("  FAIL " + row.label + (row.detail ? " -- " + row.detail : "")); }
}
console.log("");
console.log("summary");
console.log("  passed: " + passed);
console.log("  failed: " + failures.length);
if (failures.length > 0) process.exit(1);
console.log("  all client-half self-checks passed");
