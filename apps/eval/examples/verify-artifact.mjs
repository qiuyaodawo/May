import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const input = JSON.parse(await readFile("input.json", "utf8"));
const actual = JSON.parse(await readFile("result.json", "utf8"));
assert.deepEqual(actual, { message: input.message.toUpperCase(), characters: input.message.length });
console.log("Verified result.json");
