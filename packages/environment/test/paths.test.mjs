import assert from "node:assert/strict";
import test from "node:test";
import { resolveEnvironmentPath, toEnvironmentRelativePath } from "../dist/index.js";

test("environment paths use the target platform and preserve volume roots", () => {
  assert.deepEqual(resolveEnvironmentPath("C:\\", ".", { platform: "win32" }), { relative: ".", absolute: "C:\\" });
  assert.deepEqual(resolveEnvironmentPath("/", "text.txt", { platform: "linux" }), { relative: "text.txt", absolute: "/text.txt" });
  assert.equal(toEnvironmentRelativePath("C:\\Workspace", "c:\\workspace\\file.txt", "win32"), "file.txt");
  assert.equal(resolveEnvironmentPath("/work", "literal:name", { platform: "linux" }).relative, "literal:name");
  assert.equal(resolveEnvironmentPath("C:\\work", "nested/../file.txt", { platform: "win32" }).relative, "file.txt");
  for (const path of ["../escape", "C:escape", "\\escape", "file:stream", "NUL.txt", "folder/.. ", "folder/..."]) {
    assert.throws(() => resolveEnvironmentPath("C:\\work", path, { platform: "win32" }), { code: "ENVIRONMENT_INVALID_PATH" });
  }
  assert.throws(() => toEnvironmentRelativePath("/work", "/elsewhere", "linux"), { code: "ENVIRONMENT_INVALID_PATH" });
});
