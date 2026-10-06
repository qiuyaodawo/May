import { commandArgs, UiError, type UiAction, type UiCommand, type UiControls, type UiReceipt } from "@may/ui-client";
import { GitCheckpointError, GitWorkspaceConflictError } from "@may/application/git-workspace";
import { MaybeCodeUsageError } from "./errors.js";
import type { MaybeCodeController } from "./controller.js";
import { parsePermissionMode } from "./policy.js";
import { parseMaybeCodeSlashCommand } from "./slash-commands.js";
import { createMaybeCodeSlashCommandSuggester, executeMaybeCodeSlashCommand, formatMaybeCodeMcpStatus, type MaybeCodeSlashCommandResult } from "./slash-commands.js";

export class MaybeCodeWebCommands {
  private busy = false;
  readonly suggest;
  constructor(private readonly app: MaybeCodeController, private readonly changed: () => void) {
    this.suggest = createMaybeCodeSlashCommandSuggester(app);
  }

  available(name: string): boolean {
    if (["session.fork", "worktree.open", "worktree.delete", "changes.restore.preview", "changes.restore.apply"].includes(name) && (this.app.isRunning || this.app.getGoal?.()?.status === "active" || this.app.getMcpInteractions?.().length)) return false;
    if (name === "permission.set" && (this.app.isRunning || this.app.getGoal?.()?.status === "active" || this.app.getMcpInteractions?.().length)) return false;
    if (name === "message.submit") return !this.busy;
    if (name === "mcp.respond") return Boolean(this.app.getMcpInteractions?.().length);
    if (name === "console.cancel") return true;
    if (this.busy) return ["run.cancel", "approval.resolve"].includes(name);
    if (this.app.getMcpInteractions?.().length && ["session.new", "session.activate", "session.delete", "console.action"].includes(name)) return false;
    if (name === "console.execute") return true;
    if (name === "console.action") return !this.app.isRunning;
    return true;
  }

  controls(): UiControls {
    return { inputCommand: "console.execute", responseCommand: "mcp.respond", cancelCommand: "console.cancel", busy: this.busy,
      forms: (this.app.getMcpInteractions?.() ?? []).map(request => ({
        id: request.id, title: `MCP · ${request.serverId} · ${request.params.mode ?? "form"}`,
        detail: `Session: ${request.owner.sessionId}\nRequest: ${request.requestId}\n${request.params.message}`,
        mode: request.params.mode ?? "form", editable: request.params.mode === "review" ? request.params.editable : request.params.mode !== "url",
        value: request.params.mode === "review" ? JSON.stringify(request.params.data, null, 2) : request.params.mode === "url" ? "" : JSON.stringify(request.params.requestedSchema, null, 2),
        ...(request.params.mode === "url" ? { url: request.params.url } : {}),
      })),
    };
  }

