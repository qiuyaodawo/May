# `@may/environment`

Execution environments for file operations, process execution and artifact export.
The local provider uses Windows AppContainer through the bundled landstrip native
runtime. Remote providers implement `EnvironmentProviderFactory.create()` and
`connect()` and return the same `EnvironmentProvider` interface.

Read the [English guide](../../docs/en/reference/environment.md) or
[简体中文指南](../../docs/zh-CN/reference/environment.md) for configuration, ownership,
limits, coding tool integration and the exact isolation boundary.

```ts
import { createLandstripEnvironment, createArtifactReference } from "@may/environment";

const environment = await createLandstripEnvironment({ workspace: process.cwd() });
try {
  await environment.writeFile("output.txt", "hello");
  const result = await environment.runProcess({ command: "node", args: ["--version"] });
  const artifact = createArtifactReference(environment.environmentId, "output.txt");
  await environment.exportArtifact(artifact, exportDestination);
} finally {
  await environment.close();
}
```

The caller owns the workspace and exported files. The environment owns its
temporary policy and runtime files. Commands inherit AppContainer restrictions,
including descendants. Standard mode can read platform-public resources; writes
use an explicit allow list. Writable roots cannot contain hard-linked files.

Local execution currently supports Windows only. Filesystem access, cancellation
and program startup are checked against the actual native runtime. Creation fails
when the requested configuration cannot run. CPU and memory quotas are unavailable.
