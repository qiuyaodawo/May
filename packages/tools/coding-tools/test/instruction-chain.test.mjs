import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CodingInstructionsError,
  formatCodingProjectInstructions,
  loadCodingInstructions,
} from "../dist/instructions.js";

test("项目规则从最近 Git 根目录组合到启动目录", async (t) => {
  const root = await fixture(t);
  const repository = join(root, "repository");
  const packages = join(repository, "packages");
  const workspace = join(packages, "web");
  await mkdir(join(repository, ".git"), { recursive: true });
  await document(root, "AGENTS.md", "Outside project guidance.");
  const paths = [
    await document(repository, "AGENTS.md", "Use pnpm."),
    await document(packages, "AGENTS.md", "Keep package dependencies explicit."),
    await document(workspace, "AGENTS.md", "Verify browser behavior."),
  ];
  await document(join(packages, "api"), "AGENTS.md", "Sibling guidance.");
  await document(join(workspace, "src"), "AGENTS.md", "Descendant guidance.");

  const loaded = await load(workspace);

  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), paths);
  assert.deepEqual(loaded.projects.map((entry) => entry.content), [
    "Use pnpm.", "Keep package dependencies explicit.", "Verify browser behavior.",
  ]);
  assert.strictEqual(loaded.project, loaded.projects[2]);
  assert.doesNotMatch(loaded.effective, /Outside project|Sibling guidance|Descendant guidance/u);
  assert.match(loaded.effective, /Each document applies to its directory and descendants\./u);
  assert.match(loaded.effective, /deeper directory takes precedence/u);
  for (const path of paths) {
    assert.ok(loaded.effective.includes(`Source: ${path}\nScope: ${dirname(path)}\n\n`));
  }
});

test("从项目根目录启动只提供根目录规则", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  const path = await document(root, "AGENTS.md", "Root guidance.");
  await document(join(root, "child"), "AGENTS.md", "Child guidance.");

  const loaded = await load(root);

  assert.equal(loaded.projects.length, 1);
  assert.equal(loaded.project.source.path, path);
  assert.equal(loaded.effective, `System\n\n# Project instructions\n\nSource: ${path}\n\nRoot guidance.`);
  assert.equal(formatCodingProjectInstructions(loaded.projects), loaded.effective.slice("System\n\n".length));
  assert.doesNotMatch(loaded.effective, /Scope:|Child guidance/u);
});

test("最近嵌套 Git 标记限制规则搜索范围", async (t) => {
  const root = await fixture(t);
  const nested = join(root, "nested");
  const workspace = join(nested, "src");
  await mkdir(join(root, ".git"));
  await mkdir(join(nested, ".git"), { recursive: true });
  await document(root, "AGENTS.md", "Outer repository guidance.");
  const nestedPath = await document(nested, "AGENTS.md", "Nested repository guidance.");
  const workspacePath = await document(workspace, "AGENTS.md", "Source guidance.");

  const loaded = await load(workspace);

  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), [nestedPath, workspacePath]);
  assert.doesNotMatch(loaded.effective, /Outer repository guidance/u);
});

test("worktree 的 Git 标记文件可以确定项目根目录", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "src");
  await document(root, ".git", "gitdir: ../main/.git/worktrees/example\n");
  const rootPath = await document(root, "AGENTS.md", "Worktree guidance.");
  await mkdir(workspace);

  const loaded = await load(workspace);

  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), [rootPath]);
  assert.equal(loaded.project.content, "Worktree guidance.");
});

test("缺失项目标记时只读取启动目录规则", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "child");
  await document(root, "AGENTS.md", "Parent guidance.");
  const path = await document(workspace, "AGENTS.md", "Local guidance.");

  const loaded = await load(workspace, { projectRootMarkers: ["absent-instruction-chain-marker"] });

  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), [path]);
  assert.doesNotMatch(loaded.effective, /Parent guidance/u);
});

test("空标记列表只读取启动目录且没有规则时返回空列表", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "child");
  await mkdir(join(root, ".git"));
  await document(root, "AGENTS.md", "Parent guidance.");
  await mkdir(workspace);

  const absent = await load(workspace, { projectRootMarkers: [] });
  assert.deepEqual(absent.projects, []);
  assert.equal(absent.project, undefined);
  assert.equal(absent.effective, "System");
  assert.equal(formatCodingProjectInstructions(absent.projects), "");

  const path = await document(workspace, "AGENTS.md", "Local guidance.");
  const loaded = await load(workspace, { projectRootMarkers: [] });
  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), [path]);
});

