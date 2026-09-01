export interface KeyStroke {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  /** Printable text represented by this key, when available. */
  readonly text?: string;
}

export interface KeyBindingDefinition {
  readonly context: string;
  readonly keys: string;
  readonly action: string;
}

export interface KeymapOptions {
  readonly leader?: string;
  readonly chordTimeoutMs?: number;
  /** Reject bindings which refer to actions outside this registry. */
  readonly actions?: readonly string[];
}

export type KeymapResult =
  | { readonly type: "action"; readonly action: string }
  | {
      readonly type: "pending";
      readonly completions: readonly string[];
    }
  | { readonly type: "unmatched" };

interface CompiledBinding extends KeyBindingDefinition {
  readonly sequence: readonly KeyStroke[];
}

interface PendingSequence {
  readonly sequence: readonly KeyStroke[];
  readonly expiresAt: number;
}

export class Keymap {
  private readonly bindings: readonly CompiledBinding[];
  private readonly chordTimeoutMs: number;
  private pending: PendingSequence | undefined;

  constructor(
    definitions: readonly KeyBindingDefinition[],
    options: KeymapOptions = {},
  ) {
    const chordTimeoutMs = options.chordTimeoutMs ?? 1_000;
    if (!Number.isFinite(chordTimeoutMs) || chordTimeoutMs <= 0) {
      throw new RangeError("chordTimeoutMs must be a positive finite number");
    }
    const actions = options.actions === undefined
      ? undefined
      : new Set(options.actions);
    const leader = options.leader ?? "ctrl+x";
    this.bindings = definitions.map((definition) => {
      if (definition.context.trim() === "") {
        throw new Error("Keybinding context cannot be empty");
      }
      if (definition.action.trim() === "") {
        throw new Error("Keybinding action cannot be empty");
      }
      if (actions !== undefined && !actions.has(definition.action)) {
        throw new Error(`Unknown keybinding action: ${definition.action}`);
      }
      return {
        ...definition,
        sequence: parseKeySequence(definition.keys, { leader }),
      };
    });
    validateBindings(this.bindings);
    this.chordTimeoutMs = chordTimeoutMs;
  }

  resolve(
    stroke: KeyStroke,
    contexts: readonly string[],
    now = Date.now(),
  ): KeymapResult {
    const normalized = normalizeKeyStroke(stroke);
    const previous = this.pending !== undefined && this.pending.expiresAt > now
      ? this.pending.sequence
      : [];
    this.pending = undefined;
    const sequence = [...previous, normalized];
    const result = this.resolveSequence(sequence, contexts, now);
    if (result.type !== "unmatched" || previous.length === 0) return result;
    return this.resolveSequence([normalized], contexts, now);
  }

  reset(): void {
    this.pending = undefined;
  }

  private resolveSequence(
    sequence: readonly KeyStroke[],
    contexts: readonly string[],
    now: number,
  ): KeymapResult {
    for (let index = contexts.length - 1; index >= 0; index--) {
      const context = contexts[index]!;
      const candidates = this.bindings.filter((binding) =>
        binding.context === context && isPrefix(sequence, binding.sequence)
      );
      if (candidates.length === 0) continue;

      const exact = candidates.find((binding) =>
        binding.sequence.length === sequence.length
      );
      if (exact !== undefined) {
        return { type: "action", action: exact.action };
      }

      this.pending = {
        sequence: [...sequence],
        expiresAt: now + this.chordTimeoutMs,
      };
      return {
        type: "pending",
        completions: candidates.map((binding) =>
          formatKeySequence(binding.sequence.slice(sequence.length))
        ),
      };
    }
    return { type: "unmatched" };
  }
}

export function keyStroke(
  key: string,
  modifiers: Partial<Omit<KeyStroke, "key">> = {},
): KeyStroke {
  return normalizeKeyStroke({
    key,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false,
    meta: modifiers.meta ?? false,
    ...(modifiers.text === undefined ? {} : { text: modifiers.text }),
  });
}

export function normalizeKeyStroke(stroke: KeyStroke): KeyStroke {
  const text = stroke.text;
  return {
    key: normalizeKeyName(stroke.key),
    ctrl: stroke.ctrl,
    alt: stroke.alt,
    shift: stroke.shift,
    meta: stroke.meta,
    ...(text === undefined ? {} : { text }),
  };
}

export function parseKeySequence(
  source: string,
  options: { readonly leader?: string } = {},
): readonly KeyStroke[] {
  const tokens = source.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) throw new Error("Key sequence cannot be empty");
  const result: KeyStroke[] = [];
  for (const token of tokens) {
    if (token.toLowerCase() === "<leader>") {
      const leader = options.leader ?? "ctrl+x";
      if (leader.toLowerCase().includes("<leader>")) {
        throw new Error("Leader cannot refer to itself");
      }
      result.push(...parseKeySequence(leader));
    } else {
      result.push(parseKeyToken(token));
    }
  }
  return result;
}

export function formatKeySequence(sequence: readonly KeyStroke[]): string {
  return sequence.map(formatKeyStroke).join(" ");
}

export function formatKeyStroke(stroke: KeyStroke): string {
  return [
    ...(stroke.ctrl ? ["ctrl"] : []),
    ...(stroke.alt ? ["alt"] : []),
    ...(stroke.shift ? ["shift"] : []),
    ...(stroke.meta ? ["meta"] : []),
    normalizeKeyName(stroke.key),
  ].join("+");
}

function parseKeyToken(token: string): KeyStroke {
  const parts = token.toLowerCase().split("+");
  const key = parts.pop();
  if (key === undefined || key === "") {
    throw new Error(`Invalid keybinding token: ${token}`);
  }
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (const modifier of parts) {
    switch (modifier) {
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      case "meta":
      case "cmd":
      case "command":
        meta = true;
        break;
      default:
        throw new Error(`Unknown key modifier "${modifier}" in ${token}`);
    }
  }
  return { key: normalizeKeyName(key), ctrl, alt, shift, meta };
}

function normalizeKeyName(key: string): string {
  const normalized = key.toLowerCase();
  switch (normalized) {
    case "return":
      return "enter";
    case "esc":
      return "escape";
    case "pgup":
      return "pageup";
    case "pgdn":
      return "pagedown";
    case " ":
      return "space";
    default:
      return normalized;
  }
}

function validateBindings(bindings: readonly CompiledBinding[]): void {
  for (let leftIndex = 0; leftIndex < bindings.length; leftIndex++) {
    const left = bindings[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < bindings.length; rightIndex++) {
      const right = bindings[rightIndex]!;
      if (left.context !== right.context) continue;
      if (sameSequence(left.sequence, right.sequence)) {
        throw new Error(
          `Duplicate keybinding in ${left.context}: ${left.keys}`,
        );
      }
      if (
        isPrefix(left.sequence, right.sequence) ||
        isPrefix(right.sequence, left.sequence)
      ) {
        throw new Error(
          `Ambiguous keybinding prefix in ${left.context}: ` +
            `${left.keys} and ${right.keys}`,
        );
      }
    }
  }
}

function sameSequence(
  left: readonly KeyStroke[],
  right: readonly KeyStroke[],
): boolean {
  return left.length === right.length && isPrefix(left, right);
}

function isPrefix(
  prefix: readonly KeyStroke[],
  value: readonly KeyStroke[],
): boolean {
  return prefix.length <= value.length && prefix.every((stroke, index) =>
    sameStroke(stroke, value[index]!)
  );
}

function sameStroke(left: KeyStroke, right: KeyStroke): boolean {
  return left.key === right.key &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta;
}
