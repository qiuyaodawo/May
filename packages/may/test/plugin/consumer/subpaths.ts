import { createModelPlugin, createModelWrapperPlugin } from "@sortedyuan/may/services/models";
import { createRuntimePlugin, createContextPlugin, createToolsPlugin, createContextWrapperPlugin } from "@sortedyuan/may/services/runtime";
import { createPermissionPlugin } from "@sortedyuan/may/services/permissions";
import { createSkillsPlugin } from "@sortedyuan/may/services/skills";
import { createCoordinationPlugin, coordinationService, type CoordinationService } from "@sortedyuan/coordination/plugin";
import { createSessionHistoryTool, createSessionHistoryRetrievalTools } from "@sortedyuan/may/session/tools";
import { May, type Model, type Tool } from "@sortedyuan/may/core";
import type { Session } from "@sortedyuan/may/session";
import type { SkillRegistry } from "@sortedyuan/may/skills";
import type { PluginContext } from "@sortedyuan/may/plugin";

declare const model: Model;
declare const session: Session;
declare const registry: SkillRegistry;
declare const tools: readonly Tool[];
declare const context: PluginContext;

const plugin = createModelPlugin({ create: () => model });
const historyTool = createSessionHistoryTool({ source: session });
void plugin;
void historyTool;
createModelWrapperPlugin({ id: "typed.model-wrapper", create: () => value => value });
createRuntimePlugin({ create: () => options => new May(options) });
createContextPlugin();
createToolsPlugin({ id: "typed.tools", create: () => () => tools });
createContextWrapperPlugin({ id: "typed.context-wrapper", create: () => value => value });
createPermissionPlugin({ config: { allow: false }, create: ctx => () => ctx.config.allow ? "allow" : "deny" });
createSkillsPlugin({ create: () => registry });
createCoordinationPlugin();
const coordination: CoordinationService = context.get(coordinationService);
void coordination;
createSessionHistoryRetrievalTools({ source: () => session });

// @ts-expect-error Model 工厂需要返回 Model。
createModelPlugin({ create: () => registry });
// @ts-expect-error Skills 工厂需要返回 SkillRegistry。
createSkillsPlugin({ create: () => model });
