import { AgentWorkspace, type AgentRun, type AgentWorkspaceEvent } from "@may/application";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import type { Model } from "@may/core";
import { ApplicationUiHost } from "@may/ui-client/application";
import { openAssistantApplication } from "./agent.js";
import { closeAssistantContext, createAssistantContext, type AssistantContext } from "./context.js";
import type { MailCheckResult } from "./mail/ledger.js";
import { createControlToken, startAssistantServer, type AssistantServer } from "./server/http.js";
import { createProductUi } from "./server/ui.js";
import { assistantWebAssets } from "./server/web.js";
import type { AssistantSettings } from "./settings.js";

export interface PersonalAssistantOptions {
  readonly settings: AssistantSettings;
  readonly model: Model;
  /** 测试可以注入已经准备好的上下文。 */
  readonly context?: AssistantContext;
  readonly poll?: boolean;
}

export interface ServeResult {
  readonly url: string;
  readonly loginUrl: string | undefined;
  readonly token: string;
  readonly lanUrl: string | undefined;
}

/**
 * 长期运行的个人助手。个人数据库、邮箱、办事大厅与会话都由这个进程持有，
 * 浏览器页面、手机和命令行都是它的客户端，关掉页面不会影响正在进行的任务。
 */
export class PersonalAssistant {
  readonly workspace: AgentWorkspace;
  readonly events: AsyncIterable<AgentWorkspaceEvent>;
  private poller: ReturnType<typeof setInterval> | undefined;
  private server: AssistantServer | undefined;
  private uiHost: ApplicationUiHost | undefined;
  private closed = false;
  private polling = false;

  private constructor(
    readonly context: AssistantContext,
    workspace: AgentWorkspace,
  ) {
    this.workspace = workspace;
    this.events = workspace.events;
  }

  static async open(options: PersonalAssistantOptions): Promise<PersonalAssistant> {
    const context = options.context ?? await createAssistantContext({ settings: options.settings });
    const store = new FileSessionStore(context.settings.paths.sessions);
    const catalog = new FileSessionCatalog(context.settings.paths.catalog);
    const workspace = await AgentWorkspace.open({
      workspace: context.settings.paths.vault,
      store,
      catalog,
      autoResume: true,
      openApplication: (selection) => openAssistantApplication(
        { context, model: options.model, store },
        selection,
      ),
    });
    const assistant = new PersonalAssistant(context, workspace);
    if (options.poll ?? options.settings.poll.enabled) assistant.startPolling(options.settings.poll.intervalMinutes);
    return assistant;
  }

  get sessionId(): string {
    return this.workspace.sessionId;
  }

  get isRunning(): boolean {
    return this.workspace.isRunning;
  }

  async submit(input: string): Promise<AgentRun> {
    if (input.trim() === "") throw new Error("请输入任务内容");
    return this.workspace.submit({ input, inputId: `cli:${Date.now()}` });
  }

  /** 立刻检查邮箱，并把新邮件交给助手处理。 */
  async checkMail(): Promise<MailCheckResult> {
    if (!this.context.mailAvailable) throw new Error("没有配置邮箱");
    const result = await this.context.mailbox.check({});
    if (result.newMessages.length === 0) return result;
    await this.workspace.submit({
      input: [
        `邮箱有 ${result.newMessages.length} 封新邮件，请按流程处理：`,
        ...result.newMessages.map((message) => `- ${message.from}：${message.subject}（key: ${message.key}）`),
        "先 mail_thread 了解往来，再检索个人数据库，最后起草回复。不要直接发送。",
      ].join("\n"),
      inputId: `mailbox:${result.checkedAt}`,
    });
    return result;
  }

  /** 启动工作台服务。令牌来自配置或环境变量，没有配置时生成一个并返回。 */
  async serve(): Promise<ServeResult> {
    if (this.closed) throw new Error("助手已经关闭");
    if (this.server !== undefined) throw new Error("工作台服务已经在运行");
    const settings = this.context.settings;
    const token = settings.controlToken ?? createControlToken();
    const product = createProductUi({ context: this.context, workspace: this.workspace });
    const host = new ApplicationUiHost(this.workspace, {
      product: product.product,
      events: this.workspace.events,
      closeApplication: false,
      commands: product.commands,
      concurrentCommands: product.concurrentCommands,
      available: product.available,
      panels: product.panels,
      execute: product.execute,
    });
    this.uiHost = host;
    const assets = await assistantWebAssets("个人助手", true);
    const server = await startAssistantServer({
      host,
      assets,
      token,
      bind: settings.server.host,
      port: settings.server.port,
      browserLogin: true,
      close: async () => {
        await host.close();
        this.uiHost = undefined;
      },
    });
    this.server = server;
    const port = new URL(server.url).port;
    return {
      url: server.url,
      loginUrl: server.loginUrl,
      token,
      lanUrl: settings.server.allowLan ? `http://${settings.server.host}:${port}` : undefined,
    };
  }

  /** 通知界面刷新，例如草稿被修改之后。 */
  refreshUi(): void {
    this.uiHost?.changed();
  }

  private startPolling(intervalMinutes: number): void {
    if (!this.context.mailAvailable) return;
    const interval = setInterval(() => { void this.pollNow(); }, Math.max(1, intervalMinutes) * 60_000);
    interval.unref?.();
    this.poller = interval;
  }

  /**
   * 定期收取新邮件。助手正忙或邮箱暂时不可用时保持安静，下一轮继续检查。
   * 供定时器与命令行调用。
   */
  async pollNow(): Promise<void> {
    if (this.polling || this.closed || this.workspace.isRunning) return;
    this.polling = true;
    try {
      const result = await this.context.mailbox.check({});
      if (result.newMessages.length === 0) return;
      await this.workspace.submit({
        input: [
          `邮箱有 ${result.newMessages.length} 封新邮件，请按流程处理：`,
          ...result.newMessages.map((message) => `- ${message.from}：${message.subject}（key: ${message.key}）`),
          "先 mail_thread 了解往来，再检索个人数据库，最后起草回复。不要直接发送。",
        ].join("\n"),
        inputId: `mailbox:${result.checkedAt}`,
      });
    } catch {
      // 邮箱暂时不可用时保持安静，下一轮继续检查。
    } finally {
      this.polling = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.poller !== undefined) clearInterval(this.poller);
    this.poller = undefined;
    await this.server?.close();
    this.server = undefined;
    await this.workspace.close();
    await closeAssistantContext(this.context);
  }
}
