export interface PersistentPermissionRule {
  readonly id: string;
  readonly scopeId: string;
  readonly toolName: string;
  readonly definitionKey: string;
  readonly grantKey: string;
  readonly description: string;
  readonly decision: "allow" | "deny";
  readonly createdAt: number;
  readonly createdBy: string;
  readonly expiresAt?: number;
}

export interface PermissionRuleStore {
  list(scopeId?: string): Promise<readonly PersistentPermissionRule[]>;
  create(rule: PersistentPermissionRule): Promise<void>;
  revoke(id: string): Promise<boolean>;
}

const requiredFields = [
  "id", "scopeId", "toolName", "definitionKey", "grantKey", "description",
  "decision", "createdAt", "createdBy",
] as const;
const allowedFields: readonly string[] = [...requiredFields, "expiresAt"];

export function validateRuleIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a nonempty string`);
  }
}

export function copyPermissionRule(value: unknown): PersistentPermissionRule {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Permission rule must be a plain object");
  }
  const rule = value as Record<string, unknown>;
  if (Reflect.ownKeys(rule).some((field) => typeof field !== "string" || !allowedFields.includes(field)) ||
      requiredFields.some((field) => !Object.hasOwn(rule, field)) ||
      Object.values(Object.getOwnPropertyDescriptors(rule)).some((field) => !("value" in field))) {
    throw new TypeError("Permission rule has invalid fields");
  }
  for (const field of ["id", "scopeId", "toolName", "definitionKey", "grantKey", "description", "createdBy"] as const) {
    validateRuleIdentifier(rule[field], field);
  }
  if (rule.decision !== "allow" && rule.decision !== "deny") {
    throw new TypeError("Permission rule decision must be allow or deny");
  }
  for (const field of ["createdAt", "expiresAt"] as const) {
    if (field === "expiresAt" && !Object.hasOwn(rule, field)) continue;
    if (!Number.isSafeInteger(rule[field]) || Number(rule[field]) < 0) {
      throw new TypeError(`${field} must be a nonnegative safe integer`);
    }
  }
  return Object.freeze({
    id: rule.id as string,
    scopeId: rule.scopeId as string,
    toolName: rule.toolName as string,
    definitionKey: rule.definitionKey as string,
    grantKey: rule.grantKey as string,
    description: rule.description as string,
    decision: rule.decision,
    createdAt: rule.createdAt as number,
    createdBy: rule.createdBy as string,
    ...(Object.hasOwn(rule, "expiresAt") ? { expiresAt: rule.expiresAt as number } : {}),
  });
}

export class InMemoryPermissionRuleStore implements PermissionRuleStore {
  private readonly rules = new Map<string, PersistentPermissionRule>();

  async list(scopeId?: string): Promise<readonly PersistentPermissionRule[]> {
    if (scopeId !== undefined) validateRuleIdentifier(scopeId, "scopeId");
    return Object.freeze([...this.rules.values()]
      .filter((rule) => scopeId === undefined || rule.scopeId === scopeId)
      .map(copyPermissionRule));
  }

  async create(rule: PersistentPermissionRule): Promise<void> {
    const next = copyPermissionRule(rule);
    if (this.rules.has(next.id)) throw new Error(`Permission rule already exists: ${next.id}`);
    this.rules.set(next.id, next);
  }

  async revoke(id: string): Promise<boolean> {
    validateRuleIdentifier(id, "id");
    return this.rules.delete(id);
  }
}
