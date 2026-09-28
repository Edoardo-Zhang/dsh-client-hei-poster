/**
 * Build the release zip.
 *
 *   cd _hei-poster/plugin
 *   node scripts/pack-release.mjs
 *
 * Why a hand-rolled zip instead of Compress-Archive / archiver:
 *   - the plugin has no runtime dependencies and will not gain one for packaging;
 *   - the entry list comes from package.json "files", i.e. exactly what pnpm
 *     installs into the profile - no more, no less;
 *   - every timestamp is fixed, so the same tree always produces the same bytes.
 *     That is what makes the sha256 in the release notes checkable by a stranger.
 *
 * Entries are stored under a single top-level folder so unpacking never litters
 * the user's Downloads directory.
 */

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const TOP = pkg.name + "-" + VERSION;
const OUT = join(PACKAGE_ROOT, "dist", TOP + ".zip");

/** Fixed DOS timestamp (2026-01-01 00:00) keeps rebuilds byte-identical. */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/** Expand the "files" entries of package.json into sorted relative paths. */
function collect() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.add(relative(PACKAGE_ROOT, full).split(sep).join("/"));
    }
  };
  for (const spec of pkg.files) {
    if (spec.endsWith("/**")) {
      const dir = join(PACKAGE_ROOT, spec.slice(0, -3));
      if (!existsSync(dir)) { console.error("[pack] missing declared directory: " + spec); process.exit(1); }
      walk(dir);
      continue;
    }
    if (spec.includes("*")) { console.error("[pack] unsupported glob in files: " + spec); process.exit(1); }
    const full = join(PACKAGE_ROOT, spec);
    if (!existsSync(full)) { console.error("[pack] missing declared file: " + spec); process.exit(1); }
    found.add(spec);
  }
  found.add("package.json");
  return [...found].sort();
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const names = collect();
const chunks = [];
const central = [];
let offset = 0;

for (const name of names) {
  const body = readFileSync(join(PACKAGE_ROOT, name));
  const deflated = deflateRawSync(body, { level: 9 });
  const useDeflate = deflated.length < body.length;
  const data = useDeflate ? deflated : body;
  const entryName = Buffer.from(TOP + "/" + name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);            // UTF-8 names
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc32(body), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(entryName.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, entryName, data);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc32(body), 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(body.length, 24);
  cd.writeUInt16LE(entryName.length, 28);
  cd.writeUInt32LE(0o644 << 16, 38);          // external attributes: rw-r--r--
  cd.writeUInt32LE(offset, 42);
  central.push(cd, entryName);

  offset += local.length + entryName.length + data.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(names.length, 8);
eocd.writeUInt16LE(names.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...chunks, cdBuf, eocd]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip);

const raw = names.reduce((sum, n) => sum + statSync(join(PACKAGE_ROOT, n)).size, 0);
console.log("[pack] " + TOP + "  entries=" + names.length +
  "  raw=" + (raw / 1048576).toFixed(2) + " MB  zip=" + (zip.length / 1048576).toFixed(2) + " MB");
console.log("[pack] sha256 " + createHash("sha256").update(zip).digest("hex"));
console.log("[pack] wrote " + relative(process.cwd(), OUT));
for (const name of names) console.log("       " + name);
