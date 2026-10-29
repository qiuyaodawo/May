import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { ModelResponseValidationError, type ModelResponseReceipt } from "./errors.js";
import type { ModelRequest } from "./model.js";
import type { AssistantMessage, JsonSchema } from "./types.js";

const validators = new Map<string, ValidateFunction>();

export function modelSchemaDialect(schema: JsonSchema): "draft-07" | "2020-12" {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new TypeError("Model schema must be a JSON Schema object");
  const dialect = schema.$schema;
  if (dialect === undefined || dialect === "http://json-schema.org/draft-07/schema#" || dialect === "https://json-schema.org/draft-07/schema") return "draft-07";
  if (dialect === "https://json-schema.org/draft/2020-12/schema") return "2020-12";
  throw new TypeError("Supported schema dialects are draft-07 and 2020-12");
}

export function compileModelSchema(schema: JsonSchema): ValidateFunction {
  const dialect = modelSchemaDialect(schema);
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached !== undefined) { validators.delete(key); validators.set(key, cached); return cached; }
  if (schema.$async === true) throw new TypeError("Model validation requires synchronous JSON Schema");
  const options = { allErrors: true, strict: true, strictTypes: false, strictRequired: false, addUsedSchema: false };
  const ajv = dialect === "2020-12" ? new Ajv2020(options) : new Ajv(options);
  formats.default(ajv);
  const validator = ajv.compile(schema);
  validators.set(key, validator);
  while (validators.size > 64) validators.delete(validators.keys().next().value!);
  return validator;
}

export function assertModelResponseFormat(request: ModelRequest): void {
  const format = request.responseFormat;
  if (format === undefined) return;
  if (typeof format !== "object" || format === null || (format.type !== "json" && format.type !== "jsonSchema")) throw new TypeError("responseFormat must be a JSON or JSON Schema response format");
  if (format.type === "json") return;
  if (typeof format.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(format.name)) throw new TypeError("Schema name must contain 1 through 64 letters, digits, underscores, or hyphens");
  if (format.strict !== undefined && typeof format.strict !== "boolean") throw new TypeError("responseFormat.strict must be a boolean");
  compileModelSchema(format.schema);
}

export function validateStructuredModelResponse(message: AssistantMessage, request: ModelRequest, receipt: ModelResponseReceipt = {}): unknown {
  const format = request.responseFormat;
  if (format === undefined || (message.toolCalls?.length ?? 0) > 0) return undefined;
  if (message.content.some((part) => part.type !== "text" && part.type !== "json" && part.type !== "reasoning")) throw new ModelResponseValidationError("Structured response contains unsupported content", receipt);
  const jsonParts = message.content.filter((part) => part.type === "json");
  const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  if (jsonParts.length > 1 || (jsonParts.length === 1 && text.trim() !== "")) throw new ModelResponseValidationError("Structured response must contain one JSON value", receipt);
  let value: unknown;
  if (jsonParts.length === 1) value = jsonParts[0]!.value;
  else {
    try { value = JSON.parse(text); }
    catch { throw new ModelResponseValidationError("Structured response contains invalid JSON", receipt); }
  }
  if (format.type === "jsonSchema" && !compileModelSchema(format.schema)(value)) throw new ModelResponseValidationError("Structured response does not satisfy responseFormat.schema", receipt);
  return value;
}
