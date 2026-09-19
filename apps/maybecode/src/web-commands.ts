import { commandArgs, UiError, type UiAction, type UiCommand, type UiControls, type UiReceipt } from "@may/ui-client";
import type { MaybeCodeController } from "./controller.js";
import { createMaybeCodeSlashCommandSuggester, executeMaybeCodeSlashCommand, formatMaybeCodeMcpStatus, type MaybeCodeSlashCommandResult } from "./slash-commands.js";

export class MaybeCodeWebCommands {
  private busy = false;
  readonly suggest;
  constructor(private readonly app: MaybeCodeController, private readonly changed: () => void) {
    this.suggest = createMaybeCodeSlashCommandSuggester(app);
  }

  available(name: string): boolean {
    if (name === "mcp.respond") return Boolean(this.app.getMcpInteractions?.().length);
    if (name === "console.cancel") return true;
    if (this.busy) return ["run.cancel", "approval.resolve", "session.browse"].includes(name);
    if (["console.execute", "console.action"].includes(name)) return !this.app.isRunning;
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
      if (!request || request.owner.sessionId !== this.app.sessionId) throw new UiError(409, "交互已结束或会话已改变。");
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
      if (command.name === "console.execute") {
        commandArgs(command, ["text"]);
        if (command.args.text!.length > 16_384) throw new UiError(400, "命令过长。");
        const result = await executeMaybeCodeSlashCommand(command.args.text!, this.app);
        return await this.present(result);
      }
      if (command.name === "model.switch") {
        commandArgs(command, ["value"]); await this.app.switchModel(command.args.value!);
      } else if (command.name === "effort.set") {
        commandArgs(command, ["value"]); await this.app.setReasoningEffort(command.args.value === "default" ? undefined : command.args.value);
      } else if (command.name === "console.action") {
        return await this.action(command);
      } else throw new UiError(400, "不支持的操作。");
      return { selectedId: this.app.sessionId };
    } finally { this.busy = false; this.changed(); }
  }

  private async action(command: UiCommand): Promise<UiReceipt> {
    commandArgs(command, ["action", "value"], ["title"]);
    const { action, value, title } = command.args;
    if (action === "model.default") await this.app.setDefaultModel(value!);
    else if (action === "model.switch") await this.app.switchModel(value!);
    else if (action === "effort.set") await this.app.setReasoningEffort(value === "default" ? undefined : value);
    else if (["session.resume", "session.rename", "session.delete"].includes(action!)) {
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
