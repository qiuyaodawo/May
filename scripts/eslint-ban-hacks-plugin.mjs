import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "eslint-ban-hacks-baseline.json");

function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function relPath(filename) {
  return path.relative(ROOT, filename).split(path.sep).join("/");
}

function normalizeExpr(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function previewExpr(text) {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * Create a statement-scoped multiset rule: every occurrence must match an exact
 * normalized legacy snippet for that file, and every baselined snippet must still appear
 * (forcing the baseline to shrink as legacy sites are removed).
 */
function createSnippetBudgetRule({ key, selector, message, extractNode = (node) => node }) {
  return {
    meta: { type: "problem", schema: [] },
    create(context) {
      const baseline = loadBaseline();
      const file = relPath(context.filename);
      const allowedList = baseline[key]?.[file] ?? [];
      const remaining = new Map();
      for (const sig of allowedList) {
        remaining.set(sig, (remaining.get(sig) ?? 0) + 1);
      }

      return {
        [selector](node) {
          const target = extractNode(node);
          const sig = normalizeExpr(context.sourceCode.getText(target));
          const left = remaining.get(sig) ?? 0;
          if (left > 0) {
            if (left === 1) remaining.delete(sig);
            else remaining.set(sig, left - 1);
            return;
          }
          context.report({ node, message });
        },
        "Program:exit"(programNode) {
          for (const [sig, count] of remaining.entries()) {
            context.report({
              node: programNode,
              message: `Stale baseline entry in scripts/eslint-ban-hacks-baseline.json (${key}["${file}"], ${count}x): "${previewExpr(sig)}" no longer exists. Remove it from the baseline.`,
            });
          }
        },
      };
    },
  };
}

/**
 * Exact per-file count budget rule for legacy non-null assertions (`!`):
 * new `!` in ANY file (including baselined files) fails immediately;
 * removing a `!` fails until the baseline count is lowered.
 */
function createCountBudgetRule({ key, selector, message }) {
  return {
    meta: { type: "problem", schema: [] },
    create(context) {
      const baseline = loadBaseline();
      const file = relPath(context.filename);
      const budget = baseline[key]?.[file] ?? 0;
      let seen = 0;

      return {
        [selector](node) {
          seen += 1;
          if (seen > budget) {
            context.report({
              node,
              message: budget > 0 ? `${message} (File "${file}" exceeds frozen legacy budget ${budget}.)` : message,
            });
          }
        },
        "Program:exit"(programNode) {
          if (seen < budget) {
            context.report({
              node: programNode,
              message: `Stale baseline budget in scripts/eslint-ban-hacks-baseline.json (${key}["${file}"] is ${budget}, actual is ${seen}). Lower or remove the entry.`,
            });
          }
        },
      };
    },
  };
}

/** Validate that every file referenced in the baseline still exists on disk. */
export function validateBanHacksBaselineFiles() {
  const baseline = loadBaseline();
  const missing = [];
  for (const key of ["asUnknownAs", "nonNullAssertion", "testPromiseSetTimeout"]) {
    const map = baseline[key] ?? {};
    for (const file of Object.keys(map)) {
      if (!existsSync(path.join(ROOT, file))) missing.push(`${key}:${file}`);
    }
  }
  return missing;
}

export const banHacksPlugin = {
  rules: {
    "no-double-cast": createSnippetBudgetRule({
      key: "asUnknownAs",
      selector: 'TSAsExpression > TSAsExpression[typeAnnotation.type="TSUnknownKeyword"]',
      extractNode: (node) => node.parent,
      message:
        'Avoid double cast "as unknown as T". Narrow with a runtime type guard/validation helper, or isolate unavoidable runtime shims in a dedicated compat module.',
    }),
    "no-non-null-assertion": createCountBudgetRule({
      key: "nonNullAssertion",
      selector: "TSNonNullExpression",
      message:
        'Avoid non-null assertion "!". Narrow with an explicit undefined check or helper instead of bypassing strict null checks.',
    }),
    "no-test-promise-settimeout": createSnippetBudgetRule({
      key: "testPromiseSetTimeout",
      selector:
        ':matches(NewExpression[callee.name="Promise"] CallExpression[callee.name="setTimeout"], NewExpression[callee.name="Promise"] CallExpression[callee.property.name="setTimeout"])',
      extractNode(node) {
        let cur = node.parent;
        while (cur && !(cur.type === "NewExpression" && cur.callee?.name === "Promise")) cur = cur.parent;
        return cur ?? node;
      },
      message:
        'Avoid imperative setTimeout sleeps inside Promises in tests. Wait on real events or use until(t, probe) from "@sortedyuan/test-support" (or node:timers/promises setTimeout with { signal: t.signal }).',
    }),
  },
};
