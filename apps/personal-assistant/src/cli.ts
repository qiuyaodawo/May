import { loadMayConfig } from "@may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { CLI_USAGE, parseCliArgs, UsageError, type ParsedCommand } from "./args.js";
import { createAssistantContext, closeAssistantContext, type AssistantContext } from "./context.js";
import { shortDigest } from "./ehall/plan.js";
import { PersonalAssistant } from "./service.js";
import { assistantSettings } from "./settings.js";
import type { Model } from "@may/core";

export interface CliOutput {
  write(text: string): unknown;
}

export interface RunCliDependencies {
  readonly stdout?: CliOutput;
  readonly stderr?: CliOutput;
  readonly signal?: AbortSignal;
  readonly createModel?: (profile: string | undefined) => Promise<Model>;
  readonly loadConfig?: typeof loadMayConfig;
}

export async function runCli(args: readonly string[], dependencies: RunCliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  let parsed: ParsedCommand;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    stderr.write(`错误：${error instanceof UsageError ? error.message : String(error)}\n\n${CLI_USAGE}`);
    return 2;
  }
  if (parsed.command.type === "help") {
    stdout.write(CLI_USAGE);
    return 0;
  }
  if (parsed.command.type === "error") {
    stderr.write(`错误：${parsed.command.message}\n\n${CLI_USAGE}`);
    return 2;
  }

  try {
    const config = await (dependencies.loadConfig ?? loadMayConfig)(
      parsed.configPath === undefined ? {} : { path: parsed.configPath },
    );
    const settings = assistantSettings(config, process.env, {
      ...(parsed.home === undefined ? {} : { home: parsed.home }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      ...(parsed.host === undefined ? {} : { host: parsed.host }),
      ...(parsed.allowLan === undefined ? {} : { allowLan: parsed.allowLan }),
      ...(parsed.poll === undefined ? {} : { pollEnabled: parsed.poll }),
      ...(parsed.headless === undefined ? {} : { headless: parsed.headless }),
    });
    // 只有需要模型的命令才创建模型，维护类命令不依赖模型配置。
    const createModel = async (): Promise<Model> => dependencies.createModel === undefined
      ? createBuiltinProviderModel(selectProviderModel(config, {
        ...(settings.model.profile === undefined ? {} : { model: settings.model.profile }),
      }))
      : dependencies.createModel(settings.model.profile);
    const context = await createAssistantContext({ settings });
    return await execute(parsed, { context, createModel, stdout, signal: dependencies.signal });
  } catch (error) {
    stderr.write(`错误：${describe(error)}\n`);
    return 1;
  }
}

interface ExecuteDependencies {
  readonly context: AssistantContext;
  readonly createModel: () => Promise<Model>;
  readonly stdout: CliOutput;
  readonly signal: AbortSignal | undefined;
}

async function execute(parsed: ParsedCommand, dependencies: ExecuteDependencies): Promise<number> {
  const { context, stdout } = dependencies;
  const command = parsed.command;

  if (command.type === "status") {
    const vault = await context.vault.status();
    const pending = context.mailbox.ledger().pending();
    stdout.write([
      `数据目录：${context.settings.paths.home}`,
      `个人数据库：${vault.root}（${vault.files} 个文件，${vault.chunks} 个片段，Git 未提交 ${vault.pendingChanges} 项）`,
      `邮箱：${context.mailAvailable ? `已配置 ${context.mailbox.address()}` : "未配置"}`,
      `  未处理邮件 ${pending.unhandledMail} 封，待发送草稿 ${pending.drafts} 份（已确认 ${pending.confirmed} 份）`,
      `办事大厅：${context.ehall.confirmation() === undefined ? "没有待确认的表单" : "有已确认的表单"}`,
      `监听：${context.settings.server.host}:${context.settings.server.port}${context.settings.server.allowLan ? "（允许局域网访问）" : ""}`,
    ].join("\n") + "\n");
    await closeAssistantContext(context);
    return 0;
  }

  if (command.type === "index") {
    const result = await context.vault.sync();
    const committed = await context.vault.git.commit("重新索引个人数据库");
    stdout.write(`新增 ${result.added.length} · 更新 ${result.updated.length} · 删除 ${result.removed.length} · 共 ${result.total} 个文件\n`);
    stdout.write(committed ? "已提交 Git。\n" : "没有需要提交的改动。\n");
    await closeAssistantContext(context);
    return 0;
  }

  if (command.type === "rules") {
    const rules = await context.rules.list();
    if (rules.length === 0) stdout.write("还没有记录规则。\n");
    for (const rule of rules) {
      stdout.write(`${rule.path} · ${rule.title} · ${rule.scope}\n  ${rule.text}\n`);
    }
    await closeAssistantContext(context);
    return 0;
  }

  if (command.type === "mail" && (command.action === "check" || command.action === "drafts" || command.action === "show" || command.action === "confirm" || command.action === "send")) {
    const result = await runMailCommand(context, command, stdout);
    await closeAssistantContext(context);
    return result;
  }

  if (command.type === "ehall") {
    const result = await runEhallCommand(context, command, stdout);
    await closeAssistantContext(context);
    return result;
  }

  const assistant = await PersonalAssistant.open({
    settings: context.settings,
    model: await dependencies.createModel(),
    context,
    ...(parsed.poll === false ? { poll: false } : {}),
  });
  try {
    if (command.type === "serve") {
      const served = await assistant.serve();
      stdout.write([
        `个人助手工作台：${served.url}`,
        served.loginUrl === undefined ? "" : `用这个链接连接（一次性票据）：${served.loginUrl}`,
        ...(served.lanUrl === undefined ? [] : [`手机访问：${served.lanUrl}（局域网内有效，控制令牌是唯一凭证，不要暴露到公网）`]),
        "",
        "关掉浏览器页面不会停止助手；Ctrl+C 结束服务。",
        "",
      ].join("\n"));
      await waitForSignal(dependencies.signal);
      return 0;
    }
    if (command.type === "ask") {
      const relay = (async () => {
        for await (const event of assistant.events) {
          if (event.type !== "run.event") continue;
          if (event.event.type === "model.text.delta") stdout.write(event.event.delta);
        }
      })();
      const run = await assistant.submit(command.text);
      const result = await run.result;
      await relay;
      stdout.write("\n");
      if (result.message.content.every((part) => part.type !== "text")) stdout.write("（助手没有返回文字内容）\n");
      return 0;
    }
    throw new Error(`未实现的命令：${command.type}`);
  } finally {
    await assistant.close();
  }
}

