import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { Tool } from "./tool.js";

/** @experimental */
export type ToolSchema<I, O> = StandardSchemaV1<I, O> & StandardJSONSchemaV1<I, O>;

/** @experimental */
export type DefineToolOptions<I, O, R> = Omit<Tool<O, R>, "inputSchema" | "parse"> & {
  readonly schema: ToolSchema<I, O>;
};

/** @experimental */
export class ToolInputValidationError extends Error {
  constructor(readonly issues: readonly StandardSchemaV1.Issue[]) {
    super(
      issues
        .map(
          (issue) =>
            `${issue.path?.length ? issue.path.map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".") : "input"}: ${issue.message}`,
        )
        .join("; "),
    );
    this.name = "ToolInputValidationError";
  }
}

/** @public */
export function defineTool<I, O, R>(options: DefineToolOptions<I, O, R>): Tool<O, R> {
  const { schema, ...tool } = options;
  const inputSchema = schema["~standard"].jsonSchema.input({ target: "draft-07" });
  return {
    ...tool,
    inputSchema,
    async parse(input) {
      const result = await schema["~standard"].validate(input);
      if (result.issues) throw new ToolInputValidationError(result.issues);
      return result.value;
    },
  };
}
