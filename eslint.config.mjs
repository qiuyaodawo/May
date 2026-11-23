import { createRequire } from "node:module";
import { banHacksPlugin } from "./scripts/eslint-ban-hacks-plugin.mjs";

const require = createRequire(new URL("./scripts/lint/package.json", import.meta.url));
const tseslint = require("typescript-eslint");

const ENOENT_RESTRICTIONS = [
  {
    selector: 'BinaryExpression[operator=/^(===|!==|==|!=)$/][right.value="ENOENT"]',
    message:
      'Do not compare error.code directly to "ENOENT". Use hasErrorCode(error, "ENOENT") from "@sortedyuan/may/storage" (or isMissingPathError in coding-tools).',
  },
  {
    selector: 'BinaryExpression[operator=/^(===|!==|==|!=)$/][left.value="ENOENT"]',
    message:
      'Do not compare error.code directly to "ENOENT". Use hasErrorCode(error, "ENOENT") from "@sortedyuan/may/storage" (or isMissingPathError in coding-tools).',
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/*.js",
      "**/*.cjs",
      "**/dist/**",
      "review/**",
      "tmp/**",
      "**/.test-output/**",
      "eslint.config.mjs",
      "scripts/**",
      "examples/**",
      "packages/test-support/**",
      "packages/gateway/examples/**",
    ],
  },
  {
    files: [
      "packages/*/src/**/*.ts",
      "packages/tools/*/src/**/*.ts",
      "packages/ui/*/src/**/*.ts",
      "apps/*/src/**/*.ts",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "may-ban-hacks": banHacksPlugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 8,
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-restricted-syntax": ["error", ...ENOENT_RESTRICTIONS],
      "may-ban-hacks/no-double-cast": "error",
      "may-ban-hacks/no-non-null-assertion": "error",
    },
  },
  {
    files: [
      "packages/*/test/**/*.mjs",
      "packages/tools/*/test/**/*.mjs",
      "packages/ui/*/test/**/*.mjs",
      "apps/*/test/**/*.mjs",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "may-ban-hacks": banHacksPlugin,
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "may-ban-hacks/no-test-promise-settimeout": "error",
    },
  },
);
