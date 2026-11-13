import type { Tool } from "@sortedyuan/may/core";
import { fields, identifier, parseTeamReport, type TeamCheckSpec, type TeamReport } from "./team-check-spec.js";
import { hash } from "./team-check-runner.js";
import type { StoredTeamReport, TeamCheckResult } from "./team-verification.js";

export function createTeamVerificationTools(
  checks: readonly TeamCheckSpec[],
  taskId: string,
  submit: (commandId: string, report: TeamReport) => Promise<StoredTeamReport>,
  runCheck: (commandId: string, id: string, extra?: { readonly signal?: AbortSignal }) => Promise<TeamCheckResult>,
): readonly Tool[] {
  return [
    {
      name: "submit_report",
      permissionVersion: "team-verification-v1",
      description:
        "Store a structured report and file/line evidence. The host validates evidence bytes, not claim correctness. This never grants acceptance.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "claims"],
        properties: {
          summary: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "kind"],
              properties: {
                text: { type: "string" },
                kind: { type: "string", enum: ["finding", "proposal"] },
                evidence: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["path", "startLine", "endLine"],
                    properties: {
                      path: { type: "string" },
                      startLine: { type: "integer" },
                      endLine: { type: "integer" },
                      quote: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      parse: parseTeamReport,
      async execute(input, call) {
        call.signal.throwIfAborted();
        return submit(hash(call.idempotencyKey), input as TeamReport);
      },
    },
    {
      name: "run_check",
      permissionVersion: "team-verification-v1",
      description: `Run one exact host-configured check by id; no model-supplied commands or arguments. Available: ${
        checks
          .filter((entry) => entry.taskId === taskId)
          .map((entry) => entry.id)
          .join(", ") || "none"
      }. Command checks require explicit host authorization and are not sandboxed.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      parse(value: unknown) {
        const input = fields(value, ["id"]);
        identifier(input.id, "check id");
        return { id: input.id as string };
      },
      async execute(input, call) {
        call.signal.throwIfAborted();
        return runCheck(hash(call.idempotencyKey), (input as { id: string }).id, { signal: call.signal });
      },
    },
  ];
}
