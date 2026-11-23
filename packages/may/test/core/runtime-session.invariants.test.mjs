import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryContext, May } from "@sortedyuan/may/core";
import { InMemorySessionStore, Session } from "@sortedyuan/may/session";
import { fc, pbtRuns } from "@sortedyuan/test-support";

function makeDeterministicModel(plans, counter) {
  return {
    async *stream(_request, options) {
      counter.next += 1;
      const callNum = counter.next;
      const plan = plans.shift() ?? { kind: "text", text: `reply-${callNum}`, tokens: 3 };
      if (plan.kind === "cancel-before-complete") {
        yield { type: "text.delta", delta: "partial" };
        options.signal.throwIfAborted();
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      if (plan.kind === "tool") {
        const id = `call_${callNum}`;
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{ id, name: "echo", input: { value: plan.value } }],
          },
          usage: { totalTokens: plan.tokens },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: { role: "assistant", content: [{ type: "text", text: plan.text }] },
        usage: { totalTokens: plan.tokens },
      };
    },
  };
}

const echoTool = {
  name: "echo",
  description: "Echo a value",
  inputSchema: { type: "object" },
  async execute(input) {
    return { echoed: input.value };
  },
};

test("invariant: Session state machine preserves strictly monotonic seq, idempotent inputId, and exact 1-to-1 tool outcomes", async () => {
  const opArb = fc.oneof(
    fc.record({
      kind: fc.constant("text"),
      inputId: fc.constantFrom("id-1", "id-2", "id-3", "id-4"),
      text: fc.stringMatching(/^[a-z0-9]{1,8}$/),
    }),
    fc.record({
      kind: fc.constant("tool"),
      inputId: fc.constantFrom("t-1", "t-2", "t-3"),
      value: fc.stringMatching(/^[a-z0-9]{1,6}$/),
    }),
    fc.record({ kind: fc.constant("resume") }),
  );

  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), async (ops) => {
      const store = new InMemorySessionStore();
      const plans = [];
      const counter = { next: 0 };
      const submittedIds = new Set();
      let executedToolCount = 0;
      const countedTool = {
        ...echoTool,
        async execute(input) {
          executedToolCount += 1;
          return { echoed: input.value };
        },
      };

      const makeRuntime = (messages = []) =>
        new May({
          model: makeDeterministicModel(plans, counter),
          context: new InMemoryContext(messages),
          tools: [countedTool],
        });

      let session = await Session.create({
        id: "inv_session",
        requestRecording: "off",
        store,
        runtime: makeRuntime(),
      });

      let expectedAccepted = 0;
      let expectedTools = 0;

      for (const op of ops) {
        if (op.kind === "resume") {
          const before = await session.history();
          session = await Session.resume({
            id: "inv_session",
            requestRecording: "off",
            store,
            createRuntime: (messages) => makeRuntime(messages),
          });
          const after = await session.history();
          assert.deepEqual(after, before, "Session.resume must preserve exact durable history");
          continue;
        }

        const isDuplicate = submittedIds.has(op.inputId);
        if (op.kind === "text") {
          if (!isDuplicate) {
            plans.length = 0;
            plans.push({ kind: "text", text: `ok:${op.text}`, tokens: 2 });
          }
          if (isDuplicate) {
            await assert.rejects(session.submit({ input: op.text, inputId: op.inputId }));
          } else {
            const run = await session.submit({ input: op.text, inputId: op.inputId });
            await run.result;
            submittedIds.add(op.inputId);
            expectedAccepted += 1;
          }
        } else {
          if (!isDuplicate) {
            plans.length = 0;
            plans.push({ kind: "tool", value: op.value, tokens: 3 });
            plans.push({ kind: "text", text: `after:${op.value}`, tokens: 2 });
          }
          if (isDuplicate) {
            await assert.rejects(session.submit({ input: op.value, inputId: op.inputId }));
          } else {
            const run = await session.submit({ input: op.value, inputId: op.inputId });
            await run.result;
            submittedIds.add(op.inputId);
            expectedAccepted += 1;
            expectedTools += 1;
          }
        }
      }

      const history = await session.history();
      // Invariant 1: seq is strictly contiguous 1..N
      assert.deepEqual(
        history.map((event) => event.seq),
        Array.from({ length: history.length }, (_, index) => index + 1),
      );
      // Invariant 2: duplicate inputIds never execute a second time
      assert.equal(history.filter((event) => event.type === "input.submitted").length, expectedAccepted);
      assert.equal(executedToolCount, expectedTools);
      // Invariant 3: every proposed (runId, step, call.id) appears once and has exactly one matching durable outcome
      const proposedKeys = history
        .filter((event) => event.type === "assistant.completed")
        .flatMap((event) => (event.message.toolCalls ?? []).map((call) => `${event.runId}:${event.step}:${call.id}`));
      const completedKeys = history
        .filter((event) => event.type === "tool.completed" || event.type === "tool.failed")
        .map((event) => `${event.runId}:${event.step}:${event.call.id}`);
      assert.equal(new Set(proposedKeys).size, proposedKeys.length, "proposed tool call keys must be unique");
      assert.deepEqual(completedKeys, proposedKeys);
    }),
    { numRuns: pbtRuns(60) },
  );
});

test("invariant: RunBudget token and step caps fail closed and never exceed maxModelCalls", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 5, max: 40 }),
      fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 6 }),
      async (maxModelCalls, maxTotalTokens, stepTokens) => {
        let modelCalls = 0;
        const may = new May({
          context: new InMemoryContext(),
          tools: [echoTool],
          runBudget: { maxModelCalls, maxTotalTokens },
          model: {
            async *stream() {
              const tokens = stepTokens[modelCalls] ?? 5;
              modelCalls += 1;
              const moreTools = modelCalls < stepTokens.length;
              yield {
                type: "response.completed",
                message: {
                  role: "assistant",
                  content: moreTools ? [] : [{ type: "text", text: "done" }],
                  ...(moreTools ? { toolCalls: [{ id: `c_${modelCalls}`, name: "echo", input: { value: "x" } }] } : {}),
                },
                usage: { totalTokens: tokens },
              };
            },
          },
        });

        try {
          const result = await may.run({ input: "go" }).result;
          assert.ok(result.budget.modelCalls <= maxModelCalls);
          assert.ok(result.budget.totalTokens <= maxTotalTokens);
        } catch (error) {
          assert.equal(error.code, "RUN_BUDGET_EXCEEDED");
          assert.ok(modelCalls <= maxModelCalls, `modelCalls ${modelCalls} exceeded cap ${maxModelCalls}`);
        }
      },
    ),
    { numRuns: pbtRuns(100) },
  );
});