test("每个目录优先选择非空 override 并跳过空文档", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "child");
  await mkdir(join(root, ".git"));
  const rootPath = await document(root, "AGENTS.override.md", "Root override.");
  await document(root, "AGENTS.md", "Root ordinary guidance.");
  await document(root, "PROJECT.md", "Root fallback guidance.");
  await document(workspace, "AGENTS.override.md", " \r\n\t");
  const workspacePath = await document(workspace, "AGENTS.md", "Child ordinary guidance.");
  await document(workspace, "PROJECT.md", "Child fallback guidance.");

  const loaded = await load(workspace, { projectInstructionsFallbackFilenames: ["PROJECT.md"] });

  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), [rootPath, workspacePath]);
  assert.doesNotMatch(loaded.effective, /Root ordinary|fallback guidance/u);
});

test("fallback 按配置顺序选择非空文档并去除重复名称", async (t) => {
  const root = await fixture(t);
  await document(root, "AGENTS.override.md", "\n");
  await document(root, "AGENTS.md", "\t");
  await document(root, "EMPTY.md", " ");
  const path = await document(root, "FIRST.md", "First fallback guidance.");
  await document(root, "SECOND.md", "Second fallback guidance.");

  const loaded = await load(root, {
    projectRootMarkers: [],
    projectInstructionsFallbackFilenames: ["AGENTS.md", "EMPTY.md", "FIRST.md", "FIRST.md", "SECOND.md"],
  });

  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), [path]);
  assert.equal(loaded.project.content, "First fallback guidance.");
});

test("自定义规则名称和多个项目标记使用最近目录", async (t) => {
  const root = await fixture(t);
  const nested = join(root, "nested");
  const workspace = join(nested, "src");
  await document(root, "ROOT.marker", "");
  await document(root, "RULES.md", "Outer guidance.");
  await document(nested, "NEAREST.marker", "");
  const rootPath = await document(nested, "RULES.md", "Custom repository guidance.");
  await document(workspace, "AGENTS.md", "Unselected ordinary guidance.");
  const workspacePath = await document(workspace, "RULES.md", "Custom local guidance.");

  const loaded = await load(workspace, {
    projectInstructionsFilename: "RULES.md",
    projectRootMarkers: ["ROOT.marker", "NEAREST.marker"],
  });

  assert.deepEqual(loaded.projects.map((entry) => entry.source.path), [rootPath, workspacePath]);
  assert.doesNotMatch(loaded.effective, /Outer guidance|Unselected ordinary/u);
});

test("禁用项目发现同时排除 override 和 fallback", async (t) => {
  const root = await fixture(t);
  await document(root, "AGENTS.override.md", "Override guidance.");
  await document(root, "AGENTS.md", "Ordinary guidance.");
  await document(root, "PROJECT.md", "Fallback guidance.");

  const loaded = await load(root, {
    projectInstructionsFilename: false,
    projectInstructionsFallbackFilenames: ["PROJECT.md"],
  });

  assert.deepEqual(loaded.projects, []);
  assert.equal(loaded.project, undefined);
  assert.equal(loaded.effective, "System");
});

test("项目正文总量按 UTF-8 字节包含文档之间的空行", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "child");
  await mkdir(join(root, ".git"));
  await document(root, "AGENTS.md", "规则");
  await document(workspace, "AGENTS.md", "😀");
  const bytes = Buffer.byteLength("规则\n\n😀", "utf8");

  const loaded = await load(workspace, { maxBytes: bytes });
  assert.equal(loaded.projects.length, 2);
  assert.equal(loaded.projects[0].content, "规则");
  assert.equal(loaded.projects[1].content, "😀");
  await assert.rejects(load(workspace, { maxBytes: bytes - 1 }), (error) => {
    assert.ok(hasCode("CODING_INSTRUCTIONS_TOO_LARGE")(error));
    assert.match(error.message, /Combined project instructions/u);
    return true;
  });
});

test("单份规则超出限制时报告该文件并保持正文空白", async (t) => {
  const root = await fixture(t);
  const path = await document(root, "AGENTS.md", " \nabcdef\n ");

  const loaded = await load(root, { projectRootMarkers: [], maxBytes: 11 });
  assert.equal(loaded.project.content, " \nabcdef\n ");
  await assert.rejects(load(root, { projectRootMarkers: [], maxBytes: 9 }), (error) => {
    assert.ok(hasCode("CODING_INSTRUCTIONS_TOO_LARGE")(error));
    assert.ok(error.message.includes(path));
    return true;
  });
});

