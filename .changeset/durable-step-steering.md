---
"@may/core": minor
"@may/session": minor
"@may/application": minor
"@may/goal": patch
---

Add durable FIFO steering input at complete Step boundaries. AgentApplication and
Session expose steering status and explicit follow-up execution without
interrupting current tools or approvals. Preserve delivery identities through
restart, retain cancelled inputs for explicit resubmission, and keep host yield
and Run budgets in effect. Add explicit cancellation of pending and idle inputs
so hosts can stop queued work together with the current execution.

Session and AgentApplication reserve Step input for their durable steering queue.
Their submission and continuation options reject custom stepInputSource values
before execution. Use steer() for durable input; direct May execution retains
the custom-source API.
Keep GoalAgent compatible with Session-backed applications by excluding custom
Step sources from the options passed by the goal scheduler.
