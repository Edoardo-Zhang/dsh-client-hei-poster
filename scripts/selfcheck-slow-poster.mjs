/**
 * Regression guard: a COLD start must still animate.
 *
 *   cd _hei-poster/plugin
 *   node scripts/selfcheck-slow-poster.mjs            # poster B delayed 700 ms
 *   HEI_SLOW_POSTER_MS=1500 node scripts/selfcheck-slow-poster.mjs
 *
 * Why this exists: on a cold cache the two posters finish at different times. The
 * first version of the hand-over fired on the FIRST load event, called start()
 * while the other poster still had naturalWidth === 0, the engine self-degraded
 * to static, and nothing ever re-armed -> the cover stayed static for the whole
 * appearance. Cached (warm) starts never showed it, which is why the normal
 * selfcheck passed.
 *
 * poster B is served slowly on purpose; the assertion is that the cover still
 * ends up animated and that the paper-flash phase really shows poster B.
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { findBrowser } from "./lib/browser.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SLOW_MS = Number.parseInt(process.env.HEI_SLOW_POSTER_MS ?? "700", 10);
const SLOW_FILE = process.env.HEI_SLOW_POSTER_FILE ?? "poster-b.png";
let edge;
try {
  edge = await findBrowser();
} catch (error) {
  console.error("[slow-poster] " + error.message);
  process.exit(2);
}
console.log("[slow-poster] browser: " + edge);

const PAGE = [
  "<!doctype html><html><head><meta charset=utf-8><style>body{margin:0}</style></head><body>",
  "<pre id=results>pending</pre>",
  '<script>window.__ModuleLoader__={load:function(r){window.__reg=r;}}</' + "script>",
  "<script src=/lib/client.js></" + "script>",
  "<script>",
  "function finish(payload) {",
  "  var box = document.getElementById('results');",
  "  box.textContent = JSON.stringify(payload);",
  "  box.setAttribute('data-ready', '1');",
  "}",
  "var info = { waits: 0, errors: [], logs: [] };",
  "info.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;",
  "window.addEventListener('error', function (e) { info.errors.push(String(e.message)); });",
  "try {",
  "  var mod = window.__reg.factory(function (s) { throw new Error('require ' + s); });",
  "  mod.apply({ effect: function (fn) { return fn(); } });",
  "} catch (e) { info.errors.push('apply threw: ' + e.message); finish(info); }",
  "// The posters live inside the overlay shadow root, so document.querySelectorAll\n  // finds nothing - always read them through the debug handle.",
  "function layersOf() {",
  "  var h = window.__HEI_POSTER__;",
  "  var root = h && h.stage ? h.stage : document;",
  "  return root.querySelectorAll('.poster');",
  "}",
  "function read(el) {",
  "  var cs = getComputedStyle(el);",
  "  return { opacity: Number(cs.opacity), display: cs.display, natW: el.naturalWidth || 0, src: (el.getAttribute('src') || '').split('/').pop() };",
  "}",
  "function poll() {",
  "  info.waits += 1;",
  "  var h = window.__HEI_POSTER__;",
  "  var imgs = layersOf();",
  "  info.layers = [];",
  "  for (var i = 0; i < imgs.length; i += 1) info.layers.push(read(imgs[i]));",
  "  info.mode = h ? h.motionMode : 'no-handle';",
  "  if (h && h.motionMode === 'animated') {",
  "    h.seekMotion(0.5);",
  "    setTimeout(function () {",
  "      var imgs2 = layersOf();",
  "      info.layers = [];",
  "      for (var j = 0; j < imgs2.length; j += 1) info.layers.push(read(imgs2[j]));",
  "      info.modeAfterSeek = h.motionMode;",
  "      info.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;",
  "      finish(info);",
  "    }, 40);",
  "    return;",
  "  }",
  "  if (info.waits > 240) { info.gaveUp = true; finish(info); return; }",
  "  setTimeout(poll, 50);",
  "}",
  "poll();",
  "</" + "script></body></html>",
].join("\n");

const TYPE = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
const server = createServer((req, res) => {
  let pathname = "/";
  try { pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname; } catch { /* keep root */ }

  if (pathname === "/" || pathname === "/slow.html") {
    res.writeHead(200, { "Content-Type": TYPE[".html"], "Cache-Control": "no-store" });
    res.end(PAGE);
    return;
  }

  // Same shape as the real host route: /plugins/<id>/assets/<file> -> assets/<file>,
  // and the bundle lives at /lib/client.js. Getting this wrong 404s the bundle and
  // the run dies with "apply threw" instead of testing anything.
  let rel = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const prefix = "plugins/dsh-client-hei-poster/assets/";
  if (rel.startsWith(prefix)) rel = "assets/" + rel.slice(prefix.length);
  rel = normalize(rel);
  const file = join(PACKAGE_ROOT, rel);

  const send = () => {
    if (!file.startsWith(PACKAGE_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { "Content-Type": TYPE[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  };

  // Delay exactly one poster so the load events cannot arrive together.
  if (rel.endsWith(SLOW_FILE)) setTimeout(send, SLOW_MS);
  else send();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + server.address().port + "/slow.html";

// A dedicated profile: two headless runs sharing the default one hand off to each
// other and return ZERO bytes with exit code 0 - a silent false green.
const profileDir = join(tmpdir(), "hei-edge-slow-" + process.pid);
mkdirSync(profileDir, { recursive: true });

const dump = await new Promise((resolve, reject) => {
  const child = spawn(edge, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--user-data-dir=" + profileDir, "--window-size=1280,800",
    "--virtual-time-budget=20000", "--dump-dom", url],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c.toString("utf8"); });
  child.stderr.on("data", (c) => { err += c.toString("utf8"); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ out, err, code }));
  // child.kill() leaves the renderer/browser children alive on Windows; those
  // leftovers then hold the profile and every later run returns 0 bytes.
  setTimeout(() => { try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }, 90000);
});
server.close();
// Best effort: Edge may still be releasing files in the profile directory.
try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, the OS cleans it up */ }

