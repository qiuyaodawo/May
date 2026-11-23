import assert from "node:assert/strict";
import test from "node:test";
import { PermissionDeniedError, PermissionToolExecutor } from "@sortedyuan/may/permissions";
import { fc, pbtRuns } from "@sortedyuan/test-support";

function makeExecution(name, input, executeFn, options = {}) {
  const controller = options.controller ?? new AbortController();
  const tool = options.tool ?? {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" },
    execute: executeFn,
  };
  return {
    tool,
    input,
    context: {
      runId: "run-inv",
      step: 1,
      toolCallId: options.callId ?? "call-1",
      signal: controller.signal,
    },
  };
}

test("invariant: deny always fails closed and requireApproval is never bypassed by session grants", async () => {
  const stepArb = fc.record({
    decision: fc.constantFrom("allow", "deny", "ask"),
    requireApproval: fc.boolean(),
    grantKey: fc.constantFrom("grant-a", "grant-b"),
    approval: fc.constantFrom("allow", "allow-session", "deny"),
  });

  await fc.assert(
    fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
      let currentPolicy = "deny";
      let currentApproval = "deny";
      const permissions = new PermissionToolExecutor({
        policy: () => currentPolicy,
      });
      const pendingApprovals = [];
      const iterator = permissions.events[Symbol.asyncIterator]();
      const pump = (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          if (next.value.type === "approval.requested") {
            pendingApprovals.push(next.value.request);
            if (next.value.request.grantKey === undefined && currentApproval === "allow-session") {
              // requireApproval requests omit grantKey so session-wide grants are structurally impossible.
              await assert.rejects(
                permissions.resolve(next.value.request.id, "allow-session"),
                /does not define a session grant key/,
              );
              await permissions.resolve(next.value.request.id, "allow");
            } else {
              await permissions.resolve(next.value.request.id, currentApproval);
            }
          }
        }
      })();

      try {
        const grantedKeys = new Set();
        for (let i = 0; i < steps.length; i += 1) {
          const step = steps[i];
          const approvalsBefore = pendingApprovals.length;
          let executed = false;
          currentApproval = step.approval;
          currentPolicy =
            step.decision === "ask"
              ? {
                  decision: "ask",
                  grantKey: step.grantKey,
                  ...(step.requireApproval ? { requireApproval: true } : {}),
                }
              : step.decision;

          const execPromise = permissions.execute(
            makeExecution(
              "shell",
              { command: `cmd-${i}` },
              async () => {
                executed = true;
                return "ok";
              },
              { callId: `call-${i}` },
            ),
          );

          const hasSessionGrant = !step.requireApproval && grantedKeys.has(step.grantKey);
          const shouldExecute =
            step.decision === "allow" ||
            (step.decision === "ask" &&
              (hasSessionGrant || step.approval === "allow" || step.approval === "allow-session"));

          if (shouldExecute) {
            assert.equal(await execPromise, "ok");
            assert.equal(executed, true);
            if (step.decision === "ask" && step.requireApproval) {
              assert.equal(
                pendingApprovals.length,
                approvalsBefore + 1,
                "requireApproval:true must always request fresh approval even after allow-session",
              );
            }
            if (
              step.decision === "ask" &&
              !step.requireApproval &&
              !hasSessionGrant &&
              step.approval === "allow-session"
            ) {
              grantedKeys.add(step.grantKey);
            }
          } else {
            await assert.rejects(execPromise, PermissionDeniedError);
            assert.equal(executed, false, "denied tool must NEVER invoke underlying execute()");
          }
        }
      } finally {
        await permissions.close();
        await pump;
      }
    }),
    { numRuns: pbtRuns(80) },
  );
});

test("invariant: concurrent duplicate resolve() calls succeed at most once and match execution outcome", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("allow", "deny"), { minLength: 2, maxLength: 8 }), async (decisions) => {
      let executed = 0;
      const permissions = new PermissionToolExecutor({ policy: () => "ask" });
      const iterator = permissions.events[Symbol.asyncIterator]();
      const executionPromise = permissions.execute(
        makeExecution("bash", { command: "ls" }, async () => {
          executed += 1;
          return "ran";
        }),
      );

      const requested = (await iterator.next()).value;
      assert.equal(requested.type, "approval.requested");

      const results = await Promise.all(
        decisions.map((decision) => permissions.resolve(requested.request.id, decision)),
      );
      const winners = results.map((ok, idx) => (ok ? decisions[idx] : undefined)).filter(Boolean);
      assert.equal(winners.length, 1, "exactly one concurrent resolve() must win");

      if (winners[0] === "allow") {
        assert.equal(await executionPromise, "ran");
        assert.equal(executed, 1);
      } else {
        await assert.rejects(executionPromise, PermissionDeniedError);
        assert.equal(executed, 0);
      }
      await permissions.close();
    }),
    { numRuns: pbtRuns(100) },
  );
});

test("invariant: mutating tool definition during approval wait fails closed (TOCTOU)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{1,12}$/), async (tamperedDescription) => {
      let executed = false;
      const tool = {
        name: "mutated",
        description: "original",
        inputSchema: { type: "object" },
        async execute() {
          executed = true;
          return "should-not-run";
        },
      };
      const permissions = new PermissionToolExecutor({ policy: () => "ask" });
      const iterator = permissions.events[Symbol.asyncIterator]();
      const pending = permissions.execute(makeExecution("mutated", { x: 1 }, tool.execute, { tool }));

      const requested = (await iterator.next()).value;
      assert.equal(requested.type, "approval.requested");
      tool.description = `tampered-${tamperedDescription}`;
      await permissions.resolve(requested.request.id, "allow");

      await assert.rejects(pending, PermissionDeniedError);
      assert.equal(executed, false);
      await permissions.close();
    }),
    { numRuns: pbtRuns(50) },
  );
});
