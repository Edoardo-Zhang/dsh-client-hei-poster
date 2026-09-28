/**
 * dsh-client-hei-poster — Host half.
 *
 * Sole job: expose the package's `assets/` directory over the DSH web server as
 *   /plugins/dsh-client-hei-poster/assets/<relative-path>
 * so the browser half (a client plugin) can point <img> at a real URL.
 *
 * Design rules taken from the verified reference implementation
 * (dsh-client-liang-intensity-skin) and from DSH-PLUGIN-PROTOCOL.md:
 *   - `inject = ["webServer"]` is declared, so reading ctx.webServer is legal and the
 *     route is only registered once the service exists.
 *   - No third-party imports: `node:` builtins only. Nothing can leak into the
 *     profile's hoisted node_modules and shadow a host dependency.
 *   - The route table is a whitelist built once at module load from the fixed asset
 *     list. Anything that is not in that Map is never served (no path traversal).
 *   - Missing asset files are skipped silently: a missing poster degrades to a 404,
 *     and the browser half already falls back to its paper-tone background.
 */

import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Package id; also the URL path segment used by the DSH web server. */
export const PACKAGE_ID = "dsh-client-hei-poster";

/** Public URL prefix of the asset directory. Must match the browser half. */
export const ASSET_PREFIX = `/plugins/${PACKAGE_ID}/assets/`;

/**
 * The fixed asset manifest: [file name, MIME type].
 * File names are exact; nothing else is ever served.
 */
const ASSET_SPECS = [
  ["poster-a.png", "image/png"],
  ["poster-b.png", "image/png"],
];

/**
 * Parse a single-range `Range` header.
 * Inlined on purpose: this package ships exactly two halves, and a third file in
 * src/ would need its own entry in the package manifest.
 *
 * @param {string | undefined} value Raw header value.
 * @param {number} size Total resource size in bytes.
 * @returns {{start: number, end: number} | null | false} Range, null for "whole
 *   resource", false for "unsatisfiable / malformed".
 */
export function parseSingleRange(value, size) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.startsWith("bytes=") || value.includes(",")) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return false;

  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
    if (start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/** Build the whitelist of served URLs from the files that actually exist. */
function buildAssetTable() {
  /** @type {Map<string, {path: string, type: string, size: number, etag: string}>} */
  const assets = new Map();
  for (const [name, type] of ASSET_SPECS) {
    const path = fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      assets.set(`${ASSET_PREFIX}${name}`, {
        path,
        type,
        size: info.size,
        etag: `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
      });
    } catch {
      // Optional asset: a missing file is a 404 plus the site's CSS fallback.
    }
  }
  return assets;
}

function send(res, status, headers = {}) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end();
}

function createAssetHandler(assets, activeStreams) {
  return (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      send(res, 405, { Allow: "GET, HEAD" });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://dsh.local").pathname;
    } catch {
      send(res, 404);
      return;
    }

    // Whitelist lookup only: no filesystem path is ever derived from a request.
    const asset = assets.get(pathname);
    if (asset === undefined) {
      send(res, 404);
      return;
    }

    if (req.headers["if-none-match"] === asset.etag) {
      send(res, 304, { ETag: asset.etag });
      return;
    }

    const ifRange = req.headers["if-range"];
    const rangeHeader = ifRange !== undefined && ifRange !== asset.etag
      ? undefined
      : req.headers.range;
    const range = parseSingleRange(rangeHeader, asset.size);
    if (range === false) {
      send(res, 416, { "Content-Range": `bytes */${asset.size}` });
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? asset.size - 1;
    const status = range === null ? 200 : 206;
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600, must-revalidate",
      "Content-Length": String(end - start + 1),
      "Content-Type": asset.type,
      ETag: asset.etag,
      ...(range === null ? {} : { "Content-Range": `bytes ${start}-${end}/${asset.size}` }),
    };

    if (method === "HEAD") {
      send(res, status, headers);
      return;
    }

    res.writeHead(status, {
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    const stream = createReadStream(asset.path, { start, end });
    activeStreams.add(stream);
    const release = () => activeStreams.delete(stream);
    stream.once("close", release);
    stream.once("end", release);
    stream.once("error", () => {
      release();
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    });
    res.once("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  };
}

export const inject = ["webServer"];

/**
 * Register one exact route per asset. Registered paths are the only paths served,
 * so an unknown URL never reaches this handler at all.
 *
 * @param {object} ctx Cordis context with the webServer service.
 */
export function apply(ctx) {
  const assets = buildAssetTable();
  /** @type {Set<import("node:fs").ReadStream>} */
  const activeStreams = new Set();

  ctx.effect(() => {
    const handler = createAssetHandler(assets, activeStreams);
    const unregister = [...assets.keys()].map((path) => ctx.webServer.register({
      kind: "exact",
      path,
      handler,
    }));
    return () => {
      for (const dispose of unregister) dispose();
      for (const stream of activeStreams) stream.destroy();
      activeStreams.clear();
    };
  }, `${PACKAGE_ID}: static splash assets`);
}
