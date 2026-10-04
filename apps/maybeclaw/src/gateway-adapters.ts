import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { AgentDefinition, defineAgent } from "@may/application";
import { loadMayConfig } from "@may/config";
import { createReadTool, resolveExistingWorkspacePath, resolveWritableWorkspacePath } from "@may/coding-tools";
import type { PermissionPolicy, PermissionRuleStore } from "@may/permissions";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";
import { loadPluginModules, parsePluginSelections, type AnyPlugin } from "@may/plugin";
import { createMayAgentAdapter, loadAgentAdapter } from "@may/plugin-agent-adapters";
import { createModelPlugin } from "@may/plugin-models";
import { createPermissionPlugin } from "@may/plugin-permissions";
import { createToolsPlugin } from "@may/plugin-runtime";
import { services } from "@may/plugin-services";
import type { GatewayAgentAdapter, GatewayAgentConfig, GatewayAdapterContext } from "./gateway-types.js";

export interface MayAdapterOptions {
  plugins?: readonly AnyPlugin[];
  directory: string;
  configPath: string;
  agent: GatewayAgentConfig;
  permissionRuleStore?: PermissionRuleStore;
  definition?: (tools: () => GatewayAdapterContext["tools"]) => Promise<AgentDefinition> | AgentDefinition;
}

export async function loadGatewayAdapter(options: MayAdapterOptions): Promise<GatewayAgentAdapter> {
  if (options.agent.adapter === "may") {
    if (!options.definition) {
      const config = await loadMayConfig({ path: options.configPath });
      const plugins = options.plugins ?? await loadPluginModules(parsePluginSelections(options.agent.plugins), config.path);
      if (!plugins.some(plugin => plugin.provides?.some(service => service.id === services.model.id && service.scope === services.model.scope))) selectProviderModel(config, options.agent.model ? { model: options.agent.model } : {});
      return createMayAdapter({ ...options, plugins });
    }
    return createMayAdapter(options);
  }
  return loadAgentAdapter({ ...options.agent, module: options.agent.module! }, { ...options });
}

export function createMayAdapter(options: MayAdapterOptions): GatewayAgentAdapter {
  return createMayAgentAdapter({ agentId: options.agent.id,
    store: new FileSessionStore(join(options.directory, "agents", options.agent.id, "sessions")),
    ...(options.agent.media ? { media: options.agent.media } : {}),
    metadata: conversationId => ({ maybeclaw: { agentId: options.agent.id, conversationId } }),
    definition: options.definition ?? (async (source, context) => {
      const config = await loadMayConfig({ path: options.configPath });
      const selected = options.plugins ?? await loadPluginModules(parsePluginSelections(options.agent.plugins), config.path);
      const defaults = [
        createModelPlugin({ create: () => createBuiltinProviderModel(selectProviderModel(config, options.agent.model ? { model: options.agent.model } : {})) }),
        createPermissionPlugin({ create: () => createGatewayPermissionPolicy(options, () => context()?.permissionScope) }),
        createToolsPlugin({ id: "maybeclaw.tools", create: () => {
          const tools = options.agent.readDirectory ? [createReadTool({ cwd: options.agent.readDirectory })] : [];
          return () => [...tools, ...source()];
        } }),
      ];
      const ids = new Set(selected.map(plugin => plugin.id));
      const provided = new Set(selected.flatMap(plugin => plugin.provides?.map(service => `${service.scope}:${service.id}`) ?? []));
      return defineAgent({
        ...(options.permissionRuleStore === undefined ? {} : { permissionRuleStore: options.permissionRuleStore }),
        plugins: [...defaults.filter(plugin => !ids.has(plugin.id) && !plugin.provides?.some(service => provided.has(`${service.scope}:${service.id}`))), ...selected],
        ...(options.agent.instructions === undefined ? {} : { instructions: options.agent.instructions }),
        ...(options.agent.runBudget ? { runBudget: options.agent.runBudget } : {}),
      });
    }),
  });
}

export function createGatewayPermissionPolicy(options: Pick<MayAdapterOptions, "agent" | "directory" | "permissionRuleStore">, scope: () => string | undefined): PermissionPolicy {
  return async check => {
    const configured = options.agent.permissions?.[check.tool.name];
    const decision = configured ?? (["list_agents", "delegate_tasks", "send_message", "wait_for_messages", "handoff_task", "read"].includes(check.tool.name) ? "allow" : "ask");
    if (decision === "deny" || options.permissionRuleStore === undefined) return decision;
    if (["read", "write", "edit"].includes(check.tool.name) && check.input && typeof check.input === "object" && "path" in check.input && typeof check.input.path === "string") {
      const root = options.agent.readDirectory ?? process.cwd();
      const target = await resolveWritableWorkspacePath(root, check.input.path);
      const protectedPath = join(await realpath(options.directory), "permission-rules.json");
      const pathKey = process.platform === "win32" ? target.absolute.toLowerCase() : target.absolute;
      const protectedKey = process.platform === "win32" ? protectedPath.toLowerCase() : protectedPath;
      if (pathKey === protectedKey || pathKey.startsWith(`${protectedKey}.`)) return "deny";
    }
    if (configured === undefined && (check.tool.name !== "read" || !options.agent.readDirectory)) return decision;
    const actorScope = scope();
    if (typeof actorScope !== "string" || actorScope.trim().length === 0) throw new Error("持久权限检查需要宿主提供当前发起者身份。");
    let grantKey: string;
    let description: string;
    if (check.tool.name === "read" && options.agent.readDirectory) {
      if (!check.input || typeof check.input !== "object" || !("path" in check.input) || typeof check.input.path !== "string") throw new TypeError("read 权限检查需要文件 path。");
      const file = await resolveExistingWorkspacePath(options.agent.readDirectory, check.input.path, { allowHardLinks: false });
      grantKey = JSON.stringify(["read-file-v1", file.absolute]);
      description = `Agent：${options.agent.id}；身份：${actorScope}；操作：读取文件 ${file.absolute}。`;
    } else {
      const input = JSON.stringify(check.input);
      if (input === undefined) throw new TypeError("持久权限参数必须具有 JSON 表示。");
      const restored: unknown = JSON.parse(input);
      if (!isDeepStrictEqual(restored, check.input)) {
        throw new TypeError("持久权限参数必须能够通过 JSON 无损保存与读取。");
      }
      grantKey = `exact-input-v1:${createHash("sha256").update(JSON.stringify([check.tool.name, restored])).digest("hex")}`;
      description = `Agent：${options.agent.id}；身份：${actorScope}；工具：${check.tool.name}；范围：与当前审批相同的工具参数。`;
    }
    return { decision, grantKey, persistent: {
      scopeId: JSON.stringify(["maybeclaw-v1", resolve(options.directory), options.agent.id, options.agent.readDirectory ? await realpath(options.agent.readDirectory) : null, actorScope]),
      description,
    } };
  };
}
