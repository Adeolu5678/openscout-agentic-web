import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git"]);
const TEXT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".html",
  ".css",
  ".md",
  ".yml",
  ".yaml",
  ".txt",
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, files);
    } else if (
      entry === "LICENSE" ||
      entry === "_headers" ||
      TEXT_EXTS.has(entry.slice(entry.lastIndexOf(".")))
    ) {
      files.push(full);
    }
  }
  return files;
}

const root = process.cwd();
const files = walk(root);
const crlfFiles = [];

for (const file of files) {
  const buf = readFileSync(file);
  if (buf.includes(0x0d)) {
    crlfFiles.push(file.slice(root.length + 1));
  }
}

if (crlfFiles.length > 0) {
  console.error("CRLF (\\r) detected in:\n" + crlfFiles.join("\n"));
  process.exit(1);
}

console.log(`LF check passed across ${files.length} files.`);
