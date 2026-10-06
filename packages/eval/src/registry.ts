import type { ComponentReference, EvalComponent, EvalEnvironmentAdapter, EvalEvaluator, EvalExecutionAdapter } from "./types.js";

export class EvalRegistry {
  private readonly environments = new Map<string, EvalEnvironmentAdapter>();
  private readonly executions = new Map<string, EvalExecutionAdapter>();
  private readonly evaluators = new Map<string, EvalEvaluator>();

  registerEnvironment(adapter: EvalEnvironmentAdapter): this { this.register(this.environments, adapter); return this; }
  registerExecution(adapter: EvalExecutionAdapter): this { this.register(this.executions, adapter); return this; }
  registerEvaluator(evaluator: EvalEvaluator): this { this.register(this.evaluators, evaluator); return this; }
  environment(reference: ComponentReference): EvalEnvironmentAdapter { return this.resolve(this.environments, reference, "environment"); }
  execution(reference: ComponentReference): EvalExecutionAdapter { return this.resolve(this.executions, reference, "execution"); }
  evaluator(reference: ComponentReference): EvalEvaluator { return this.resolve(this.evaluators, reference, "evaluator"); }

  private register<T extends EvalComponent>(map: Map<string, T>, component: T): void {
    if (!component.id || !component.version) throw new TypeError("Component id and version are required");
    const key = `${component.id}@${component.version}`;
    if (map.has(key)) throw new Error(`Component already registered: ${key}`);
    map.set(key, component);
  }
  private resolve<T extends EvalComponent>(map: Map<string, T>, reference: ComponentReference, kind: string): T {
    const component = map.get(`${reference.id}@${reference.version}`);
    if (component === undefined) throw new Error(`Unknown ${kind}: ${reference.id}@${reference.version}`);
    component.validate?.(reference.options ?? {});
    return component;
  }
}
