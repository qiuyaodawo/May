# Documentation maintenance rules

These instructions apply to `docs/` and all its subdirectories. Follow the
repository root `AGENTS.md` as well. This English instruction file governs both
`docs/en/` and `docs/zh-CN/`.

## Sources and scope

- Use the reader needs identified by Diátaxis to organize tutorials, how-to
  guides, reference documentation, and explanations.
- Use the Google Developer Documentation Style Guide and Microsoft Writing
  Style Guide for language, terminology, procedures, links, and formatting.
- Learn from Django's documentation categories and complete tutorials, React's
  concept teaching and small examples, and the Python standard library's API
  reference and version notes.
- ISO/IEC/IEEE 26514:2022 provides formal guidance on designing and maintaining
  information for software users. Verify applicable clauses and provide evidence
  before claiming compliance with a standard.
- Apply these sources through the rules below. Follow repository requirements
  for terminology, directory structure, verification, and language.

## Before editing

1. Inspect existing working-tree changes and reread the files you intend to edit.
2. Read relevant source, public exports, configuration declarations, and tests to
   establish actual behavior and package boundaries.
3. Find related concepts, guides, references, architecture documents, and package
   READMEs. Identify pages that need synchronized updates. Reuse established
   authoritative explanations through links.
4. Identify the intended reader, prerequisites, purpose, and task or understanding
   the document should enable.
5. Distinguish available features, design proposals, and future plans. Label the
   status of proposals and plans explicitly. Usage instructions must describe
   features supported by the current implementation.

## Document types and organization

Give each document a clear primary purpose. Use the existing directories and
organize content around reader needs. When moving files, update entry pages,
cross-references, and language mirrors together.

### Tutorials

- Guide beginners toward a complete, verifiable learning goal.
- Specify the environment, versions, dependencies, working directory, files to
  create or edit, and expected results.
- Introduce concepts in dependency and execution order. Each example should
  introduce only the knowledge needed for the current task.
- Provide checks at important steps so readers can confirm progress and locate
  common errors.
- Reach a runnable example promptly in a quick start. Link to separate pages for
  product shortcuts, development workflows, and detailed design explanations.

### How-to guides

- Name the specific task in the title, such as "Configure Session storage".
- Describe applicability, prerequisites, initial state, steps, completion criteria,
  and required cleanup.
- Put conditions before instructions. Use numbered lists for ordered operations.
- Explain alternative configurations only when readers need to choose. Provide
  applicable conditions and a complete executable procedure for each path.
- Organize troubleshooting around observable symptoms, checks, causes, and
  corrective actions.

### Reference documentation

- Follow the actual structure of packages, modules, types, methods, or
  configuration options so readers can locate information.
- As applicable, document import paths, parameters, types, required inputs,
  defaults, return values, errors, limits, and version requirements. Explain what
  happens when optional inputs are omitted.
- Check package `exports` when documenting public APIs. Check package and
  repository configuration when documenting environment requirements.
- Describe operating-system differences, compatibility, deprecation, and
  migration requirements. Identify applicable versions.
- Use short examples to clarify inputs and results. Link to detailed tutorials
  and design explanations.

### Concepts and architecture

- Explain meanings, responsibilities, relationships, and design reasons. Use
  concrete execution scenarios to help readers understand.
- Define project terminology on first use or link to its definition.
- Explain object lifecycles, resource ownership, state storage, and call boundaries.
- Keep architecture descriptions consistent with current code. Use Mermaid when
  a diagram is needed, and explain the relationships it represents.
- Follow the existing structure of architecture decision records to describe
  context, decisions, and consequences. Put procedures in related guides.

## Language and formatting

- Use familiar words, active voice, and complete descriptions of actions and
  objects. Make conditions and results explicit.
- Keep each paragraph focused on one topic. Use descriptive headings and parallel
  phrasing for comparable list items.
- State current behavior directly. Remove unrelated comparisons, editing history,
  repeated reminders, and explanations unrelated to the reader's task.
- Use consistent terminology for each concept. Preserve identifiers, commands,
  filenames, configuration keys, and established English technical names. Use
  natural Chinese for ordinary explanations in Chinese documents.
- Use sentence case for English headings. Preserve the original capitalization
  of proper names and identifiers.
- Format identifiers, paths, commands, and configuration values as code. Use bold
  for UI labels and match the actual interface text.
- Specify a language for fenced code blocks. Follow root instructions for the
  language of example comments.
- Use descriptive link text and prefer repository-relative links. Check the
  destination and anchor of each added link.
- Give images descriptive alternative text. Explain essential steps and
  conclusions in the surrounding prose.
- Associate warnings with specific operations. State triggering conditions,
  consequences, and required actions before the relevant operation.

## Examples and behavioral accuracy

- An example described as complete and runnable must include dependencies,
  imports, initialization, execution instructions, and resource cleanup.
- Explain the context and omissions of snippets. Do not describe an example with
  undefined objects as complete.
- Verify examples with actual APIs and dependencies. Do not use mocks or substitute
  behavior created solely to pass checks as evidence that a feature works. For
  external services, specify accounts, environment variables, and execution
  prerequisites. Never include credentials.
- When showing expected output, identify stable results and fields that may vary.
  Never fabricate execution records.
- For permissions, cancellation, concurrency, retries, recovery, and persistence,
  describe triggering conditions, state changes, error handling, and caller
  responsibilities. For side effects, explain idempotency or result verification.
- Distinguish process memory, durable history, live events, and UI projections.
  Explain behavior after recovery.
- When features or limits change, find and update related "Current limits"
  sections, defaults, and version requirements.
- Do not infer execution results from type declarations, the presence of an
  example, or test names. State available evidence and verification scope.

## Bilingual maintenance and navigation

- Keep user documentation under `docs/en/` and `docs/zh-CN/`, with matching relative
  paths and language-switch links.
- Update both languages together. Keep feature scope, defaults, limits, steps,
  examples, and links equivalent in meaning. Use natural phrasing in each language.
- When adding or moving pages, update entry pages and related cross-references in
  both languages.
- Keep these maintenance instructions at `docs/AGENTS.md`. The documentation
  checker permits this file at the documentation root.

## Verification and delivery

1. Run `pnpm docs:check` using the pnpm version declared in the root `package.json`.
2. Manually review heading structure, language consistency, code fences, link
   anchors, and factual evidence for changed pages. The current checker verifies
   language pairs, language links, local destination files, and paired code fences.
   Verify translation meaning, anchors, external links, and example execution
   separately.
3. When changing commands, configuration, or code examples, run relevant examples
   and focused checks. Type-check TypeScript examples. If the environment prevents
   verification, report checks that were not run and why. Do not claim they passed.
4. Review the final change scope and whitespace errors. Exclude unrelated changes.
5. Report changed files, commands run, results, and important verification gaps.
   Documentation maintenance instructions usually need no changeset. Follow root
   changeset rules when changes affect consumer behavior or published contents.
6. Obtain explicit user confirmation before every Git commit. Commit, push, and
   publish require separate authorization.
