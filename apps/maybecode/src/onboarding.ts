import { SelectList } from "@sortedyuan/tui";
import { createNodeTerminal } from "@sortedyuan/tui/node-terminal";
import { setImmediate } from "node:timers/promises";
import { createMayConfig, parseMayConfig, type MayConfig } from "@sortedyuan/may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";
import type { MaybeCodeStartCommand } from "./args.js";

const providers = [
  { name: "OpenAI (Responses)", adapter: "openai-responses", url: "https://api.openai.com/v1", env: "OPENAI_API_KEY", suffix: "/responses", options: ["maxOutputTokens", "reasoningEffort", "reasoningSummary", "serverCompactThreshold", "store", "responseFormat"] },
  { name: "OpenAI (Chat Completions)", adapter: "openai-chat-completions", url: "https://api.openai.com/v1", env: "OPENAI_API_KEY", suffix: "/chat/completions", options: ["maxOutputTokens", "reasoningEffort", "store", "responseFormat"] },
  { name: "Anthropic", adapter: "anthropic-messages", url: "https://api.anthropic.com", env: "ANTHROPIC_API_KEY", suffix: "/v1/messages", options: ["thinking", "reasoningEffort", "maxTokens", "apiVersion"] },
  { name: "Google Gemini", adapter: "google-gemini", url: "https://generativelanguage.googleapis.com/v1beta", env: "GEMINI_API_KEY", suffix: "/models/{model}:streamGenerateContent", options: ["maxOutputTokens", "reasoningEffort", "thinkingBudget", "includeThoughts", "responseFormat"] },
  { name: "DeepSeek", adapter: "deepseek-chat", url: "https://api.deepseek.com", env: "DEEPSEEK_API_KEY", suffix: "/chat/completions", options: ["thinking", "reasoningEffort", "maxTokens"] },
  { name: "Zhipu", adapter: "zhipu-chat", url: "https://open.bigmodel.cn/api/paas/v4", env: "ZHIPU_API_KEY", suffix: "/chat/completions", options: ["thinking", "clearThinking", "reasoningEffort", "maxTokens"] },
  { name: "Kimi", adapter: "kimi-chat", url: "https://api.moonshot.ai/v1", env: "MOONSHOT_API_KEY", suffix: "/chat/completions", options: ["thinking", "reasoningEffort", "maxTokens"] },
] as const;

class Back extends Error {}
class Cancel extends Error {}
const back = { name: "Back", value: "back" };
const cancel = { name: "Cancel setup", value: "cancel" };

interface Draft {
  provider: number;
  custom: boolean;
  baseURL: string;
  credential: "env" | "key";
  apiKey: string;
  apiKeyEnv: string;
  profile: string;
  model: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  options: string;
}

function configuration(draft: Draft, path: string): MayConfig {
  return parseMayConfig({
    providers: { primary: {
      adapter: providers[draft.provider]!.adapter,
      baseURL: draft.baseURL,
      ...(draft.credential === "env" ? { apiKeyEnv: draft.apiKeyEnv } : { apiKey: draft.apiKey }),
    } },
    models: { [draft.profile]: {
      provider: "primary", model: draft.model,
      ...(draft.contextWindowTokens === "" ? {} : { contextWindowTokens: Number(draft.contextWindowTokens) }),
      ...(draft.maxOutputTokens === "" ? {} : { maxOutputTokens: Number(draft.maxOutputTokens) }),
      ...(draft.options === "" ? {} : { options: JSON.parse(draft.options) as Record<string, unknown> }),
    } },
    defaultModel: draft.profile,
  }, path);
}

/** 通过实际 Adapter 检查独立请求，完成响应后才确认成功。 */
export async function checkOnboardingConnection(config: MayConfig, signal: AbortSignal, timeoutMs = 30_000): Promise<void> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const model = createBuiltinProviderModel(selectProviderModel(config));
  let completed = false;
  for await (const event of model.stream({
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }], tools: [],
  }, { signal: combined })) {
    combined.throwIfAborted();
    if (event.type === "response.completed") {
      completed = event.message.content.some(part => part.type === "text" && part.text.trim() !== "");
    }
  }
  combined.throwIfAborted();
  if (!completed) throw new Error("No completed text response");
}

