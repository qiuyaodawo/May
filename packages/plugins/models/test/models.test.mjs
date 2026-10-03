import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import test from "node:test";
import { createModelPlugin } from "../dist/index.js";
import { PluginHost } from "../../../plugin/dist/index.js";

test("Model provider validates the acquired instance and cleans resources on initialization failure", async () => {
  let handle;
  const host = await PluginHost.create({ plugins: [createModelPlugin({ async create(context) {
    handle = await open(new URL("../../../../README.md", import.meta.url), "r");
    context.defer(() => handle.close());
    return handle;
  } })] });
  await assert.rejects(host.createScope("application", { id: "invalid" }), error => error.cause?.message === "Model plugin must create a Model");
  assert.equal(handle.fd, -1);
  await host.close();
});

test("Model metadata fails validation before acquiring resources", () => {
  let creations = 0;
  const create = () => { creations += 1; return open(new URL("../../../../README.md", import.meta.url), "r"); };
  for (const info of [{ provider: "configured", model: "" }, { model: "configured" }, { provider: "configured", model: "active", profile: 7 }]) {
    assert.throws(() => createModelPlugin({ info, create }), /Model info .+ must be a non-empty string/u);
  }
  assert.equal(creations, 0);
});
