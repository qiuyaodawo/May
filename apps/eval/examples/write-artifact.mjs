import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const input = JSON.parse(await readFile("input.json", "utf8"));
assert.equal(typeof input.message, "string");
const message = input.message.toUpperCase();
await writeFile("result.json", `${JSON.stringify({ message, characters: message.length })}\n`, { flag: "wx" });
console.log("Created result.json");
