import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import { TaskRejectedError } from "../../dist/index.js";

export class DurableTaskHost extends EventEmitter {
  constructor(directory, acknowledgementDelayMs = 0) {
    super();
    this.directory = directory;
    this.acknowledgementDelayMs = acknowledgementDelayMs;
    this.activeSubmissions = 0;
    this.maxActiveSubmissions = 0;
    this.database = new DatabaseSync(join(directory, "tasks.sqlite"));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        execution_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        artifact_path TEXT NOT NULL
      );
    `);
  }

  static async open(directory, { acknowledgementDelayMs = 0 } = {}) {
    await mkdir(directory, { recursive: true });
    return new DurableTaskHost(directory, acknowledgementDelayMs);
  }

  async submit(request) {
    if (request.handler !== "write-artifact") {
      throw new TaskRejectedError(`Unknown handler: ${request.handler}`);
    }
    const existing = this.database.prepare(
      "SELECT task_id, request_json FROM tasks WHERE execution_id = ?",
    ).get(request.executionId);
    if (existing !== undefined) {
      if (existing.request_json !== JSON.stringify(request)) {
        throw new TaskRejectedError("The executionId already has a different request.");
      }
      return { taskId: existing.task_id };
    }
    const taskId = `task_${randomUUID()}`;
    const acceptedAt = new Date().toISOString();
    const artifactPath = join(this.directory, `${taskId}.json`);
    this.database.prepare(`
      INSERT INTO tasks (execution_id, task_id, request_json, accepted_at, artifact_path)
      VALUES (?, ?, ?, ?, ?)
    `).run(request.executionId, taskId, JSON.stringify(request), acceptedAt, artifactPath);
    this.activeSubmissions += 1;
    this.maxActiveSubmissions = Math.max(this.maxActiveSubmissions, this.activeSubmissions);
    try {
      await writeFile(artifactPath, `${JSON.stringify({ taskId, acceptedAt, request }, null, 2)}\n`);
      this.emit("accepted", { taskId, acceptedAt, request, artifactPath });
      if (this.acknowledgementDelayMs > 0) {
        await delay(this.acknowledgementDelayMs);
      }
      return { taskId };
    } finally {
      this.activeSubmissions -= 1;
    }
  }

  tasks() {
    return this.database.prepare("SELECT * FROM tasks ORDER BY accepted_at, task_id").all();
  }

  async listen() {
    this.server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/tasks") {
          response.writeHead(404).end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await this.submit(input);
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(error instanceof TaskRejectedError ? 422 : 500, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify({ message: error.message }));
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${this.server.address().port}/tasks`;
  }

  async close() {
    if (this.server !== undefined) {
      this.server.closeAllConnections();
      await new Promise((resolve, reject) => this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
      this.server = undefined;
    }
    this.database.close();
  }
}

export class HttpTaskDispatcher {
  constructor(endpoint, { timeoutMs } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }

  async submit(request) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(this.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(this.timeoutMs) }),
    });
    const result = await response.json();
    if (response.status === 422) throw new TaskRejectedError(result.message);
    if (!response.ok) throw new Error(`Task host returned ${response.status}: ${result.message}`);
    return result;
  }
}
