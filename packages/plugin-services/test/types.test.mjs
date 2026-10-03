import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("component factories, registries and Application access preserve their public types", async () => {
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
    "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
    fileURLToPath(new URL("types.ts", import.meta.url)),
  ]);
  assert.equal(result.stderr, "");
});
