import { EnvironmentError } from "./errors.js";
import type {
  EnvironmentArtifactReference,
  EnvironmentCapabilities,
  EnvironmentDescription,
  EnvironmentNetwork,
  EnvironmentReadScope,
} from "./types.js";

/** 远程可用的全部操作。 */
export const FULL_ENVIRONMENT_CAPABILITIES: EnvironmentCapabilities = {
  fileRead: true,
  fileWrite: true,
  directoryList: true,
  directoryCreate: true,
  directoryRemove: true,
  processExecute: true,
  processStream: true,
  processCancel: true,
  artifactRead: true,
  artifactExport: true,
};

/** 产物引用只能指向同一环境。 */
export function createArtifactReference(
  environmentId: string,
  path: string,
): EnvironmentArtifactReference {
  if (environmentId.trim() === "") {
    throw new EnvironmentError(
      "ENVIRONMENT_INVALID_OPTION",
      "environmentId must not be empty",
    );
  }
  if (path.trim() === "" || path === ".") {
    throw new EnvironmentError(
      "ENVIRONMENT_INVALID_PATH",
      "artifact path must not be empty",
    );
  }
  return { environmentId, path, kind: "file" };
}

export function formatArtifactReference(
  reference: EnvironmentArtifactReference,
): string {
  return `${reference.environmentId}:${reference.path}`;
}

/** 面向 Agent 的隔离说明文本。 */
export function renderIsolationSummary(isolation: {
  readonly workspace: string;
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
  readonly readScope: EnvironmentReadScope;
  readonly network: EnvironmentNetwork;
  readonly extraNotes?: readonly string[];
}): string {
  const readStatement =
    isolation.readScope === "allow-list"
      ? `only these paths can be read: ${isolation.readableRoots.join(", ")}`
      : isolation.readScope === "deny-list"
      ? "reads are limited by an explicit deny list"
      : "reads follow the isolation rules of the platform implementation";
  const lines = [
    `Every file operation and every command runs inside the isolated environment.`,
    `The workspace is ${isolation.workspace}.`,
    `Writes are limited to: ${isolation.writableRoots.join(", ")}.`,
    `Read policy: ${readStatement}.`,
    `Network access: ${describeNetwork(isolation.network)}.`,
  ];
  for (const note of isolation.extraNotes ?? []) lines.push(note);
  return lines.join(" ");
}

function describeNetwork(network: EnvironmentNetwork): string {
  if (network === "none") return "denied inside the environment";
  if (network === "host-configured") {
    return "inherited from the host configuration and not filtered by the environment";
  }
  return "limited to the destinations the environment allows";
}

/** 环境说明文本，追加到 Agent 指令中。 */
export function renderEnvironmentInstructions(
  description: EnvironmentDescription,
): string {
  const capabilities = Object.entries(description.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
  const limitations =
    description.limitations.length === 0
      ? "No additional limitation is known."
      : description.limitations.map((item) => `- ${item}`).join("\n");
  return [
    "# Execution environment",
    `You are working inside the isolated environment ${description.environmentId} (${description.displayName}).`,
    `Working directory: ${description.workingDirectory}`,
    `Capabilities: ${capabilities}`,
    `Verified programs: ${description.programs.join(", ")}`,
    `Limits: ${JSON.stringify(description.limits)}`,
    description.isolation.summary,
    "Limitations:",
    limitations,
  ].join("\n");
}
