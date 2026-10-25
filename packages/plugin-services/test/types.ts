import type { ContextFactory } from "@sortedyuan/context";
import { May, type Model, type Tool } from "@sortedyuan/core";
import type { PluginContext } from "@sortedyuan/plugin";
import { ModelWrappers, ContextWrappers, ToolSources, InstructionSources, services, type ContextOptions } from "../dist/index.js";
import { createModelPlugin, createModelWrapperPlugin } from "@sortedyuan/plugin-services/models";
import { createPermissionPlugin } from "@sortedyuan/plugin-services/permissions";
import { createRuntimePlugin, createContextPlugin, createToolsPlugin } from "@sortedyuan/plugin-services/runtime";
import { applicationServices, type ApplicationFacade, type ApplicationExecution, type ApplicationHistory, type ApplicationState } from "../../application/dist/index.js";

declare const model: Model;
declare const factory: ContextFactory;
declare const tools: readonly Tool[];
declare const context: PluginContext;

new ModelWrappers().add(value => value, { id: "typed", pluginOrder: context.pluginOrder });
new ContextWrappers().add(value => value, { id: "typed" });
new ToolSources().add(() => tools, { id: "typed" });
new InstructionSources().add(() => "instructions", { id: "typed" });
context.provide(services.model, model);
context.provide(services.contextFactory, factory);
context.provide(services.contextOptions, effectiveModel => ({ budget: { contextWindowTokens: effectiveModel.limits?.contextWindowTokens ?? 4096 } } satisfies ContextOptions));
const application: ApplicationFacade = context.get(applicationServices.application).get();
const execution: ApplicationExecution = context.get(applicationServices.execution).get();
const history: ApplicationHistory = context.get(applicationServices.history).get();
const state: ApplicationState = context.get(applicationServices.state).get();
void execution; void history; void state;
void application;
createModelPlugin({ create: () => model });
createModelPlugin({ info: { provider: "configured", model: "active", profile: "default" }, create: () => model });
const metadata: string | undefined = context.optional(services.modelInfo)?.model;
void metadata;
createModelWrapperPlugin({ id: "typed", create: () => value => value });
createPermissionPlugin({ create: () => () => "deny" });
createContextPlugin({ create: () => factory });
createToolsPlugin({ id: "typed", create: () => () => tools });
createModelPlugin({ config: { label: "typed" }, create(context) { const label: string = context.config.label; void label; return model; } });
createPermissionPlugin({ config: { allow: false }, create(context) { return () => context.config.allow ? "allow" : "deny"; } });
createRuntimePlugin({ config: { maxSteps: 2 }, create(context) {
  const maxSteps: number = context.config.maxSteps; void maxSteps;
  return input => new May({ ...input, maxSteps });
} });

// @ts-expect-error Model 服务要求 Model 实例。
context.provide(services.model, factory);
// @ts-expect-error Model 元信息需要实际 provider 和 model 名称。
createModelPlugin({ info: { model: "active" }, create: () => model });
// @ts-expect-error Tool 来源需要返回 iterable。
new ToolSources().add(() => "tools", { id: "invalid" });
// @ts-expect-error 指令来源需要返回字符串。
new InstructionSources().add(() => 5, { id: "invalid" });
// @ts-expect-error Model 包装需要返回 Model。
new ModelWrappers().add(() => factory, { id: "invalid" });
// @ts-expect-error 工具工厂需要返回 Tool 来源。
createToolsPlugin({ id: "invalid", create: () => tools });
createModelPlugin({ config: { label: "typed" }, create(context) {
  // @ts-expect-error Factory config 保留声明的字段类型。
  const invalid: number = context.config.label; void invalid;
  return model;
} });
