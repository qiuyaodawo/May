import { join } from "node:path";
import { AgentApplication } from "../../../application/dist/index.js";
import { createBuiltinProviderModel, createModelCapabilityResolver } from "../../../providers/dist/index.js";
import { FileSessionStore } from "../../../session/dist/file-store.js";
import { CoordinationRuntime, createAttachedApplicationAgent } from "../../dist/index.js";
import { FileCoordinationStore } from "../../dist/file-store.js";

const [directory, boundary] = process.argv.slice(2);

class InterruptedSessionStore extends FileSessionStore {
  async append(event) {
    await super.append(event);
    if (event.type === boundary) process.exit(23);
  }
}

const sessions = new InterruptedSessionStore(join(directory, "sessions"));
const application = await AgentApplication.open({ sessionId: "attached-root", store: sessions,
  model: createBuiltinProviderModel({ profile: "verification", provider: "verification",
    adapter: "openai-chat-completions", model: "gpt-4o", options: {},
    providerConfig: { adapter: "openai-chat-completions", apiKey: "unused-during-local-validation" },
    capabilities: { fields: { "input.text": false } },
  }, { resolver: createModelCapabilityResolver({ discoveries: [] }) }),
  instructions: "Validate the request before model dispatch",
});
const controller = new AbortController();
const worker = createAttachedApplicationAgent({ version: "v1", mode: "continue", attach: () => application,
  read: sessionId => sessions.inspect(sessionId),
  submit: () => ({ input: "Continue", signal: controller.signal, checkpoint: async event => {
    if (boundary === "run.cancelled" && event.type === "run.started") controller.abort("Cancel before model dispatch");
  } }),
});
const runtime = await CoordinationRuntime.create({ id: "attached-recovery",
  store: new FileCoordinationStore(join(directory, "coordination")),
  agents: { worker }, policy: { version: "v1", authorize: () => true },
  sessionIds: { root: application.sessionId }, tasks: [{ id: "root", agent: "worker", input: "Continue" }],
});
await runtime.wait();
await runtime.close();
await application.close();
throw new Error(`Execution did not reach ${boundary}`);
