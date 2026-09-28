/**
 * Headless Chromium discovery.
 *
 * Every script that drives a browser must PROVE the browser answers before using
 * it. Edge 154 (September 2026) exits 0 while printing nothing at all - it hands
 * the request to a running instance - so "the file exists" is not enough, and a
 * silent 0-byte dump turns every assertion into a false negative.
 *
 * Order: HEI_BROWSER, Chrome, Edge. The first one that renders about:blank wins.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const CANDIDATES = [
  process.env.HEI_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((p) => typeof p === "string" && p.length > 0 && existsSync(p));

/** True when this binary renders a page and prints its DOM on stdout. */
function responds(exe) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--dump-dom", "about:blank"],
        { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
      child.on("error", () => done(false));
      child.on("close", () => done(out.includes("<html")));
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(out.includes("<html")); }, 30000);
    } catch {
      done(false);
    }
  });
}

/**
 * @returns {Promise<string>} path of a browser that really works.
 * @throws when no candidate answers - the caller must not fall back to a silent
 *   winner, because "no output" would be read as "no failures".
 */
export async function findBrowser() {
  const tried = [];
  for (const exe of CANDIDATES) {
    tried.push(exe);
    if (await responds(exe)) return exe;
  }
  throw new Error("no headless browser answered the probe; tried:\n  " + tried.join("\n  ") +
    "\n  set HEI_BROWSER=<path to chrome.exe> to override");
}
