import assert from "node:assert/strict";
import { defineHook } from "@sortedyuan/may/core";
import { defineService, PluginHost } from "@sortedyuan/may/plugin";

export const signal = () => new AbortController().signal;
export const numberHook = defineHook({
  name: "number",
  kind: "transform",
  validate(value) {
    assert.equal(typeof value, "number");
    return value;
  },
});
export const memory = defineService({ id: "memory", version: "1.0.0", scope: "session", capabilities: ["write"] });

export async function application(options) {
  const host = await PluginHost.create(options);
  const app = await host.createScope("application", { id: "app" });
  return { host, app };
}
