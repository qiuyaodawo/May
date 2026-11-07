import { createRequire } from "node:module";
const require = createRequire(new URL("./scripts/lint/package.json", import.meta.url));
const tseslint = require("typescript-eslint");

export default tseslint.config(
  { ignores: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/dist/**", "review/**", "tmp/**", "**/.test-output/**"] },
  {
    files: [
      "packages/*/src/**/*.ts",
      "packages/tools/*/src/**/*.ts",
      "packages/ui/*/src/**/*.ts",
      "apps/*/src/**/*.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
    },
  },
);
