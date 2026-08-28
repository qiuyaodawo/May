import type { ContextSnapshot, Message } from "@may/core";

import type { ContextInspection } from "./controller.js";

export interface ContextCompactionStrategy {
  readonly name: string;
  compact(
    snapshot: Readonly<ContextSnapshot>,
  ): readonly Message[] | Promise<readonly Message[]>;
}

export interface ContextCompactionResult {
  readonly strategy: string;
  readonly changed: boolean;
  readonly messages: readonly Message[];
  readonly before: ContextInspection;
  readonly after: ContextInspection;
}
