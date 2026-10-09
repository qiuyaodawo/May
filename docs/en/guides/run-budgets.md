# Configure Run budgets

**English** | [简体中文](../../zh-CN/guides/run-budgets.md)

Use `runBudget` to limit one Agent execution by duration, steps, calls, tokens,
or cost. This guide covers MaybeCode configuration and the shared code API.
Cost and token limits require usage reported by the selected provider.

## Set default limits

`May`, `AgentApplication`, `defineAgent` and MaybeCode accept `runBudget` defaults.
`run()` / `submit()` / `continue()` may tighten them, never relax them. Each Run,
including explicit retry/continue, gets a fresh budget, not a Session lifetime quota.

Add this object to your MaybeCode configuration file. See the
[configuration reference](../reference/configuration.md) for locations and precedence:

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
remains an additional ceiling: `May` defaults it to 16, a MaybeCode main Run to 32
and a sub-agent child Run to 24. Tool calls are reserved for an entire
batch before any execution, including parallel scheduling. Model-call accounting
counts admitted loop steps, not provider HTTP retries.

The available limit fields are:

| Field | Unit and accounting boundary |
| --- | --- |
| `maxDurationMs` | Milliseconds in the current Run |
| `maxSteps` | Admitted Agent loop steps |
| `maxModelCalls` | Admitted model calls, excluding provider HTTP retries |
| `maxToolCalls` | Reserved tool calls, including the complete next batch |
| `maxTotalTokens` | Provider-reported token use checked at response boundaries |
| `maxCostUsd` | Complete USD cost checked at response boundaries |

## Configure prices for a cost limit

For cost limits, set `maxCostUsd` and explicit `pricing` or legacy `tokenPrices`.
`tokenPrices` keeps `inputUsdPerMillion` and `outputUsdPerMillion`, with optional
`cachedReadUsdPerMillion`, `cachedWriteUsdPerMillion` and `reasoningUsdPerMillion`.
May never guesses rates. Rates are finite non-negative numbers; per-run overrides
cannot change configured prices. Model switching retains the host's rates.

`pricing` adds an identifiable, versioned price schedule:

```ts
const pricing = {
  id: "project-model-prices",
  version: "2026-10-05",
  source: "host configuration",
  effectiveAt: "2026-10-05T00:00:00Z",
  currency: "USD",
  inputPerMillion: 2,
  outputPerMillion: 8,
  cachedReadPerMillion: 0.2,
  cachedWritePerMillion: 3,
  reasoningPerMillion: 8,
};
const runBudget = { maxCostUsd: 1, pricing };
```

These example rates illustrate the API. They are not provider prices. `pricing`
supports additional `items` rates keyed by measurement id, each with a `unit` and
`perUnit`. Code integrations can provide `usagePricer(usage, pricing)` for their
own pricing rules. It returns a `UsageCost` with an optional amount, currency,
`estimated` or `provider` kind, completeness and missing reasons. Call
`priceUsage()` to use the same interface in host telemetry. JSON configuration
accepts price schedules; callbacks are supplied through the code API.

## Interpret provider usage

`Usage` can report `cachedReadTokens`, `cachedWriteTokens`, `reasoningTokens`,
additional `items`, `completeness`, and a provider `reportedCost`. `tokenRelations`
states whether a detail is included in `input`, `output`, `total`, or `none` of
those counts. Missing relationships remain unknown. Included details receive a
separate rate by subtracting them from their containing input/output before
charging the detail. With no separate rate, an included subset retains its
containing component's rate. A separately reported detail requires its own rate.
`total` means a detail is included only in `totalTokens`: neither `inputTokens`
nor `outputTokens` contains it. These details are charged separately and included
once in provider totals; `none` details are added to the provider total.
`resolveUsageTotals()` and `priceUsage()` reject totals smaller than their
declared disjoint components. Use `unknown` when the provider does not establish
which counts contain the detail; its cost remains incomplete.

OpenAI Responses and compatible adapters preserve cache and reasoning details
as input/output subsets. Anthropic cache counts are separate from `input_tokens`
and are included when computing the normalized total. Additional provider units
retain their measurement id, unit, quantity and relation to a reported amount.
Unknown units or missing rates produce incomplete pricing. Provider-reported
amounts retain their currency and source; May performs no currency conversion.

## Inspect the result and budget failures

`RunResult.budget` reports elapsed time, admitted steps/model calls, reserved tool
calls, observed tokens, cost, `usageComplete`, `costComplete`, `costKind` and
`latestCost`. `latestCost` preserves price identity/version, source/effective time
and missing reasons. `costKind` can be estimated, provider, or mixed across calls.
Unknown cost is excluded from `costUsd` and marked incomplete. Missing usage
required by token/cost limits stops execution with `RUN_BUDGET_USAGE_UNAVAILABLE`.
`maxCostUsd` requires complete USD accounting; other currencies can be priced for
telemetry but cannot satisfy a USD limit. `aggregateUsage()` preserves details and
marks aggregates with missing responses as partial.

Completed responses rejected by schema or capability validation still consume
known provider usage. `ModelResponseValidationError` preserves that usage and
an optional prepared cost; Run accounting records it once while the response
continues to fail. `RunBudgetMeter.recordUsage(usage, preparedCost?)` can reuse a
verified pricing receipt. If pricing throws, the meter retains known token counts,
marks cost incomplete and clears `latestCost`; it propagates the pricing error.

Exhaustion emits durable `run.budget.exceeded` with dimension, limit, consumption
and snapshot, followed by `run.failed` / `RUN_BUDGET_EXCEEDED`. Both terminal UIs
show the reason. Proposed unexecuted calls are closed before continuation.
Time limits propagate AbortSignal through context preparation, models, approvals
and tools. Cleanup waits for started tools to settle; uncooperative adapters
cannot be forcibly killed by an in-process contract.

## Verify limits and understand their boundaries

Run a bounded request with the selected real provider. Inspect `RunResult.budget`
for observed counters and completeness. If usage is unavailable under a token
or cost limit, confirm the Run reports `RUN_BUDGET_USAGE_UNAVAILABLE`.
An exhausted dimension reports `RUN_BUDGET_EXCEEDED` in the result and history.

Token and cost limits are checked at response boundaries, so the final request
can overshoot. HTTP retries without returned usage cannot be accurately billed.
Auxiliary requests outside Core's model loop (manual summaries, compaction
models, isolated MCP sampling and remote-tool internals) are outside these
token/call counters and require their own host budgets. This is not a hard
provider billing cap.
