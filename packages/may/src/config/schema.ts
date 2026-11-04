import { createRequire } from "node:module";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { MayConfigValidationError } from "./errors.js";

export type JsonSchemaObject = { readonly [key: string]: unknown };

const require = createRequire(import.meta.url);

/** JSON Schema of the May configuration file without application entries. */
export const mayConfigSchema = require("../../may-config.schema.json") as JsonSchemaObject;

/**
 * JSON Schema of the configuration file for one application.
 *
 * `section` describes the object at `apps.<id>`. Its `$defs` join the core
 * definitions, so the section may reference core definitions such as
 * `#/$defs/runBudget` and its own definitions with the same `#/$defs/` prefix.
 */
export function createApplicationConfigSchema(id: string, section: JsonSchemaObject, title: string): JsonSchemaObject {
  const {
    $defs: sectionDefinitions = {},
    $schema: _schema,
    ...root
  } = section as {
    readonly $defs?: Readonly<Record<string, unknown>>;
    readonly $schema?: unknown;
  };
  const coreDefinitions = mayConfigSchema.$defs as Readonly<Record<string, unknown>>;
  for (const name of [id, ...Object.keys(sectionDefinitions)]) {
    if (Object.hasOwn(coreDefinitions, name)) {
      throw new Error(`Application schema definition ${name} conflicts with a May configuration definition`);
    }
  }
  const properties = mayConfigSchema.properties as Readonly<Record<string, JsonSchemaObject>>;
  return {
    ...mayConfigSchema,
    title,
    properties: {
      ...properties,
      apps: { ...properties.apps, properties: { [id]: { $ref: `#/$defs/${id}` } } },
    },
    $defs: { ...coreDefinitions, ...sectionDefinitions, [id]: root },
  };
}

/** Compile a validator that returns the `apps.<id>` entry of a configuration file as `T`. */
export function createApplicationConfigValidator<T>(
  id: string,
  section: JsonSchemaObject,
): (value: unknown, path: string) => T {
  const schema = createApplicationConfigSchema(id, section, id);
  const validate = compile({ $defs: schema.$defs, $ref: `#/$defs/${id}` });
  return (value, path) => {
    assertValid(validate, value, path, `apps.${id}`);
    return value as T;
  };
}

export const validateMayConfigDocument: (value: unknown, path: string) => void = (() => {
  const validate = compile(mayConfigSchema);
  return (value: unknown, path: string) => assertValid(validate, value, path, "config");
})();

function compile(schema: JsonSchemaObject): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  formats.default(ajv);
  return ajv.compile(schema);
}

function assertValid(validate: ValidateFunction, value: unknown, path: string, root: string): void {
  if (validate(value)) return;
  throw validationError(mostSpecificError(validate.errors!), path, root);
}

/** Combinator errors only summarize their branches; report the deepest concrete error instead. */
const SUMMARY_KEYWORDS = new Set(["oneOf", "anyOf", "if", "const", "false schema"]);

function mostSpecificError(errors: readonly ErrorObject[]): ErrorObject {
  const depth = (error: ErrorObject) => error.instancePath.split("/").length;
  return errors.reduce((best, error) => {
    if (depth(error) !== depth(best)) return depth(error) > depth(best) ? error : best;
    return SUMMARY_KEYWORDS.has(best.keyword) && !SUMMARY_KEYWORDS.has(error.keyword) ? error : best;
  });
}

function validationError(error: ErrorObject, path: string, root: string): MayConfigValidationError {
  const segments = error.instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  const prefix = root === "config" ? segments : [root, ...segments];
  const location = prefix.length === 0 ? root : prefix.join(".");
  if (error.keyword === "additionalProperties") {
    return new MayConfigValidationError(
      path,
      `${location}.${String(error.params.additionalProperty)}`,
      "is not supported",
    );
  }
  if (error.keyword === "required") {
    return new MayConfigValidationError(
      path,
      [...prefix, String(error.params.missingProperty)].join("."),
      "is required",
    );
  }
  return new MayConfigValidationError(path, location, error.message!);
}
