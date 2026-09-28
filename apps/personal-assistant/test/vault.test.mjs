import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Vault } from "../dist/vault/vault.js";

const roots = [];
async function createVault() {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-vault-"));
  roots.push(root);
  return { root, vault: await Vault.open(join(root, "vault")) };
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("写入后可以按中文关键词检索，并给出正确的原文行号", async () => {
  const { vault } = await createVault();
  await vault.write("people/advisor.md", [
    "---",
    "title: 导师信息",
    "tags: [people, 导师]",
    "---",
    "",
    "# 导师信息",
    "",
    "导师：张三，邮箱 zhangsan@example.edu.cn。",
    "实验室在鼓楼校区。",
    "",
  ].join("\n"));

  const hits = await vault.search("导师 邮箱");
  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.equal(hit.path, "people/advisor.md");
  assert.equal(hit.title, "导师信息");
  assert.match(hit.text, /张三/);

  const document = await readFile(join(vault.root, "people/advisor.md"), "utf8").then((text) => text.split("\n"));
  const excerpt = document.slice(hit.startLine - 1, hit.endLine).join("\n");
  assert.match(excerpt, /张三/);
  assert.ok(hit.startLine >= 1 && hit.endLine <= document.length);
});

test("英文与数字按词切分，可以定位到具体行", async () => {
  const { vault } = await createVault();
  await vault.write("records/tuition.md", "---\ntitle: 学费\n---\n\n学费缴纳账号 2026001234。\n");
  const [hit] = await vault.search("2026001234");
  assert.ok(hit);
  assert.equal(hit.path, "records/tuition.md");
  assert.match(hit.text, /2026001234/);
});

test("文件修改后索引立即更新，删除后不再命中", async () => {
  const { vault } = await createVault();
  const first = await vault.write("projects/notice.md", "# 通知\n\n报名截止时间是 2026-10-01。\n");
  assert.equal((await vault.search("报名截止时间")).length, 1);

  await vault.write("projects/notice.md", "# 通知\n\n报名截止时间是 2026-10-08，活动开始时间是 2026-10-15。\n", { expectedHash: first.hash });
  const updated = await vault.search("2026-10-08");
  assert.equal(updated.length, 1);
  const stale = await vault.search("2026-10-01");
  assert.equal(stale.filter((hit) => /10-01/u.test(hit.text)).length, 0);

  assert.equal(await vault.remove("projects/notice.md"), true);
  assert.equal((await vault.search("报名截止时间")).length, 0);
  assert.equal((await vault.list()).length, 0);
});

test("expectedHash 不匹配时拒绝覆盖", async () => {
  const { vault } = await createVault();
  await vault.write("notes/a.md", "# A\n\n原始内容\n");
  await assert.rejects(
    () => vault.write("notes/a.md", "# A\n\n新内容\n", { expectedHash: "0".repeat(64) }),
    /文件已被修改/,
  );
  assert.match(await readFile(join(vault.root, "notes/a.md"), "utf8"), /原始内容/);
});

test("拒绝越界路径与非 Markdown 路径", async () => {
  const { vault } = await createVault();
  await assert.rejects(() => vault.write("../escape.md", "# x\n"), /非法片段/);
  await assert.rejects(() => vault.write("notes/data.txt", "x"), /只保存 Markdown/);
  await assert.rejects(() => vault.read("notes/missing.md"), /文件不存在/);
  assert.equal(await vault.exists("notes/missing.md"), false);
});

test("标签与目录前缀可以过滤检索结果", async () => {
  const { vault } = await createVault();
  await vault.write("people/a.md", "---\ntitle: 甲\ntags: [people]\n---\n\n甲的邮箱。\n");
  await vault.write("people/b.md", "---\ntitle: 乙\ntags: [people, 导师]\n---\n\n乙的邮箱。\n");
  const tagged = await vault.search("邮箱", { tags: ["导师"] });
  assert.deepEqual(tagged.map((hit) => hit.path), ["people/b.md"]);
  const prefixed = await vault.search("邮箱", { prefix: "people/" });
  assert.equal(prefixed.length, 2);
  const other = await vault.search("邮箱", { prefix: "projects/" });
  assert.equal(other.length, 0);
});

test("重新打开时复用磁盘索引，并且可以继续增量更新", async () => {
  const { root, vault } = await createVault();
  await vault.write("people/c.md", "---\ntitle: 丙\n---\n\n丙的办公室在四楼。\n");
  const status = await vault.status();
  assert.equal(status.files, 1);
  assert.ok(status.gitRepository);

  const reopened = await Vault.open(join(root, "vault"));
  assert.equal((await reopened.search("办公室")).length, 1);
  await reopened.write("people/d.md", "---\ntitle: 丁\n---\n\n丁的办公室在五楼。\n");
  const ranked = await reopened.search("五楼");
  assert.equal(ranked[0]?.path, "people/d.md");
  assert.equal((await reopened.search("四楼"))[0]?.path, "people/c.md");
});

test("Git 记录规则与素材的每次变化", async () => {
  const { vault } = await createVault();
  await vault.write("rules/deadline.md", "---\ntitle: 截止时间\n---\n\n报名截止时间不是活动开始时间。\n");
  assert.equal(await vault.git.commit("记录截止时间规则"), true);
  assert.equal(await vault.git.commit("没有改动时不应产生提交"), false);
  const log = await vault.git.log(5);
  assert.equal(log[0]?.subject, "记录截止时间规则");
  assert.equal((await vault.status()).pendingChanges, 0);

  await vault.write("rules/second.md", "---\ntitle: 第二条\n---\n\n办事大厅提交前必须展示关键字段。\n");
  assert.equal((await vault.status()).pendingChanges, 1);
});

test("超长内容与空关键词被拒绝", async () => {
  const { vault } = await createVault();
  await assert.rejects(() => vault.search("   "), /关键词不能为空/);
  await assert.rejects(() => vault.write("big.md", "x".repeat(1024 * 1024 + 1)), /上限/);
});

test("索引目录与 Git 目录不进入检索结果", async () => {
  const { root, vault } = await createVault();
  await vault.write("notes/e.md", "# E\n\n内容\n");
  await writeFile(join(root, "vault", ".index", "note.md"), "# 不该被索引\n");
  assert.deepEqual((await vault.list()).map((entry) => entry.path), ["notes/e.md"]);
});
