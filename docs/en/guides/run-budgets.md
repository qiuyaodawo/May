# Run budgets

[简体中文](../../zh-CN/guides/run-budgets.md)

`May`, `AgentApplication`, `defineAgent` and MaybeCode accept `runBudget` defaults.
`run()` / `submit()` / `continue()` may tighten them, never relax them. Each Run,
including explicit retry/continue, gets a fresh budget, not a Session lifetime quota.

MaybeCode accepts this configuration:

```json
{
  "apps": {
    "maybecode": {
      "runBudget": {
        "maxDurationMs": 300000,
        "maxSteps": 12,
        "maxModelCalls": 12,
        "maxToolCalls": 30,
        "maxTotalTokens": 100000
      }
    }
  }
}
```

Limits are optional positive numbers (integers except USD). Existing `maxSteps`
remains an additional ceiling, default 16. Tool calls are reserved for an entire
batch before any execution, including parallel scheduling. Model-call accounting
counts admitted loop steps, not provider HTTP retries.

For estimated cost limits, set `maxCostUsd` and `tokenPrices` containing
`inputUsdPerMillion` and `outputUsdPerMillion`. May never guesses rates. Rates
are finite non-negative numbers; per-run overrides cannot change configured rates.
Model switching retains these host rates: adjust configuration when assumptions change.

`RunResult.budget` reports elapsed time, steps/model calls admitted, tool calls
reserved, observed tokens, estimated cost and `usageComplete`. Total tokens use
provider total usage or input plus output. Missing required usage fails closed
with `RUN_BUDGET_USAGE_UNAVAILABLE`; without token/cost limits, incomplete usage
is marked. Cost is zero when prices are not configured.

Exhaustion emits durable `run.budget.exceeded` with dimension, limit, consumption
and snapshot, followed by `run.failed` / `RUN_BUDGET_EXCEEDED`. Both terminal UIs
show the reason. Proposed unexecuted calls are closed before continuation.
Time limits propagate AbortSignal through context preparation, models, approvals
and tools. Cleanup waits for started tools to settle; uncooperative adapters
cannot be forcibly killed by an in-process contract.

Token and cost limits are checked at response boundaries, so the final request
can overshoot. HTTP retries without returned usage cannot be accurately billed.
Auxiliary requests outside Core's model loop (manual summaries, compaction
models, isolated MCP sampling and remote-tool internals) are outside these
token/call counters and require their own host budgets. This is not a hard
provider billing cap.
