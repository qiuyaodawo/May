import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { PluginHost } from "@may/plugin";
import { createObservabilityHostPlugin, observabilityHostService } from "../dist/index.js";

test("host plugin flushes an actual trace export during owned resource shutdown", async (t) => {
  const base = fileURLToPath(new URL("../../../../plugin-verification/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "plugin-tracing-"));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(base) + sep)); await rm(directory, { recursive: true, force: true }); });
  const host = await PluginHost.create({ plugins: [createObservabilityHostPlugin({ dataDirectory: directory, scheduledDelayMs: 60000 })] });
  const span = host.get(observabilityHostService).tracer.startSpan("plugin.files.read", { attributes: { "may.agent.name": "verification" } });
  span.end({ status: "ok" });
  await host.close();
  const traces = join(directory, "traces");
  const files = await readdir(traces);
  assert.equal(files.length, 1);
  const values = (await readFile(join(traces, files[0]), "utf8")).trim().split("\n").map(value => JSON.parse(value));
  assert.equal(values.length, 1);
  assert.equal(values[0].name, "plugin.files.read");
  assert.equal(values[0].status, "ok");
});
