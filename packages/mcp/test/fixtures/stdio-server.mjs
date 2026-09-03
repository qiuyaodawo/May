import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("--fail")) {
  writeSync(
    process.stderr.fd,
    `\u001b[31m${"x".repeat(200)}STARTUP_DIAGNOSTIC\u001b[0m\n`,
  );
  process.exit(2);
}

const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "may-test-server", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, {
      tools: [
        {
          name: "echo.value",
          description: "Echo one value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
        {
          name: "reported-error",
          description: "Return an MCP tool error",
          inputSchema: { type: "object" },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params.arguments?.value === "never") return;
    const progressToken = message.params?._meta?.progressToken;
    if (progressToken !== undefined) {
      write({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken,
          progress: 1,
          total: 1,
          message: "remote work complete",
        },
      });
    }
    if (message.params.name === "reported-error") {
      reply(message.id, {
        isError: true,
        content: [{ type: "text", text: "remote failure" }],
      });
      return;
    }
    reply(message.id, {
      content: [{
        type: "text",
        text: `echo:${message.params.arguments?.value ?? ""}`,
      }],
      structuredContent: { echoed: message.params.arguments?.value ?? "" },
    });
  }
});

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
