import { randomUUID } from "node:crypto";
import { uiCommand, type Command } from "./gateway-command-line.js";
import type { GatewayTask } from "./gateway-types.js";

export async function remote(command: Command): Promise<unknown> {
  const url = new URL(command.server!);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("--server must be a loopback http://127.0.0.1:<port> URL");
  const passwordName = command.passwordEnv ?? "MAYBECLAW_ADMIN_PASSWORD";
  const password = process.env[passwordName];
  if (password === undefined) throw new Error(`Set administrator password environment variable ${passwordName}`);
  const login = await fetch(new URL("/api/auth/login", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const credentials = (await login.json()) as { token?: string; error?: string };
  if (!login.ok || !credentials.token) throw new Error(credentials.error ?? "Gateway login failed");
  const token = credentials.token;
  const request = async (path: string, data?: unknown) => {
    const response = await fetch(new URL(path, url), {
      method: data === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error((result as { error?: string }).error ?? "Gateway request failed");
    return result;
  };
  try {
    return await executeRemote();
  } finally {
    await request("/api/auth/logout", {});
  }
  async function executeRemote(): Promise<unknown> {
    if (command.object === "session" && command.action === "list") return request("/api/v2/sessions");
    if (command.object === "session" && command.action === "show")
      return request(`/api/v2/sessions/${encodeURIComponent(command.value!)}`);
    if (command.object === "agent" && command.action === "list") return request("/api/v2/agents");
    if (command.object === "channel") return request("/api/v2/health");
    if (command.object === "delivery")
      return request(`/api/v2/deliveries/${encodeURIComponent(command.value!)}/retry`, {
        confirmUnknown: command.confirm === true,
      });
    if (command.object === "task") {
      if (command.action === "list") return request("/api/v2/tasks");
      if (command.action === "submit")
        return request("/api/v2/tasks", {
          prompt: command.value,
          sessionId: command.session,
          ...(command.agents[0] ? { agent: command.agents[0] } : {}),
          requestId: command.requestId ?? randomUUID(),
        });
      const suffix = ["cancel", "recover", "run"].includes(command.action)
        ? `/${command.action === "run" ? "dispatch" : command.action}`
        : "";
      const result = await request(
        `/api/v2/tasks/${encodeURIComponent(command.value!)}${suffix}`,
        suffix ? {} : undefined,
      );
      if (command.action === "result") {
        if ((result as { task?: GatewayTask }).task?.status !== "completed")
          throw new Error("Task result is not complete");
      }
      return result;
    }
    const snapshot = (await request("/api/ui/snapshot")) as { hostId: string };
    return request("/api/ui/commands", await uiCommand(command, snapshot.hostId));
  }
}
