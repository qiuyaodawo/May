# Execution environments

**English** | [简体中文](../../zh-CN/reference/environment.md)

`@may/environment` provides one access interface for files, processes and artifacts.
The workspace identifies task files. The environment supplies the operating-system
identity, access policy, programs, limits and lifecycle used to work with those files.
The host selects and owns the environment; coding tools receive that instance.

## Local configuration

`createLandstripEnvironment()` supports Windows through landstrip's AppContainer
runtime, bundled by `@landstrip/landstrip-api`. It operates on an existing workspace.
Creation checks the native runtime, policies, required programs and actual binary
file operations. Any failed check rejects creation and releases its resources.

```ts
import {
  createLandstripEnvironment,
  createArtifactReference,
  renderEnvironmentInstructions,
} from "@may/environment";
import { createCodingTools, createPowerShellProfile } from "@may/coding-tools";

const environment = await createLandstripEnvironment({
  workspace: process.cwd(),
  requiredPrograms: [{ program: "node", expectedOutput: "v" }],
  network: "none",
});
try {
  const description = await environment.describe();
  const tools = createCodingTools({
    cwd: description.workingDirectory,
    environment,
    shell: { profile: createPowerShellProfile({ executable: "powershell.exe" }) },
  });
  const instructions = renderEnvironmentInstructions(description);
  // 将 tools 和 instructions 提供给应用已有的 Agent 组合。
  await environment.writeFile("result.bin", new Uint8Array([0, 128, 255]));
  const reference = createArtifactReference(environment.environmentId, "result.bin");
  await environment.exportArtifact(reference, absoluteHostDestination);
} finally {
  await environment.close();
}
```

| Option | Behavior |
| --- | --- |
| `workspace` | Existing host directory used by file operations and default command cwd |
| `readablePaths` | Additional existing paths granted read access |
| `writablePaths` | Existing writable roots; defaults to the workspace and must contain it |
| `deniedReadPaths`, `deniedWritePaths` | Existing paths explicitly denied by the native policy |
| `environment` | Explicit program environment variables |
| `requiredPrograms` | Program/argument/output requirements checked during creation |
| `network` | `none` by default; `allow` grants network capability subject to host policy |
| `appContainerMode` | `standard` by default; `lpac` requests restricted package access and must pass startup checks |
| `limits` | Process concurrency, captured output, process timeout and file byte limits |
| `signal` | Cancellation during creation |
| `displayName` | Name reported to the host and Agent |
| `binary` | Host-managed native landstrip executable; defaults to the bundled binary |

Default limits are 16 concurrent isolated processes, 1 MiB captured output per
channel, 120 seconds per process and 16 MiB per file. File operations start isolated
processes and share the concurrency and timeout limits. CPU and memory quotas are
unavailable. Output events carry raw bytes and incrementally decoded UTF-8 text;
results report retained bytes, actual byte counts and truncation separately.

The environment inherits only selected Windows startup variables. Its PATH includes
the protected Node runtime and Windows command directories. Additional programs
require suitable read grants and an explicit PATH or executable path; verify them
with `requiredPrograms`. Host credentials and other environment variables require
explicit host configuration. `describe()` reports capabilities, verified programs,
limits, isolation and ownership without including variable values.

## Isolation and lifecycle

Every file helper, command and descendant runs under AppContainer restrictions.
Writes are granted to the configured roots. Standard mode also permits reading
resources accessible to Windows AppContainers, including some public system files
and ancestor directory listings. Its reported `readScope` is `platform-default`.
LPAC requests an allow-list read policy; availability depends on the requested
programs and Windows installation and is checked during creation.

File APIs accept paths within the workspace and reject links resolving outside it.
Recursive listings report links without entering their targets. Command access
follows the native policy, including additional configured roots. Writable roots
are inspected before each isolated launch and cannot contain hard-linked files.
Hosts must keep granted roots and runtime files under trusted ownership while an
environment is open, including preventing concurrent external changes to links.
Choose a dedicated task directory when granting access to untrusted task content.

Each environment owns a private policy directory and a read-only runtime directory.
Agent programs cannot modify the launcher or policy. The launcher starts requested
executables inside AppContainer, so an executable's supplementary NTFS policy stream
cannot expand the host's configured policy. Node's default flags preserve symlinks
for module loading because ancestor metadata may be inaccessible. Set
`nodePreserveSymlinks: false` to supply your own Node startup settings.
Node child processes should use inherited stdio; creating new IPC or pipe resources
can require capabilities unavailable in a selected AppContainer configuration.

`startProcess()` returns a handle with output/status subscriptions, result and cancel.
`runProcess()` waits for its result. Timeout and cancellation terminate descendants
and report confirmation; their errors preserve captured output. `close()` is
idempotent, stops active work and removes environment-owned resources. Unconfirmed
termination rejects cleanup. The host workspace and exported files are preserved.
The host is responsible for closing environments, including after task failures.

## Deliverables and effects

File changes already exist in the configured local workspace. Artifact references
identify an environment and relative file path. `readArtifact()` returns bytes;
`exportArtifact()` writes them to an absolute host destination. Export destinations
belong to the host and require explicit overwrite permission. Keep export calls in
the host's result-handling code.

For tasks producing an effect, record the command result and verify the affected
resource with a subsequent read or the relevant service API. An exit code reports
process completion; the resource observation establishes where the effect occurred.

## Coding tools and remote providers

`createCodingTools({ cwd, environment, shell: { profile } })` routes all four tools
through the same provider. `cwd` must equal its working directory. Individual tool
factories also accept `environment`; shell requires an explicit profile. Environment
shells retain provider startup variables and add explicit tool variables. A host can
explicitly enable host-variable inheritance through `inheritEnv`. File guards execute
`operation.run()` and record its returned content; `workspaceFileKey()` includes
environment identity and uses the environment's platform for case handling.
Environment file-tool paths are reported after resolving links inside the workspace.
Instruction loading and change previews retain their independent host interfaces.

Remote implementations supply `EnvironmentProviderFactory<TOptions>`:

- `create(options, context)` creates a remote environment;
- `connect(connection, context)` attaches to an existing environment;
- both return `EnvironmentProvider` with the same file/process/artifact operations;
- `EnvironmentConnection` carries endpoint, environment identity, remote working
  directory and a host-managed credential reference;
- `description.connection` exposes endpoint and credential kind, without credentials.

The package defines these interfaces. A concrete remote transport and server are
provided by the integrating application. Remote implementations own enforcement,
cancellation, artifact transfer and cleanup and must report their supported limits
and ownership. Providers may support platforms beyond the local Windows provider.
