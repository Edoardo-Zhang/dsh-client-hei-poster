/**
 * Bundle the browser half into lib/client.js.
 *
 *   cd _hei-poster/plugin
 *   node scripts/build-client.mjs
 *
 * The output is a `window.__ModuleLoader__.load({id, factory})` call whose factory
 * returns the module exports ({ inject, apply }) that DSH's client module loader
 * expects. React stays external: the loader hands the packaged bundle the host's
 * own copies through the injected `require` (see external below).
 *
 * Every side effect the browser half performs lives inside the factory, because
 * that is when the module is actually instantiated by the loader.
 */

import { build } from "esbuild";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "dsh-client-hei-poster";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(PACKAGE_ROOT, "lib", "client.js");

await build({
  absWorkingDir: PACKAGE_ROOT,
  entryPoints: ["src/client/index.tsx"],
  outfile: "lib/client.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: false,
  loader: { ".css": "text" },
  // Exactly the four React entries the host seeds into every client module's
  // require() (L-2). Nothing else may be listed here: a spec that is not in the
  // host's staticModules table would produce a require() that throws at load time.
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  banner: {
    js: "window.__ModuleLoader__.load({id:" + JSON.stringify(ID) + ",factory:(require)=>{var module={exports:{}};var exports=module.exports;",
  },
  footer: {
    js: "return module.exports;}});",
  },
  logLevel: "warning",
});

// Fail loudly if the wrapper contract ever drifts.
const output = readFileSync(OUT_FILE, "utf8");
const expectedPrologue = "window.__ModuleLoader__.load({id:" + JSON.stringify(ID);
if (!output.startsWith(expectedPrologue)) {
  console.error("[build-client] unexpected prologue in lib/client.js:");
  console.error("  " + output.slice(0, 120));
  process.exit(1);
}
if (!output.trimEnd().endsWith("return module.exports;}});")) {
  console.error("[build-client] unexpected epilogue in lib/client.js");
  process.exit(1);
}

console.log(
  "[build-client] wrote " + relative(PACKAGE_ROOT, OUT_FILE) + " (" + statSync(OUT_FILE).size + " bytes)",
);