test("父目录规则中的 hard link 会终止规则组合", async (t) => {
  const root = await fixture(t);
  const repository = join(root, "repository");
  const workspace = join(repository, "child");
  await mkdir(join(repository, ".git"), { recursive: true });
  const external = await document(root, "external.md", "External guidance.");
  await link(external, join(repository, "AGENTS.md"));
  await document(workspace, "AGENTS.md", "Local guidance.");

  await assert.rejects(load(workspace), hasCode("CODING_INSTRUCTIONS_UNSAFE_LINK"));
});

test("父目录规则中的 symbolic link 会终止规则组合", async (t) => {
  const root = await fixture(t);
  const repository = join(root, "repository");
  const workspace = join(repository, "child");
  await mkdir(join(repository, ".git"), { recursive: true });
  const external = await document(root, "external.md", "External guidance.");
  try {
    await symlink(external, join(repository, "AGENTS.override.md"), "file");
  } catch (error) {
    if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip("当前 Windows 权限无法创建文件 symbolic link。");
      return;
    }
    throw error;
  }
  await document(repository, "AGENTS.md", "Ordinary guidance.");
  await document(workspace, "AGENTS.md", "Local guidance.");

  await assert.rejects(load(workspace), hasCode("CODING_INSTRUCTIONS_UNSAFE_LINK"));
});

test("规则路径中的目录链接及 Windows junction 会被拒绝", async (t) => {
  const root = await fixture(t);
  const repository = join(root, "repository");
  const workspace = join(repository, "child");
  const external = join(root, "external");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(external);
  await symlink(external, join(repository, "AGENTS.override.md"), process.platform === "win32" ? "junction" : "dir");
  await document(workspace, "AGENTS.md", "Local guidance.");

  await assert.rejects(load(workspace), hasCode("CODING_INSTRUCTIONS_UNSAFE_LINK"));
});

test("无效 UTF-8 override 会报告错误并停止选择 fallback", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "child");
  await mkdir(join(root, ".git"));
  await document(root, "AGENTS.override.md", Buffer.from([0xc3, 0x28]));
  await document(root, "AGENTS.md", "Ordinary guidance.");
  await document(workspace, "AGENTS.md", "Local guidance.");

  await assert.rejects(load(workspace), hasCode("CODING_INSTRUCTIONS_INVALID_UTF8"));
});

test("规则文件路径为目录时立即报告错误", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "AGENTS.override.md"));
  await document(root, "AGENTS.md", "Ordinary guidance.");

  await assert.rejects(load(root, { projectRootMarkers: [] }), hasCode("CODING_INSTRUCTIONS_NOT_A_FILE"));
});

test("规则和标记配置拒绝目录跳转及错误类型", async (t) => {
  const root = await fixture(t);
  for (const options of [
    { projectInstructionsFallbackFilenames: ["../outside.md"] },
    { projectInstructionsFallbackFilenames: ["nested/RULES.md"] },
    { projectInstructionsFallbackFilenames: [42] },
    { projectInstructionsFallbackFilenames: "RULES.md" },
    { projectRootMarkers: ["../.git"] },
    { projectRootMarkers: ["nested\\.git"] },
    { projectRootMarkers: [""] },
    { projectRootMarkers: [null] },
    { projectRootMarkers: ".git" },
  ]) {
    await assert.rejects(load(root, options), hasCode("CODING_INSTRUCTIONS_INVALID_OPTION"));
  }
});

test("启动前和读取过程中取消会保留取消原因", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  await document(root, "AGENTS.md", "Project guidance.");
  const before = new AbortController();
  const beforeReason = new Error("Canceled before instruction loading");
  before.abort(beforeReason);
  await assert.rejects(load(root, { signal: before.signal }), (error) => error === beforeReason);

  const during = new AbortController();
  const duringReason = new Error("Canceled during instruction loading");
  const pending = load(root, { signal: during.signal });
  during.abort(duringReason);
  await assert.rejects(pending, (error) => error === duringReason);
});

async function fixture(t) {
  const parent = fileURLToPath(new URL("../../../../review/instruction-chain-tests/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const path = await mkdtemp(join(parent, "workspace-"));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return path;
}

async function document(directory, filename, content) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, content);
  return realpath(path);
}

function load(workspace, options = {}) {
  return loadCodingInstructions({ workspace, defaultSystemInstructions: "System", ...options });
}

function hasCode(code) {
  return (error) => error instanceof CodingInstructionsError && error.code === code;
}
