// Builds the SDK into versioned, immutable artifacts plus an SRI manifest:
//   dist/monitor.v1.js           (major alias: short cache)
//   dist/monitor.<x.y.z>.js      (exact version: immutable)
//   dist/index.js                (manifest: version, files, sha384 integrity)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const major = version.split(".")[0];
const src = readFileSync(join(root, "src/monitor.js"), "utf8").replaceAll("__SDK_VERSION__", version);
const out = await build({ stdin: { contents: src, loader: "js" }, write: false, minify: true, target: ["es2017"], legalComments: "inline" });
const code = out.outputFiles[0].text;
mkdirSync(join(root, "dist"), { recursive: true });
const files = { [`monitor.v${major}.js`]: code, [`monitor.${version}.js`]: code };
for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "dist", name), body);
const integrity = `sha384-${createHash("sha384").update(code).digest("base64")}`;
const gzipBytes = gzipSync(code).length;
const manifest = { version, major: Number(major), files: Object.keys(files), integrity, bytes: code.length, gzipBytes };
writeFileSync(join(root, "dist", "index.js"),
  `import { readFileSync } from "node:fs";\nimport { join, dirname } from "node:path";\nimport { fileURLToPath } from "node:url";\n` +
  `export const SDK_MANIFEST = ${JSON.stringify(manifest)};\n` +
  `export const SDK_DIST_DIR = dirname(fileURLToPath(import.meta.url));\n` +
  `export function readSdkFile(name) { return readFileSync(join(SDK_DIST_DIR, name), "utf8"); }\n`);
writeFileSync(join(root, "dist", "index.d.ts"),
  `export declare const SDK_MANIFEST: { version: string; major: number; files: string[]; integrity: string; bytes: number; gzipBytes: number };\n` +
  `export declare const SDK_DIST_DIR: string;\nexport declare function readSdkFile(name: string): string;\n`);
console.log(`sdk ${version}: ${code.length} bytes, ${gzipBytes} gzip, ${integrity}`);
