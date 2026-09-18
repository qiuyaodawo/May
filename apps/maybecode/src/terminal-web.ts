import { randomBytes } from "node:crypto";
import open from "open";
import { AsyncEventQueue, isStreamingMayEvent } from "@may/core";
import type { MaybeCodeController } from "./controller.js";
import type { MaybeCodeEvent } from "./events.js";
import { createMaybeCodeWebHost, startMaybeCodeWebServer } from "./web-ui.js";

function eventQueue() {
  return new AsyncEventQueue<MaybeCodeEvent>({
    maxBufferedValues: 1024,
    isDroppable: event => event.type === "mcp.resource.updated" || event.type === "run.event" && isStreamingMayEvent(event.event),
  });
}

export class MaybeCodeTerminalWeb {
  private readonly terminalEvents = eventQueue();
  private readonly webEvents = eventQueue();
  private readonly host;
  private readonly relay: Promise<void>;
  private failure: unknown;
  private starting: ReturnType<typeof startMaybeCodeWebServer> | undefined;
  private closing: Promise<void> | undefined;
  readonly events: AsyncIterable<MaybeCodeEvent>;

  constructor(private readonly app: MaybeCodeController) {
    this.host = createMaybeCodeWebHost(app, { events: this.webEvents, closeApplication: false, terminal: true });
    this.events = this.readTerminalEvents();
    this.relay = this.forwardEvents().catch(error => { this.failure = error; });
  }

  private async forwardEvents(): Promise<void> {
    try {
      for await (const event of this.app.events) {
        this.terminalEvents.push(event);
        this.webEvents.push(event);
      }
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.terminalEvents.close();
      this.webEvents.close();
    }
  }

  private async *readTerminalEvents(): AsyncIterable<MaybeCodeEvent> {
    for await (const event of this.terminalEvents) yield event;
    if (this.failure !== undefined) throw this.failure;
  }

  async open(): Promise<string> {
    const server = await this.startServer();
    const url = server.createLoginUrl();
    try {
      await open(url);
    } catch {
      throw new Error("无法打开默认浏览器，请检查系统浏览器设置后重新执行 /web。");
    }
    return server.url;
  }

  async startServer(): ReturnType<typeof startMaybeCodeWebServer> {
    if (this.closing) throw new Error("MaybeCode 正在关闭。");
    this.starting ??= startMaybeCodeWebServer(this.host, { token: randomBytes(32).toString("base64url"), port: 0, browserLogin: true });
    const server = await this.starting;
    if (this.closing) throw new Error("MaybeCode 正在关闭。");
    return server;
  }

  close(): Promise<void> {
    return this.closing ??= this.closeOwnedResources();
  }

  private async closeOwnedResources(): Promise<void> {
    const results = await Promise.allSettled([
      this.app.close(),
      this.starting ? this.starting.then(server => server.close()) : this.host.close(),
    ]);
    await this.relay;
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (this.failure !== undefined) failures.push(this.failure);
    if (failures.length) throw new AggregateError(failures, "关闭 MaybeCode 时发生错误。");
  }
}
