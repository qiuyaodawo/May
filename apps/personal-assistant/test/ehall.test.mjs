import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseCatalog, findService, ensureCatalog } from "../dist/ehall/catalog.js";
import { formDigest, prepareTransaction, shortDigest } from "../dist/ehall/plan.js";
import { Vault } from "../dist/vault/vault.js";

const roots = [];
async function createVault() {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-ehall-"));
  roots.push(root);
  return Vault.open(join(root, "vault"));
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("内置办事目录可以直接解析，并标出不可撤销事务", async () => {
  const vault = await createVault();
  const catalog = await ensureCatalog(vault);
  assert.ok(catalog.services.length >= 5);
  assert.equal(findService(catalog, "course-withdraw").irreversible, true);
  assert.equal(findService(catalog, "transcript").materials[0].path, "records/transcript.md");
  assert.throws(() => findService(catalog, "unknown"), /没有事务 unknown/);
  const file = await readFile(join(vault.root, "ehall/services.md"), "utf8");
  assert.match(file, /title: 办事大厅事务目录/);
  assert.match(file, /irreversible: true/);
  assert.match(file, /id: course-withdraw/);
});

test("办事目录拒绝非办事大厅域名与不合法的材料路径", () => {
  assert.throws(() => parseCatalog(`---
version: 1
services:
  - id: other
    name: 其它
    category: 教学
    url: https://example.com/form
    irreversible: false
    submitLabel: 提交
---
`), /必须指向/);
  assert.throws(() => parseCatalog(`---
version: 1
services:
  - id: other
    name: 其它
    category: 教学
    url: https://ehall.nju.edu.cn/form
    irreversible: false
    submitLabel: 提交
    materials:
      - path: ../escape.md
---
`), /Markdown 相对路径/);
  assert.throws(() => parseCatalog(`---
version: 1
services:
  - id: Other
    name: 其它
    category: 教学
    url: https://ehall.nju.edu.cn/form
    irreversible: false
    submitLabel: 提交
---
`), /只能使用小写字母/);
  assert.throws(() => parseCatalog(`---
version: 1
services:
  - id: other
    name: 其它
    category: 教学
    url: https://ehall.nju.edu.cn/form
    irreversible: false
---
`), /submitLabel/);
});

test("首次使用时写入内置目录，材料清单能指出缺什么", async () => {
  const vault = await createVault();
  const catalog = await ensureCatalog(vault);
  assert.ok(catalog.services.some((service) => service.id === "transcript"));

  const preparation = await prepareTransaction({ vault, allowedHosts: ["ehall.nju.edu.cn"] }, "transcript");
  assert.deepEqual(preparation.missing, ["records/transcript.md"]);
  assert.equal(preparation.canSubmit, true);
  assert.match(preparation.reason, /还缺少材料/);

  await vault.write("records/transcript.md", "---\ntitle: 成绩单用途\n---\n\n申请英文成绩单两份，用于申请交换。\n");
  const ready = await prepareTransaction({ vault, allowedHosts: ["ehall.nju.edu.cn"] }, "transcript");
  assert.deepEqual(ready.missing, []);
  assert.equal(ready.reason, undefined);
});

test("不可撤销事务不提供提交", async () => {
  const vault = await createVault();
  const preparation = await prepareTransaction({ vault, allowedHosts: ["ehall.nju.edu.cn"] }, "course-withdraw");
  assert.equal(preparation.canSubmit, false);
  assert.match(preparation.reason, /不可撤销事务/);
});

test("字段摘要覆盖字段值、按钮与页面地址", () => {
  const fields = [
    { label: "姓名", role: "input", value: "张三", required: true, filledByAssistant: true },
    { label: "份数", role: "select", value: "2", required: false, filledByAssistant: true },
  ];
  const base = { url: "https://ehall.nju.edu.cn/a", serviceId: "transcript", submitLabel: "提交申请", fields };
  const digest = formDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(formDigest(base), digest);
  assert.notEqual(formDigest({ ...base, submitLabel: "提交" }), digest);
  assert.notEqual(formDigest({ ...base, url: "https://ehall.nju.edu.cn/b" }), digest);
  assert.notEqual(formDigest({
    ...base,
    fields: [...fields, { label: "备注", role: "input", value: "", required: false, filledByAssistant: false }],
  }), digest);
  assert.equal(shortDigest(digest).length, 12);
});

test("表单归档写入个人数据库，附带字段表", async () => {
  const vault = await createVault();
  const { archiveSnapshot } = await import("../dist/ehall/plan.js");
  const file = await archiveSnapshot({ vault, allowedHosts: ["ehall.nju.edu.cn"] }, {
    url: "https://ehall.nju.edu.cn/fw/xszz/jw/index.do",
    serviceId: "transcript",
    title: "成绩单申请",
    fields: [
      { label: "姓名", role: "input", value: "张三", required: true, filledByAssistant: true },
      { label: "用途", role: "select", value: "交换申请", required: true, filledByAssistant: true },
    ],
    submitLabel: "提交申请",
    digest: "a".repeat(64),
    capturedAt: Date.parse("2026-09-20T10:00:00.000Z"),
  }, { submitted: false, note: "已核对字段，尚未提交" });
  const content = await readFile(join(vault.root, file), "utf8");
  assert.match(content, /title: 成绩单打印申请 表单/);
  assert.match(content, /\| 姓名 \| input \| 是 \| 是 \| 张三 \|/u);
  assert.match(content, /未提交/u);
  assert.ok((await vault.search("成绩单申请")).length >= 1);
});
