/**
 * Self-check for the host half — run with:
 *
 *   cd _hei-poster/plugin
 *   node scripts/selfcheck-host.mjs
 *
 * It copies src/index.js plus a throw-away assets/ folder into a temporary
 * directory (the real assets/ is never touched, nothing is written into the
 * package), imports the copy, and drives the registered HTTP handlers with real
 * streams: status codes, headers, ETag/304, Range/206, 416, HEAD, 405, the
 * whitelist and the teardown path.
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Temporary package copies; removed again when every check passes. */
const WORK_DIRS = [];
const ID = "dsh-client-hei-poster";
const PREFIX = "/plugins/" + ID + "/assets/";
const ASSET_NAMES = [
  "poster-a.png",
  "poster-b.png",
];
const EXPECTED_TYPE = {
  png: "image/png",
};

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ok   " + label);
  } else {
    failures.push(label + (detail === undefined ? "" : " -- " + detail));
    console.log("  FAIL " + label + (detail === undefined ? "" : " -- " + detail));
  }
}

function section(title) {
  console.log("\n" + title);
}

/** Build a package copy whose assets/ holds exactly the names given. */
function makePackage(names) {
  const work = mkdtempSync(join(tmpdir(), "hei-hostcheck-"));
  WORK_DIRS.push(work);
  mkdirSync(join(work, "src"), { recursive: true });
  mkdirSync(join(work, "assets"), { recursive: true });
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: ID, type: "module" }), "utf8");
  copyFileSync(join(PACKAGE_ROOT, "src", "index.js"), join(work, "src", "index.js"));
  for (const name of names) {
    const body = Buffer.from("hei-selfcheck:" + name);
    writeFileSync(join(work, "assets", name), body);
  }
  return { work, moduleUrl: pathToFileURL(join(work, "src", "index.js")).href };
}

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.body = Buffer.alloc(0);
    this.headersSent = false;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers || {};
    this.headersSent = true;
    return this;
  }
  _write(chunk, encoding, callback) {
    this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
    callback();
  }
  end(chunk, encoding, callback) {
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
      this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
    }
    const done = typeof chunk === "function" ? chunk : (typeof encoding === "function" ? encoding : callback);
    return super.end(undefined, undefined, done);
  }
}

/** Drive one registered handler to completion. */
async function request(handler, options) {
  const settings = options || {};
  const res = new FakeResponse();
  const finished = once(res, "finish");
  handler({ method: settings.method === undefined ? "GET" : settings.method, url: settings.url, headers: settings.headers || {} }, res);
  await finished;
  return res;
}

