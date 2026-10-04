import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog, MaybeCodeWorkspace, createMaybeCodeModel } from "../dist/index.js";

export async function yoloDirectory() {
  const base = fileURLToPath(new URL("../../../review/yolo-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "case-"));
}

export function localModel() {
  // 使用真实 adapter；这些测试只操作权限和会话，不发起模型请求。
  return createMaybeCodeModel({ profile: "offline", provider: "openai", adapter: "openai-responses",
    model: "gpt-4.1", options: {}, providerConfig: { adapter: "openai-responses",
      apiKey: "unused-without-model-requests", baseURL: "http://127.0.0.1:1/v1" } });
}

export async function yoloWorkspace(options = {}) {
  const workspace = options.workspace ?? await yoloDirectory();
  return MaybeCodeWorkspace.open({ git: false, workspace, model: localModel(), store: new InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(), instructions: "Local permission tests", skills: false, ...options });
}
