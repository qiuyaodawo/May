import { May } from "./may.js";
import type { RuntimeFactory } from "./runtime.js";

/** @experimental */
export const defaultRuntimeFactory: RuntimeFactory = (options) => new May(options);