  async execute(command: UiCommand): Promise<UiReceipt> {
    if (command.name === "mcp.respond") {
      commandArgs(command, ["id", "action"], ["content"]);
      const { id, action, content } = command.args;
      if (!["accept", "decline", "cancel"].includes(action!)) throw new UiError(400, "交互操作无效。");
      const request = this.app.getMcpInteractions?.().find(item => item.id === id);
      if (!request || this.app.ownsSession?.(request.owner.sessionId) !== true) throw new UiError(409, "交互已结束或会话已改变。");
      const parsed: unknown = content === undefined ? undefined : JSON.parse(content);
      if (parsed !== undefined && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) throw new UiError(400, "表单内容必须为 JSON 对象。");
      if (!this.app.respondMcpInteraction?.(id!, { action: action as "accept" | "decline" | "cancel", ...(parsed === undefined ? {} : { content: parsed as Record<string, string | number | boolean | string[]> }) })) throw new UiError(409, "交互已结束。");
      this.changed(); return {};
    }
    if (command.name === "console.cancel") {
      commandArgs(command, []);
      for (const request of this.app.getMcpInteractions?.() ?? []) this.app.respondMcpInteraction?.(request.id, { action: "cancel" });
      this.app.cancel("Cancelled from Web UI"); this.changed(); return {};
    }
    if (!this.available(command.name)) throw new UiError(409, "当前操作尚未结束。");
    this.busy = true; this.changed();
    try {
      if (command.name === "changes.restore.preview") {
        commandArgs(command, ["runId"], ["path", "paths"]);
        if (!this.app.previewRestore) throw new UiError(400, "文件恢复能力不可用。");
        const paths: unknown = command.args.paths ? JSON.parse(command.args.paths) : command.args.path ? [command.args.path] : [];
        if (!Array.isArray(paths) || paths.length === 0 || paths.some(path => typeof path !== "string")) throw new UiError(400, "请选择需要恢复的文件。");
        return { diff: (await this.app.previewRestore(command.args.runId!, paths)).diff };
      }
      if (command.name === "changes.restore.apply") {
        commandArgs(command, ["previewId"]);
        if (!this.app.restoreFiles) throw new UiError(400, "文件恢复能力不可用。");
        await this.app.restoreFiles(command.args.previewId!);
        return { selectedId: this.app.sessionId, output: { title: "文件恢复", text: "已恢复选定文件并更新工作区版本记录。" } };
      }
      if (command.name === "session.fork") {
        commandArgs(command, ["pointId", "mode"]);
        if (!this.app.forkSession || !["current", "worktree"].includes(command.args.mode!)) throw new UiError(400, "Session 分支方式无效。");
        await this.app.forkSession(command.args.pointId!, command.args.mode as "current" | "worktree");
        return { selectedId: this.app.sessionId };
      }
      if (command.name === "changes.view") {
        commandArgs(command, ["scope"], ["runId", "commit"]);
        if (!this.app.getChanges || !["run", "session", "workspace"].includes(command.args.scope!)) throw new UiError(400, "文件变化范围无效。");
        return { diff: await this.app.getChanges({ scope: command.args.scope as "run" | "session" | "workspace",
          ...(command.args.runId ? { runId: command.args.runId } : {}), ...(command.args.commit ? { commit: command.args.commit } : {}) }) };
      }
      if (command.name === "worktree.open" || command.name === "worktree.delete") {
        commandArgs(command, ["id"]);
        if (command.name === "worktree.open") {
          if (!this.app.openWorktree) throw new UiError(400, "工作区打开能力不可用。");
          await this.app.openWorktree(command.args.id!);
        } else {
          if (!this.app.deleteWorktree) throw new UiError(400, "工作区删除能力不可用。");
          await this.app.deleteWorktree(command.args.id!);
        }
        return { selectedId: this.app.sessionId };
      }
      if (command.name === "console.execute") {
        commandArgs(command, ["text"]);
        if (command.args.text!.length > 16_384) throw new UiError(400, "命令过长。");
        if (this.app.isRunning) {
          const parsed = parseMaybeCodeSlashCommand(command.args.text!);
          const arguments_ = parsed.type === "command" ? parsed.arguments : [];
          const allowed = parsed.type === "command" && (parsed.definition.name === "/help" || parsed.definition.name === "/status" ||
            parsed.definition.name === "/steer" || parsed.definition.name === "/stop" || parsed.definition.name === "/delegations" && (arguments_.length === 0 || arguments_[0] === "show" || arguments_[0] === "tools") ||
            parsed.definition.name === "/yolo" && parsed.arguments[0] === "status" ||
            parsed.definition.name === "/goal" && ["status", "pause", "cancel"].includes(parsed.arguments[0] ?? "status"));
          if (!allowed) throw new UiError(409, "请暂停当前运行后执行此命令。");
        }
        if (this.app.getMcpInteractions?.().length && /^\/(?:new|resume)(?:\s|$)/u.test(command.args.text!.trim())) throw new UiError(409, "请先完成或取消当前 MCP 交互。");
        const result = await executeMaybeCodeSlashCommand(command.args.text!, this.app);
        return await this.present(result);
      }
      if (command.name === "permission.set") {
        commandArgs(command, ["value"]); await this.app.setPermissionMode(parsePermissionMode(command.args.value));
        return { output: { title: "Permissions", text: this.app.permissionMode === "yolo" ? "YOLO enabled" : "YOLO disabled" } };
      } else if (command.name === "model.capabilities.refresh") {
        commandArgs(command, []);
        if (!this.app.getModelCapabilities || this.app.modelCapabilitiesAvailable === false) throw new UiError(400, "模型能力查询不可用。");
        await this.app.getModelCapabilities(undefined, true);
        this.changed();
      } else if (command.name === "model.switch") {
        commandArgs(command, ["value"]); await this.app.switchModel(command.args.value!);
      } else if (command.name === "effort.set") {
        commandArgs(command, ["value"]); await this.app.setReasoningEffort(command.args.value === "default" ? undefined : command.args.value);
      } else if (command.name === "console.action") {
        return await this.action(command);
      } else throw new UiError(400, "不支持的操作。");
      return { selectedId: this.app.sessionId };
    } catch (error) {
      if (error instanceof GitWorkspaceConflictError || error instanceof MaybeCodeUsageError) throw new UiError(409, error.message);
      if (error instanceof GitCheckpointError) throw new UiError(409, "Git checkpoint 保存失败。请检查项目 Git 配置与 Hooks。");
      throw error;
    } finally { this.busy = false; this.changed(); }
  }

  private async action(command: UiCommand): Promise<UiReceipt> {
    commandArgs(command, ["action", "value"], ["title"]);
    const { action, value, title } = command.args;
    if (action === "model.default") await this.app.setDefaultModel(value!);
    else if (action === "model.switch") await this.app.switchModel(value!);
    else if (action === "effort.set") await this.app.setReasoningEffort(value === "default" ? undefined : value);
    else if (["session.resume", "session.rename", "session.delete"].includes(action!)) {
      if (action === "session.delete" && value === this.app.sessionId) throw new UiError(409, "无法删除当前会话，请先切换到其它会话。");
      if (!(await this.app.listSessions()).some(session => session.id === value)) throw new UiError(404, "会话不属于当前工作区。");
      if (action === "session.resume") await this.app.resumeSession(value!);
      else if (action === "session.rename") {
        if (!title?.trim() || title.length > 160) throw new UiError(400, "请输入不超过 160 个字符的名称。");
        await this.app.renameSession(value!, title);
      } else await this.app.deleteSession(value!);
    } else throw new UiError(400, "操作名称无效。");
    const result = await executeMaybeCodeSlashCommand(action?.startsWith("session.") ? "/resume" : action?.startsWith("model.") ? "/model" : "/effort", this.app);
    return this.present(result);
  }

