#!/usr/bin/env node
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const files = ["index.html", "styles.css", "app.js", "workbench.html"];
const here = fileURLToPath(new URL(".", import.meta.url));
const sourceDir = resolve(here, "../src/static");
const distDir = resolve(here, "../dist");

await mkdir(distDir, { recursive: true });
for (const file of files) {
  await copyFile(resolve(sourceDir, file), resolve(distDir, file));
}

console.log(`Copied ${files.length} static assets to ${distDir}`);
