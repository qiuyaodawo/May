import { definePlugin, defineService, type PluginDefinition } from "../dist/index.js";
import { defineHook } from "@may/core";

const service = defineService<{ read(): number }>({ id: "typed", version: "1.0.0", scope: "application" });
const hook = defineHook<{ count: number }>({ name: "typed", kind: "transform", validate(value) {
  if (!value || typeof value !== "object" || !("count" in value) || typeof value.count !== "number") throw new Error("Invalid count");
  return { count: value.count };
} });
const plugin = definePlugin({
  id: "typed", version: "1.0.0", config: { label: "counter" }, provides: [service],
  setup(ctx) {
    const label: string = ctx.config.label;
    ctx.provide(service, { read: () => label.length });
    ctx.on(hook, (value) => ({ count: value.count + 1 }));
    // 配置类型与 Service 实例保持对应关系。
    // @ts-expect-error 配置字段类型为 string。
    const invalid: number = ctx.config.label;
    // @ts-expect-error Service.read 返回 number。
    ctx.provide(service, { read: () => "number" });
    // @ts-expect-error Hook.count 为 number。
    ctx.on(hook, () => ({ count: "number" }));
    void invalid;
  },
});
const typed: PluginDefinition<{ label: string }> = plugin;
void typed;
