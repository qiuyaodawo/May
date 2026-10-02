import { EnvironmentError } from "./errors.js";
import type { EnvironmentArtifactReference } from "./types.js";

/** 产物引用必须属于同一环境。 */
export function assertArtifactReference(
  reference: EnvironmentArtifactReference,
  environmentId: string,
): void {
  if (reference.kind !== "file") {
    throw new EnvironmentError(
      "ENVIRONMENT_ARTIFACT_MISMATCH",
      `unsupported artifact kind: ${String(reference.kind)}`,
    );
  }
  if (reference.environmentId !== environmentId) {
    throw new EnvironmentError(
      "ENVIRONMENT_ARTIFACT_MISMATCH",
      `artifact belongs to environment ${reference.environmentId}, not ${environmentId}`,
    );
  }
}