  private async present(result: MaybeCodeSlashCommandResult): Promise<UiReceipt> {
    const output = (title: string, text: string, actions?: readonly UiAction[]): UiReceipt => ({ selectedId: this.app.sessionId, output: { title, text, ...(actions ? { actions } : {}) } });
    const action = (label: string, name: string, value: string): UiAction => ({ label, command: "console.action", args: { action: name, value } });
    switch (result.type) {
      case "fork.selection.requested": return output("Session 分支", "选择完整回复和工作区方式。", result.points.filter(point => point.available).flatMap(point => [
        { label: `${point.userPreview} · 当前工作区`, command: "session.fork", args: { pointId: point.id, mode: "current" } },
        ...(point.worktreeAvailable ? [{ label: `${point.userPreview} · 新建 worktree`, command: "session.fork", args: { pointId: point.id, mode: "worktree" } }] : []),
      ]));
      case "changes.selection.requested": return { diff: result.diff };
      case "worktrees.display": return output("worktrees", result.worktrees.map(tree => `${tree.branch} · ${tree.path}`).join("\n"), result.worktrees.flatMap(tree => [
        { label: `打开 ${tree.branch}`, command: "worktree.open", args: { id: tree.id } },
        { label: `删除 ${tree.branch}`, command: "worktree.delete", args: { id: tree.id }, confirm: `删除工作区 ${tree.path}？` },
      ]));
      case "exit": return { disconnect: true };
      case "web.requested": return output("Web UI", "当前页面已经连接此工作区。");
      case "unknown": throw new UiError(400, `未知命令：${result.command}`);
      case "usage": throw new UiError(400, `用法：${result.usage}`);
      case "model.not-found": throw new UiError(404, `未找到模型：${result.query}`);
      case "effort.not-found": throw new UiError(404, `未找到 effort：${result.query}`);
      case "display": case "mcp.display": return output("命令结果", result.text);
      case "help": return output("命令帮助", result.commands.map(item => `${item.usage} — ${item.description}`).join("\n") + "\n/details — 展开或收起工具详情\n/thinking — 显示或隐藏思考过程");
      case "instructions": return output("当前指令", result.instructions.effective);
      case "status": return output("运行状态", `Session: ${this.app.sessionId}\nWorkspace: ${this.app.workspace}\nModel: ${this.app.modelInfo?.model ?? "未知"}\nEffort: ${(await this.app.getReasoningEffort()).effectiveEffort ?? "默认"}\n${JSON.stringify(result.inspection, null, 2) ?? ""}`);
      case "context": return output("上下文", JSON.stringify(result.inspection, null, 2) ?? "当前模型没有提供上下文用量。");
      case "compacted": return output("上下文压缩", `${result.result.strategy}: ${result.result.before.messageCount} → ${result.result.after.messageCount}`);
      case "mcp.status": return output("MCP", formatMaybeCodeMcpStatus(result.servers));
      case "session.created": case "session.resumed": case "model.switched": return { selectedId: this.app.sessionId };
      case "session.selection.requested": return output("会话管理", "选择会话操作。", result.sessions.flatMap(session => [
        action(`继续 · ${session.title ?? session.id}`, "session.resume", session.id),
        { ...action(`重命名 · ${session.title ?? session.id}`, "session.rename", session.id), input: { name: "title", label: "会话名称", value: session.title ?? "" } },
        ...(session.id === this.app.sessionId ? [] : [{ ...action(`删除 · ${session.title ?? session.id}`, "session.delete", session.id), confirm: `确认删除会话 ${session.title ?? session.id} 及其历史记录？` }]),
      ]));
      case "model.selection.requested": return output("模型配置", `当前：${this.app.modelInfo?.profile ?? "未知"}`, result.models.flatMap(model => [action(`切换 · ${model.name}`, "model.switch", model.name), action(`${model.isDefault ? "当前默认" : "设为默认"} · ${model.name}`, "model.default", model.name)]));
      case "effort.selection.requested": case "effort.changed": return output("Reasoning effort", `当前：${result.state.effectiveEffort ?? "默认"}\nProvider 默认：${result.state.defaultEffort ?? "未提供"}\n能力状态：${result.state.status}`, result.state.status === "known" ? ["default", ...result.state.efforts].map(effort => action(effort === "default" ? "恢复配置默认" : effort, "effort.set", effort)) : []);
      case "skill.run-started": case "mcp.run-started": case "retry.started":
        void result.run.result.catch(() => {}).finally(this.changed);
        return { selectedId: this.app.sessionId };
    }
  }
}
