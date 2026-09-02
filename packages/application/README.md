# @may/application

Headless lifecycle components for composing a May Agent product.

`AgentApplication` owns one durable session: it creates or resumes the runtime,
relays run and approval events, serializes active-run state, persists context
compaction, and closes outstanding work safely. Prompts, tools, permission policy
and optional tool-presentation metadata are injected by the product.

`AgentWorkspace` adds a session catalog, auto-resume, session switching and a
serialized application-transition primitive. Products retain their own model
profiles and can use `transitionApplication` to rebuild the same session after a
model/configuration change.

```ts
import { AgentApplication, AgentWorkspace } from "@may/application";

const workspace = await AgentWorkspace.open({
  workspace: process.cwd(),
  store,
  catalog,
  autoResume: true,
  openApplication: ({ sessionId, resume }) => AgentApplication.open({
    model,
    store,
    permissionPolicy,
    tools,
    instructions,
    sessionHistory: {},
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(resume ? { resume: true } : {}),
  }),
});
```
