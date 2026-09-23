import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
let html = (await readFile(path.join(directory, "src", "shell.html"), "utf8")).replace(/\r\n/g, "\n");
for (const [marker, file] of [
  ["/* INLINE_STYLES */", "styles.css"],
  ["/* INLINE_DATA */", "data.json"],
  ["/* INLINE_APP */", "app.js"]
]) {
  if (html.split(marker).length !== 2) throw new Error(`Expected one ${marker} marker.`);
  const source = (await readFile(path.join(directory, "src", file), "utf8")).replace(/\r\n/g, "\n");
  const content = file === "data.json" ? `window.RESOURCE_DATA = ${JSON.stringify(JSON.parse(source), null, 2).replace(/</g, "\\u003c")};` : source;
  html = html.replace(marker, () => content.trimEnd());
}
const destination = path.join(directory, "index.html");
if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")).replace(/\r\n/g, "\n") !== html) {
    throw new Error("index.html is stale. Run node resource-estimates\\build.mjs.");
  }
  console.log("Standalone artifact matches its authoring sources.");
} else {
  await writeFile(destination, html);
  console.log("Built resource-estimates\\index.html with all runtime assets embedded.");
}