async function runMailCommand(
  context: AssistantContext,
  command: { action: string; draftId?: string; digest?: string },
  stdout: CliOutput,
): Promise<number> {
  if (command.action === "check") {
    if (!context.mailAvailable) throw new Error("没有配置邮箱，请在配置里填写 mail 并设置 MAY_ASSISTANT_MAIL_PASSWORD");
    const result = await context.mailbox.check({});
    stdout.write(result.newMessages.length === 0
      ? `没有新邮件。账本里已有 ${result.knownMessages} 封。\n`
      : `新邮件 ${result.newMessages.length} 封：\n${result.newMessages.map((message) => `- ${message.from}：${message.subject}`).join("\n")}\n`);
    return 0;
  }
  if (command.action === "drafts") {
    const views = await context.mailbox.listDraftViews({ limit: 50 });
    if (views.length === 0) {
      stdout.write("没有草稿。\n");
      return 0;
    }
    for (const view of views) {
      stdout.write(`${view.record.id} · ${view.record.state} · ${view.confirmed ? "已确认" : "未确认"} · 摘要 ${shortDigest(view.record.digest)}\n`);
      stdout.write(`  ${view.content.subject} → ${view.content.to.join("、")}\n`);
      stdout.write(`  文件：${view.record.file}\n`);
    }
    return 0;
  }
  const draftId = command.draftId!;
  if (command.action === "show") {
    const view = await context.mailbox.readDraft(draftId);
    stdout.write([
      `草稿 ${view.record.id}（${view.record.state}，${view.confirmed ? "已确认" : "未确认"}，摘要 ${view.record.digest}）`,
      `收件人：${view.content.to.join("、")}`,
      view.content.cc.length === 0 ? "" : `抄送：${view.content.cc.join("、")}`,
      `主题：${view.content.subject}`,
      "",
      "---",
      "",
      view.content.body,
      "",
    ].filter((line) => line !== "").join("\n"));
    return 0;
  }
  if (command.action === "confirm") {
    const view = await context.mailbox.confirmDraft(draftId, command.digest);
    stdout.write(`已确认 ${view.record.id} 的当前内容（摘要 ${view.record.digest}）。\n`);
    return 0;
  }
  const result = await context.mailbox.sendDraft(draftId);
  stdout.write(result.alreadySent
    ? `草稿 ${draftId} 之前已经发送过（${result.record.sentMessageId ?? "无记录"}），没有重复发送。\n`
    : `已发送 ${draftId}，Message-ID：${result.sent?.messageId ?? "未知"}。\n`);
  return 0;
}

async function runEhallCommand(
  context: AssistantContext,
  command: { action: string; serviceId?: string; digest?: string },
  stdout: CliOutput,
): Promise<number> {
  if (command.action === "services") {
    const catalog = await context.ehall.catalog();
    for (const service of catalog.services) {
      stdout.write(`${service.id} · ${service.name} · ${service.category}${service.irreversible ? " · 不可撤销（不提供提交）" : ""}\n`);
      stdout.write(`  ${service.url} · 提交按钮「${service.submitLabel}」\n`);
      if (service.materials.length > 0) stdout.write(`  材料：${service.materials.map((material) => material.path).join("、")}\n`);
      if (service.note !== undefined) stdout.write(`  说明：${service.note}\n`);
    }
    return 0;
  }
  if (command.action === "review") {
    const snapshot = await context.ehall.review(command.serviceId!);
    stdout.write(`${snapshot.title} · ${snapshot.url}\n提交按钮：${snapshot.submitLabel} · 字段摘要：${snapshot.digest}\n\n`);
    for (const field of snapshot.fields) {
      stdout.write(`${field.required ? "*" : " "} ${field.label}（${field.role}）= ${field.value === "" ? "（空）" : field.value}${field.filledByAssistant ? " [助手填写]" : ""}\n`);
    }
    stdout.write(`\n确认命令：may-assistant ehall confirm ${snapshot.digest}\n`);
    return 0;
  }
  if (command.action === "confirm") {
    const confirmation = await context.ehall.confirm(command.digest!);
    stdout.write(`已确认 ${confirmation.serviceId} 的字段摘要 ${confirmation.digest}。\n`);
    return 0;
  }
  const current = await context.ehall.currentServiceId();
  if (current !== command.serviceId) {
    throw new Error(`当前浏览器页面是 ${current ?? "（无）"}，与 ${command.serviceId} 不一致，请先用 ehall_open 打开该事务`);
  }
  const result = await context.ehall.submit({});
  stdout.write(`已提交 ${command.serviceId}，页面：${result.result.url}\n表单记录：${result.file}\n`);
  return 0;
}

function waitForSignal(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
