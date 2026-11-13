import { executeMcpCommand } from "./mcp-commands.js";
import { executeGoalCommand } from "./goal-commands.js";
import { executeDelegationCommand } from "./delegation-commands.js";
import type { MaybeCodeController } from "./controller.js";
import {
  MAYBECODE_SLASH_COMMANDS,
  isCompactionStrategy,
  parseMaybeCodeSlashCommand,
  reasoningEffortChoices,
  usage,
  type MaybeCodeSlashCommand,
  type MaybeCodeSlashCommandResult,
} from "./slash-commands.js";
import { userInfo } from "node:os";

export async function executeMaybeCodeSlashCommand(
  input: string,
  controller: MaybeCodeController,
): Promise<MaybeCodeSlashCommandResult> {
  const parsed = parseMaybeCodeSlashCommand(input);
  if (parsed.type !== "command") {
    return parsed.type === "unknown" ? parsed : { type: "unknown", command: input };
  }

  const { definition, arguments: arguments_ } = parsed;
  switch (definition.name) {
    case "/fork": {
      if (arguments_.length) return { type: "usage", usage: "/fork" };
      if (!controller.getForkPoints || !controller.forkSession)
        throw new Error("Session forks are unavailable in this host");
      if (controller.isRunning)
        throw new Error("Wait for the current request to finish before creating a Session fork");
      return { type: "fork.selection.requested", points: await controller.getForkPoints() };
    }
    case "/changes": {
      if (!controller.getChanges) throw new Error("Git checkpoints are unavailable in this host");
      const [scope = "workspace", value] = arguments_;
      if (
        arguments_.length > 2 ||
        !["run", "session", "workspace", "commit"].includes(scope) ||
        (["run", "commit"].includes(scope) && !value) ||
        (["session", "workspace"].includes(scope) && value)
      ) {
        return { type: "usage", usage: "/changes [run <run-id>|session|workspace|commit <commit>]" };
      }
      return {
        type: "changes.selection.requested",
        diff: await controller.getChanges({
          scope: scope === "commit" ? "workspace" : (scope as "run" | "session" | "workspace"),
          ...(scope === "run" ? { runId: value! } : scope === "commit" ? { commit: value! } : {}),
        }),
      };
    }
    case "/worktrees": {
      if (!controller.getWorktrees) throw new Error("Worktree management is unavailable in this host");
      if (arguments_.length) {
        if (arguments_.length !== 2 || !["open", "delete"].includes(arguments_[0]!))
          return { type: "usage", usage: "/worktrees [open|delete <id>]" };
        if (arguments_[0] === "open") {
          if (!controller.openWorktree) throw new Error("Opening a worktree is unavailable in this host");
          await controller.openWorktree(arguments_[1]!);
          return { type: "session.resumed", sessionId: controller.sessionId };
        }
        if (!controller.deleteWorktree) throw new Error("Deleting a worktree is unavailable in this host");
        await controller.deleteWorktree(arguments_[1]!);
      }
      return { type: "worktrees.display", worktrees: await controller.getWorktrees() };
    }
    case "/steer": {
      const text = input.trimStart().slice("/steer".length).trimStart();
      if (!text.trim()) return usage(definition);
      if (!controller.steer) throw new Error("Steering is unsupported by this controller");
      const result = await controller.steer({ input: text });
      return { type: "display", text: `Steering input ${result.inputId}: ${result.status}` };
    }
    case "/stop": {
      const invalid = noArguments(arguments_, definition);
      if (invalid) return invalid;
      return {
        type: "display",
        text: controller.cancel("Stopped by user") ? "Cancellation requested." : "No active operation.",
      };
    }
    case "/yolo": {
      const action = arguments_[0] ?? "on";
      if (arguments_.length > 1 || !["on", "off", "status"].includes(action))
        return { type: "usage", usage: "/yolo [on|off|status]" };
      if (action !== "status") await controller.setPermissionMode(action === "on" ? "yolo" : "default");
      return { type: "display", text: controller.permissionMode === "yolo" ? "YOLO enabled" : "YOLO disabled" };
    }
    case "/permissions": {
      if (
        !controller.application.persistentRulesEnabled ||
        !controller.listPermissionRules ||
        !controller.revokePermissionRule
      )
        throw new Error("此宿主没有启用规则管理。");
      const action = arguments_[0] ?? "list";
      if (action === "list" && arguments_.length <= 1) {
        const rules = await controller.listPermissionRules();
        return {
          type: "display",
          text:
            rules.length === 0
              ? "当前没有持久权限规则。"
              : rules
                  .map(
                    (rule) =>
                      `${rule.id}\n${rule.decision === "allow" ? "允许" : "禁止"} · ${rule.description}\n范围：${rule.scopeId}\n创建者：${rule.createdBy}\n有效期：${rule.expiresAt === undefined ? "持续有效" : new Date(rule.expiresAt).toISOString()}`,
                  )
                  .join("\n\n"),
        };
      }
      if (action === "revoke" && arguments_.length === 2) {
        if (!(await controller.revokePermissionRule(arguments_[1]!))) throw new Error("规则不存在。");
        return { type: "display", text: "已撤销权限规则。" };
      }
      if ((action === "allow" || action === "deny") && arguments_.length === 2) {
        if (!controller.createPermissionRuleFrom) throw new Error("此宿主没有启用规则创建。");
        const rule = await controller.createPermissionRuleFrom(arguments_[1]!, {
          decision: action,
          createdBy: `local:${userInfo().username}`,
        });
        return {
          type: "display",
          text: `已创建${action === "allow" ? "允许" : "禁止"}规则：${rule.id}\n${rule.description}\n范围：${rule.scopeId}\n同范围的禁止规则优先。`,
        };
      }
      return { type: "usage", usage: definition.usage };
    }
    case "/goal":
      return { type: "display", text: await executeGoalCommand(arguments_, controller) };
    case "/web":
      return noArguments(arguments_, definition) ?? { type: "web.requested" };
    case "/skills": {
      if (arguments_.length === 0) {
        const skills = controller.application.listSkills();
        const diagnostics = controller.application.agent.skills?.registry.diagnostics ?? [];
        const text =
          skills.length === 0
            ? "No skills discovered."
            : skills
                .map(
                  (skill) =>
                    `${skill.name}${skill.active ? " [active]" : ""} — ${skill.description}\n  ${skill.directory}`,
                )
                .join("\n");
        return {
          type: "display",
          text:
            text +
            (diagnostics.length === 0
              ? ""
              : "\n\nDiscovery diagnostics:\n" + diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n")),
        };
      }
      const [verb, name, ...task] = arguments_;
      if (name === undefined || !["show", "use"].includes(verb!)) return usage(definition);
      if (verb === "show") {
        if (task.length > 0) return usage(definition);
        if (!controller.readSkill) throw new Error("Skills are unsupported by this controller");
        const document = await controller.readSkill(name);
        return {
          type: "display",
          text: `${document.name}\n${document.directory}\nRevision: ${document.revision}\n\n${document.body}`,
        };
      }
      if (task.length > 0) {
        if (!controller.submitSkill) throw new Error("Skill submission is unsupported by this controller");
        return { type: "skill.run-started", run: await controller.submitSkill(name, task.join(" ")) };
      }
      if (!controller.activateSkill) throw new Error("Skill activation is unsupported by this controller");
      await controller.activateSkill(name);
      return { type: "display", text: `Activated ${name} for this session. Submit a task to use it.` };
    }
    case "/recovery": {
      if (arguments_.length === 0) {
        const pending = controller.listRecoveries();
        return {
          type: "display",
          text:
            pending.length === 0
              ? "No unresolved recovery findings."
              : pending
                  .map(
                    (item) =>
                      `${item.id} — ${item.call.name}: outcome unknown\nInput: ${JSON.stringify(item.call.input)}`,
                  )
                  .join("\n\n") + "\nVerify external effects, then use /recovery resolve <id> <verified finding>.",
        };
      }
      if (arguments_[0] !== "resolve" || arguments_.length < 3) return usage(definition);
      if (!controller.resolveRecovery) throw new Error("Recovery resolution is unsupported");
      await controller.resolveRecovery(arguments_[1]!, arguments_.slice(2).join(" "));
      return { type: "display", text: "Recovery finding recorded. No tools were replayed." };
    }
    case "/delegations":
      return { type: "display", text: await executeDelegationCommand(arguments_, controller) };
    case "/quit":
      return noArguments(arguments_, definition) ?? { type: "exit" };
    case "/help":
      return (
        noArguments(arguments_, definition) ?? {
          type: "help",
          commands: MAYBECODE_SLASH_COMMANDS,
        }
      );
    case "/instructions":
      return (
        noArguments(arguments_, definition) ?? {
          type: "instructions",
          instructions: controller.application.instructions,
        }
      );
    case "/retry": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "retry.started", run: await controller.retry() };
    }
    case "/status": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "status", inspection: await controller.inspectContext() };
    }
    case "/mcp":
      return executeMcpCommand(input, controller);
    case "/context": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "context", inspection: await controller.inspectContext() };
    }
    case "/compact": {
      const strategy = arguments_[0];
      if (arguments_.length > 1 || (strategy !== undefined && !isCompactionStrategy(strategy))) {
        return usage(definition);
      }
      return {
        type: "compacted",
        result: await controller.compactContext(strategy),
      };
    }
    case "/new": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "session.created", sessionId: await controller.newSession() };
    }
    case "/resume": {
      const sessionId = arguments_[0];
      if (arguments_.length === 0) {
        return {
          type: "session.selection.requested",
          sessions: await controller.listSessions(),
        };
      }
      if (arguments_.length !== 1 || sessionId === undefined) {
        return usage(definition);
      }
      await controller.resumeSession(sessionId);
      return { type: "session.resumed", sessionId };
    }
    case "/lsp": {
      const manager = controller.application.lsp;
      if (!manager)
        return {
          type: "display",
          text: "Configure apps.maybecode.lsp.servers to enable LSP. Presets: typescript (typescript-language-server --stdio), python (pyright-langserver --stdio), rust (rust-analyzer), go (gopls).",
        };
      if (arguments_.length) {
        if (arguments_.length !== 2 || arguments_[0] !== "restart") return usage(definition);
        await manager.restart(arguments_[1]!);
      }
      return {
        type: "display",
        text: manager
          .status()
          .map(
            (server) =>
              `${server.id} · apps.maybecode.lsp.servers.${server.id} · ${server.state}\n${server.command ?? "Command resolves on first request"} ${(server.args ?? []).join(" ")}\n${server.progress.join("\n")}\n${server.lastError ?? ""}\n${server.stderr}\n${server.recovery ?? ""}`,
          )
          .join("\n\n"),
      };
    }
    case "/model": {
      if (arguments_.length === 0) {
        return {
          type: "model.selection.requested",
          models: await controller.listModels(),
        };
      }
      const query = arguments_[0];
      const setDefault = arguments_[1] === "--default";
      if (query === undefined || arguments_.length > 2 || (arguments_.length === 2 && !setDefault)) {
        return usage(definition);
      }
      const normalized = query.toLowerCase();
      const selected = (await controller.listModels()).find((model) => model.name.toLowerCase().startsWith(normalized));
      if (selected === undefined) return { type: "model.not-found", query };
      const model = await controller.switchModel(selected.name);
      if (setDefault) await controller.setDefaultModel(selected.name);
      return {
        type: "model.switched",
        profile: selected.name,
        model,
      };
    }
    case "/effort": {
      const state = await controller.getReasoningEffort();
      if (arguments_.length === 0) {
        return { type: "effort.selection.requested", state };
      }
      const query = arguments_[0];
      if (arguments_.length !== 1 || query === undefined) {
        return usage(definition);
      }
      if (state.status !== "known") {
        return { type: "effort.selection.requested", state };
      }
      const normalized = query.toLowerCase();
      const selected = reasoningEffortChoices(state).find((effort) => effort.toLowerCase().startsWith(normalized));
      if (selected === undefined) return { type: "effort.not-found", query };
      return {
        type: "effort.changed",
        state: await controller.setReasoningEffort(selected === "default" ? undefined : selected),
      };
    }
  }
}

function noArguments(
  arguments_: readonly string[],
  definition: MaybeCodeSlashCommand,
): Extract<MaybeCodeSlashCommandResult, { type: "usage" }> | undefined {
  return arguments_.length === 0 ? undefined : usage(definition);
}