const match = /<pre id="results"([^>]*)>([\s\S]*?)<\/pre>/.exec(dump.out);
if (match === null) {
  // Keep the raw DOM next to the temp dir: without it every failure here is guesswork.
  const spill = join(tmpdir(), "hei-slow-poster-dom.html");
  writeFileSync(spill, dump.out, "utf8");
  console.error("[slow-poster] the page never wrote results (edge exit " + dump.code + ")");
  console.error("  dumped bytes: " + dump.out.length + "  saved to " + spill);
  console.error("  head: " + JSON.stringify(dump.out.slice(0, 300)));
  console.error("  stderr tail: " + dump.err.slice(-400));
  process.exit(1);
}
if (!/\bdata-ready="1"/.test(match[1])) {
  console.error("[slow-poster] results are not marked ready; the dump was taken mid-run");
  process.exit(1);
}
const info = JSON.parse(match[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
const layers = info.layers ?? [];
const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail === undefined ? "" : " -- " + detail));
  if (!ok) failures.push(label);
};

console.log("[slow-poster] poster " + SLOW_FILE + " delayed by " + SLOW_MS + "ms; reduced-motion=" + info.reducedMotion);
check("both posters end up loaded", layers.length === 2 && layers.every((l) => l.natW > 0), JSON.stringify(layers.map((l) => l.natW)));
check("the cover is ANIMATED despite the staggered loads", info.modeAfterSeek === "animated", "mode=" + info.mode + (info.gaveUp ? " (gave up waiting)" : ""));
check("both layers are display:block", layers.length === 2 && layers.every((l) => l.display === "block"), JSON.stringify(layers.map((l) => l.display)));
check("paper-flash phase 0.5 shows poster B only", layers.length === 2 && layers[1] !== undefined && layers[1].opacity >= 0.98 && layers[0].opacity <= 0.02,
  "opacity=" + JSON.stringify(layers.map((l) => l.opacity)));
check("no page errors", (info.errors ?? []).length === 0, JSON.stringify(info.errors));

if (failures.length > 0) {
  console.log("\n[slow-poster] " + failures.length + " failed");
  process.exit(1);
}
console.log("\n[slow-poster] passed: a cold, staggered start still animates");