/** A minimal stand-in for the host webServer: exact-path routing only. */
function createContext() {
  const routes = new Map();
  const cleanups = [];
  const ctx = {
    logger: { info() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect(fn, label) {
      const dispose = fn();
      cleanups.push({ dispose, label });
      return dispose;
    },
  };
  return {
    ctx,
    routes,
    cleanups,
    /** What the host does for an unknown exact path. */
    async fetch(url, options) {
      const path = new URL(url, "http://dsh.local").pathname;
      const route = routes.get(path);
      if (route === undefined) return { statusCode: 404, headers: {}, body: Buffer.alloc(0), unregistered: true };
      return request(route.handler, { ...options, url });
    },
  };
}

// ---------------------------------------------------------------- 1. manifest

section("1. plugin contract");

const full = makePackage(ASSET_NAMES);
const mod = await import(full.moduleUrl);

check("inject is exactly [\"webServer\"]", JSON.stringify(mod.inject) === JSON.stringify(["webServer"]), JSON.stringify(mod.inject));
check("apply is exported", typeof mod.apply === "function");
check("ASSET_PREFIX matches the client half", mod.ASSET_PREFIX === PREFIX, mod.ASSET_PREFIX);

const host = createContext();
mod.apply(host.ctx);
check("apply() registers through ctx.effect", host.cleanups.length === 1 && host.cleanups.length === 1);
check("every route is kind:exact", [...host.routes.values()].every((route) => route.kind === "exact"));
check("all " + ASSET_NAMES.length + " assets are routed", host.routes.size === ASSET_NAMES.length, String(host.routes.size));
check("every route lives under the asset prefix", [...host.routes.keys()].every((path) => path.startsWith(PREFIX)));
check("no route escapes the prefix", [...host.routes.keys()].every((path) => !path.includes("..")));
check("MIME types are pinned per extension", [...host.routes.keys()].every((path) => {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return EXPECTED_TYPE[ext] !== undefined;
}));

// ---------------------------------------------------------------- 2. HTTP

section("2. HTTP semantics of a registered asset");

const asset = PREFIX + "poster-a.png";
const assetBody = Buffer.from("hei-selfcheck:poster-a.png");

let res = await host.fetch(asset);
check("GET 200", res.statusCode === 200, String(res.statusCode));
check("Content-Type image/png", res.headers["Content-Type"] === "image/png", String(res.headers["Content-Type"]));
check("Content-Length matches the file", res.headers["Content-Length"] === String(assetBody.length));
check("full body served byte-for-byte", res.body.equals(assetBody));
check("Accept-Ranges: bytes", res.headers["Accept-Ranges"] === "bytes");
check("nosniff is set", res.headers["X-Content-Type-Options"] === "nosniff");
check("ETag is a weak validator", typeof res.headers.ETag === "string" && res.headers.ETag.startsWith("W/\""));

const etag = res.headers.ETag;
res = await host.fetch(asset, { headers: { "if-none-match": etag } });
check("If-None-Match -> 304", res.statusCode === 304, String(res.statusCode));
check("304 has no body", res.body.length === 0);

res = await host.fetch(asset, { headers: { range: "bytes=0-3" } });
check("Range 0-3 -> 206", res.statusCode === 206, String(res.statusCode));
check("Content-Range is correct", res.headers["Content-Range"] === "bytes 0-3/" + assetBody.length, String(res.headers["Content-Range"]));
check("range body is the first 4 bytes", res.body.equals(assetBody.subarray(0, 4)));

res = await host.fetch(asset, { headers: { range: "bytes=-4" } });
check("suffix range bytes=-4 -> last 4 bytes", res.statusCode === 206 && res.body.equals(assetBody.subarray(assetBody.length - 4)));

res = await host.fetch(asset, { headers: { range: "bytes=999999-" } });
check("unsatisfiable range -> 416", res.statusCode === 416, String(res.statusCode));
check("416 carries Content-Range", res.headers["Content-Range"] === "bytes */" + assetBody.length);

res = await host.fetch(asset, { method: "HEAD" });
check("HEAD 200 with Content-Length, no body", res.statusCode === 200 && res.headers["Content-Length"] === String(assetBody.length) && res.body.length === 0);

res = await host.fetch(asset, { method: "POST" });
check("POST -> 405", res.statusCode === 405, String(res.statusCode));
check("405 advertises Allow: GET, HEAD", res.headers.Allow === "GET, HEAD", String(res.headers.Allow));

// ---------------------------------------------------------------- 3. whitelist

section("3. whitelist and path safety");

res = await host.fetch(PREFIX + "does-not-exist.png");
check("unlisted name inside the prefix -> 404", res.statusCode === 404 && res.unregistered === true);

res = await host.fetch("/plugins/" + ID + "/assets/../package.json");
check("path traversal out of the prefix -> 404", res.statusCode === 404);

res = await host.fetch("/plugins/" + ID + "/../secrets.txt");
check("traversal above the plugin root -> 404", res.statusCode === 404);

res = await host.fetch("/index.html");
check("unrelated path -> 404 (never routed here)", res.statusCode === 404);

// Even if a future host routed a wider prefix at us, the handler itself refuses
// anything that is not an exact whitelisted pathname.
const anyRoute = host.routes.get(asset);
res = await request(anyRoute.handler, { url: PREFIX + "../../package.json" });
check("handler re-checks the whitelist (defence in depth)", res.statusCode === 404, String(res.statusCode));

// ---------------------------------------------------------------- 4. teardown

section("4. teardown and missing assets");

host.cleanups[0].dispose();
check("dispose removes every route", host.routes.size === 0, String(host.routes.size));
host.cleanups[0].dispose();
check("dispose is idempotent", host.routes.size === 0);

const partial = makePackage([ASSET_NAMES[0]]);
const partialMod = await import(partial.moduleUrl);
const partialHost = createContext();
partialMod.apply(partialHost.ctx);
check("missing asset files are skipped, not fatal", partialHost.routes.size === 1, String(partialHost.routes.size));
res = await partialHost.fetch(PREFIX + ASSET_NAMES[0]);
check("present png is still served", res.statusCode === 200 && res.headers["Content-Type"] === "image/png");
res = await partialHost.fetch(PREFIX + ASSET_NAMES[1]);
check("absent asset is a clean 404", res.statusCode === 404);
partialHost.cleanups[0].dispose();

const none = makePackage([]);
const noneMod = await import(none.moduleUrl);
const noneHost = createContext();
noneMod.apply(noneHost.ctx);
check("an empty assets/ folder mounts nothing and throws nothing", noneHost.routes.size === 0);

section("summary");
console.log("  passed: " + passed);
console.log("  failed: " + failures.length);
if (failures.length > 0) {
  for (const failure of failures) console.log("   - " + failure);
  process.exitCode = 1;
  console.log("  temp work dirs kept for inspection: " + WORK_DIRS.join(", "));
} else {
  console.log("  all host-half self-checks passed");
  for (const dir of WORK_DIRS) rmSync(dir, { recursive: true, force: true });
  console.log("  removed " + WORK_DIRS.length + " temp work dir(s)");
}