function connectionProblem(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "The request timed out. Check the address and network, then retry.";
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const hint = error.status === 401 || error.status === 403 ? "Check your credentials and account access."
      : error.status === 404 ? "Check the base URL, protocol, and model ID."
        : error.status === 429 ? "Check your account quota or retry later." : "Check your provider settings and service status.";
    return `HTTP ${error.status}. ${hint}`;
  }
  return "A completed text response was not received. Check the address, protocol, model ID, options, and network, then retry.";
}

export async function runMaybeCodeOnboarding(path: string, command: MaybeCodeStartCommand): Promise<boolean> {
  const controller = new AbortController();
  const context = { signal: controller.signal };
  const terminal = createNodeTerminal();
  const interrupt = () => controller.abort(new Cancel());
  const removeInterrupt = terminal.onInterrupt!(interrupt);
  process.once("SIGINT", interrupt);
  process.stdin.once("end", interrupt);
  const draft: Draft = { provider: 0, custom: false, baseURL: providers[0].url, credential: "env", apiKey: "", apiKeyEnv: providers[0].env,
    profile: command.model ?? "default", model: "", contextWindowTokens: "", maxOutputTokens: "", options: "" };
  let saved = false;
  let verified = false;
  let completion: string | undefined;
  let screen = "";
  const write = (message: string) => {
    screen += `${message}\n`;
    terminal.write(`${message}\n`);
  };
  const text = async (message: string, value: string, validate: (value: string) => boolean | string = required, clearable = false, password = false): Promise<string> => {
    write(`Enter: continue | Esc: back | Ctrl+C: cancel${clearable ? " | :clear: remove this setting" : ""}`);
    while (true) {
      const question = new AbortController();
      let answer: string;
      try {
        answer = (await terminal.question(`${message}${value && !password ? ` [${value}]` : ""}: `, {
          signal: AbortSignal.any([controller.signal, question.signal]), history: false, password,
          onEscape: () => question.abort(new Back()),
        })).trim();
      } catch (error) {
        controller.signal.throwIfAborted();
        if (question.signal.aborted) throw question.signal.reason;
        throw error;
      }
      if (clearable && answer === ":clear") return "";
      const result = answer || value;
      const valid = validate(result);
      if (valid === true) return result;
      write(typeof valid === "string" ? valid : "Enter a valid value.");
    }
  };
  const choose = async (message: string, choices: { name: string; value: string }[], value?: string, escapeValue = "back") => {
    let result: string | undefined;
    const list = new SelectList(choices.map(choice => ({ label: choice.name, value: choice.value })), {
      selectedIndex: Math.max(0, choices.findIndex(choice => choice.value === value)),
      onSelect: item => { result = item.value; },
      onCancel: () => { result = escapeValue; },
      keybindings: [
        { context: "select", keys: "escape", action: "list.cancel" },
      ],
    });
    list.setFocused(true);
    while (result === undefined) {
      const lines = list.render({ width: Math.max(1, (process.stdout.columns || 80) - 1), height: Math.max(1, Math.min(12, (process.stdout.rows || 24) - 4)) }).lines;
      terminal.write(`\x1b[2J\x1b[H${screen}${message}\n\n${lines.join("\n")}\n\nUp/Down: select | Enter: confirm | Esc: ${escapeValue === "cancel" ? "cancel" : "back"} | Ctrl+C: cancel`);
      const key = await terminal.readKey!(context);
      if (key.ctrl && key.key === "c") throw new Cancel();
      list.handleKey(key);
    }
    terminal.write(`\x1b[2J\x1b[H${screen}`);
    if (result === "back") throw new Back();
    if (result === "cancel") throw new Cancel();
    write(`${message}: ${choices.find(choice => choice.value === result)!.name}`);
    return result;
  };
  try {
    terminal.write("\x1b[?1049h");
    let step = 0;
    const previous: number[] = [];
    const advance = (next: number) => { previous.push(step); step = next; };
    const selectProvider = (selected: string) => {
      if (Number(selected) === draft.provider) return;
      draft.provider = Number(selected);
      draft.baseURL = providers[draft.provider]!.url;
      draft.apiKeyEnv = providers[draft.provider]!.env;
      draft.options = "";
    };
    while (true) {
      screen = `Welcome to MaybeCode\nConfiguration: ${path}\n\n`;
      terminal.write(`\x1b[2J\x1b[H${screen}`);
      try {
        if (step === 0) {
          await choose(command.configPath === undefined ? "Start configuration?" : "Create a new configuration at this path?", [{ name: "Start configuration", value: "start" }, cancel], undefined, "cancel");
          advance(1);
        } else if (step === 1) {
          verified = false;
          const choice = await choose("Provider", [
            ...providers.map((provider, index) => ({ name: provider.name, value: String(index) })),
            { name: "Custom compatible service", value: "custom" }, back, cancel,
          ], draft.custom ? "custom" : String(draft.provider));
          draft.custom = choice === "custom";
          if (!draft.custom) selectProvider(choice);
          advance(draft.custom ? 2 : 3);
        } else if (step === 2) {
          selectProvider(await choose("API protocol", [...providers.map((provider, index) => ({ name: provider.adapter, value: String(index) })), back, cancel], String(draft.provider)));
          advance(3);
        } else if (step === 3) {
          write(`The adapter appends ${providers[draft.provider]!.suffix} to the base URL. Include any API version prefix required by your service.`);
          draft.baseURL = await text("Base URL", draft.baseURL, validURL);
          advance(4);
        } else if (step === 4) {
          verified = false;
          draft.credential = await choose("Credentials", [
            { name: "Use an environment variable", value: "env" },
            { name: "Enter an API key (saved as plain text in the config file)", value: "key" }, back, cancel,
          ], draft.credential) as "env" | "key";
          advance(5);
        } else if (step === 5) {
          if (draft.credential === "env") {
            draft.apiKeyEnv = await text("Environment variable name", draft.apiKeyEnv, value => {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) return "Enter a valid environment variable name.";
              return process.env[value]?.trim() ? true : "This variable is empty or unavailable in this process. Press Esc to choose another credential method.";
            });
          } else {
            draft.apiKey = await text(draft.apiKey ? "API key (input hidden; leave empty to keep the current key)" : "API key (input hidden)", draft.apiKey, required, false, true);
          }
          advance(6);
        } else if (step === 6) {
          verified = false;
          draft.model = await text("Model ID", draft.model);
          advance(7);
        } else if (step === 7) {
          draft.profile = await text("Model profile name", draft.profile, value =>
            command.model !== undefined && value !== command.model
              ? `This launch uses --model ${command.model}. Use that profile name to continue.` : required(value));
          advance(8);
        } else if (step === 8) {
          const advanced = await choose("Model settings", [{ name: "Continue", value: "continue" }, { name: "Edit advanced settings", value: "advanced" }, back, cancel]);
          advance(advanced === "advanced" ? 9 : 12);
        } else if (step === 9) {
          write("Enter keeps the displayed value. Type :clear to remove an advanced setting and use existing defaults.");
          draft.contextWindowTokens = await text("Context window tokens (optional)", draft.contextWindowTokens, optionalInteger, true);
          advance(10);
        } else if (step === 10) {
          draft.maxOutputTokens = await text("Maximum output tokens (optional)", draft.maxOutputTokens, optionalInteger, true);
          advance(11);
        } else if (step === 11) {
          const keys = [...providers[draft.provider]!.options, "unknownCapabilityPolicy"];
          write(`Adapter options: ${keys.join(", ")}`);
          draft.options = await text("Adapter options as a JSON object (optional)", draft.options, value => {
            if (!value) return true;
            let options: unknown;
            try { options = JSON.parse(value); } catch { return "Enter a valid JSON object."; }
            if (options === null || typeof options !== "object" || Array.isArray(options)) return "Enter a JSON object.";
            return Object.keys(options).every(key => keys.includes(key)) || "Use only the listed adapter option names.";
          }, true);
          advance(12);
        } else if (step === 12) {
          let config: MayConfig;
          try {
            config = configuration(draft, path);
            createBuiltinProviderModel(selectProviderModel(config));
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            // 配置错误仅显示本地校验信息；凭据内容始终隐藏。
            const secret = draft.credential === "key" ? draft.apiKey : process.env[draft.apiKeyEnv];
            const message = secret ? error.message.replaceAll(secret, "[hidden]") : error.message;
            write(`Configuration needs attention: ${message.replace(/[\x00-\x1f\x7f]/gu, " ")}`);
            const target = await choose("Edit configuration", [{ name: "Provider", value: "1" }, { name: "Credentials", value: "4" }, { name: "Model and advanced settings", value: "6" }, back, cancel]);
            advance(Number(target));
            continue;
          }
          write("Local configuration checks passed.");
          const action = await choose("Connection check", [
            { name: "Test connection (sends a short request; API charges may apply)", value: "test" },
            { name: "Skip connection check", value: "skip" }, back, cancel,
          ]);
          verified = false;
          if (action === "test") {
            write("Checking connection (30-second timeout). Press Ctrl+C to cancel setup.");
            try { await checkOnboardingConnection(config, controller.signal); verified = true; }
            catch (error) {
              controller.signal.throwIfAborted();
              write(`Connection check failed. ${connectionProblem(error)}`);
              const next = await choose("Next action", [{ name: "Retry", value: "retry" }, { name: "Edit provider", value: "1" }, { name: "Edit credentials", value: "4" }, { name: "Edit model and advanced settings", value: "6" }, { name: "Skip connection check", value: "skip" }, { name: "Back", value: "retry" }, cancel], undefined, "retry");
              if (next !== "skip") { if (next !== "retry") advance(Number(next)); continue; }
            }
          }
          advance(13);
        } else {
          write(`\nReview configuration\nPath: ${path}\nProvider: ${draft.custom ? "Custom compatible service" : providers[draft.provider]!.name}\nProtocol: ${providers[draft.provider]!.adapter}\nBase URL: ${draft.baseURL}\nModel: ${draft.model}\nDefault profile: ${draft.profile}\nCredentials: ${draft.credential === "env" ? `Environment variable ${draft.apiKeyEnv}` : "API key stored as plain text (hidden)"}\nContext window tokens: ${draft.contextWindowTokens || "Default"}\nMaximum output tokens: ${draft.maxOutputTokens || "Default"}\nAdvanced options: ${draft.options || "Default"}\nConnection: ${verified ? "Verified" : "Not verified"}`);
          await choose("Save configuration?", [{ name: "Save and start", value: "save" }, back, cancel]);
          const config = configuration(draft, path);
          createBuiltinProviderModel(selectProviderModel(config));
          await createMayConfig(path, { providers: config.providers, models: config.models, defaultModel: config.defaultModel }, context);
          saved = true;
          completion = `Configuration saved to ${path}. Starting MaybeCode.`;
          return true;
        }
      } catch (error) {
        if (!(error instanceof Back)) throw error;
        step = previous.pop() ?? 0;
        verified = false;
      }
    }
  } catch (error) {
    if (error instanceof Cancel || controller.signal.aborted) {
      completion = saved ? `Setup cancelled. Configuration is saved at ${path}.` : "Setup cancelled. Configuration was not saved.";
      return false;
    }
    throw error;
  } finally {
    // 等待 stdin 完成暂停，再恢复终端模式并交给后续界面。
    process.stdin.pause();
    await setImmediate();
    removeInterrupt();
    terminal.close();
    process.stdout.write("\x1b[?1049l");
    if (completion !== undefined) process.stdout.write(`${completion}\n`);
    process.removeListener("SIGINT", interrupt);
    process.stdin.removeListener("end", interrupt);
  }
}

function required(value: string): boolean | string {
  return (value.length > 0 && !/[\x00-\x1f\x7f]/u.test(value)) || "Enter a nonempty value without control characters.";
}

function optionalInteger(value: string): boolean | string {
  return value === "" || (Number.isSafeInteger(Number(value)) && Number(value) > 0) || "Enter a positive integer, or leave empty.";
}

function validURL(value: string): boolean | string {
  let url: URL;
  try { url = new URL(value); } catch { return "Enter a complete HTTP or HTTPS URL."; }
  return (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !/[\x00-\x20\x7f]/u.test(value))
    || "Use HTTP or HTTPS without credentials, query parameters, fragments, or whitespace.";
}
