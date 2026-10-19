import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

const directory = await realpath(dirname(fileURLToPath(import.meta.url)));
const inspections = JSON.parse(await readFile(new URL("./packed-inspections.json", import.meta.url), "utf8"));
let imports = 0;
for (const entry of inspections) {
  for (const specifier of entry.specifiers) {
    const resolved = await realpath(fileURLToPath(import.meta.resolve(specifier.name)));
    const local = relative(directory, resolved);
    assert.ok(!isAbsolute(local) && !local.startsWith(".."), `${specifier.name} resolved outside the consumer`);
    if (specifier.executable) continue;
    await import(specifier.name);
    imports++;
  }
}
console.log(`Imported ${imports} public entry points from installed packages`);
