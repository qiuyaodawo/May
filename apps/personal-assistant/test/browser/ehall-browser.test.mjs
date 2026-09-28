import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EhallService } from "../../dist/ehall/service.js";
import { EhallBrowser } from "../../dist/ehall/browser.js";
import { formatCatalog } from "../../dist/ehall/catalog.js";
import { shortDigest } from "../../dist/ehall/plan.js";
import { Vault } from "../../dist/vault/vault.js";

/**
 * 用真实 Chromium 驱动一个本地固定页面，验证填写、字段摘要与确认门槛。
 * 页面是仓库内的测试夹具，不访问 ehall.nju.edu.cn。
 */

const FORM_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>成绩单打印申请</title></head>
<body>
  <h1>成绩单打印申请</h1>
  <form id="apply" method="get" action="/submitted">
    <p><label for="name">姓名</label><input id="name" name="name" required></p>
    <p><label for="count">份数</label>
      <select id="count" name="count">
        <option value="1">1</option>
        <option value="2">2</option>
      </select>
    </p>
    <p><label for="purpose">用途</label>
      <select id="purpose" name="purpose">
        <option value="">请选择</option>
        <option value="exchange">交换申请</option>
        <option value="employ">求职</option>
      </select>
    </p>
    <p><label for="delivery">领取方式</label><input id="delivery" name="delivery" type="checkbox"></p>
    <p><button type="submit">提交申请</button></p>
  </form>
</body></html>`;

const SUBMITTED_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>提交成功</title></head>
<body><h1>提交成功</h1><p id="result">成绩单打印申请 已受理</p></body></html>`;

let server;
let origin;
let root;
let ehall;
const submissions = [];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "may-assistant-ehall-browser-"));
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/submitted") {
      submissions.push(url.search);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBMITTED_PAGE);
      return;
    }
    if (url.pathname === "/withdraw") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>退课申请</title></head>
        <body><h1>退课申请</h1><form method="get" action="/submitted">
        <p><label for="course">课程</label><input id="course" name="course"></p>
        <p><button type="submit">提交</button></p></form></body></html>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FORM_PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  const vault = await Vault.open(join(root, "vault"));
  await vault.write("ehall/services.md", formatCatalog([
    {
      id: "transcript",
      name: "成绩单打印申请",
      category: "教学",
      url: `${origin}/apply`,
      irreversible: false,
      submitLabel: "提交申请",
      materials: [{ path: "records/transcript.md", note: "用途与份数" }],
      note: undefined,
    },
    {
      id: "course-withdraw",
      name: "退课申请",
      category: "教学",
      url: `${origin}/withdraw`,
      irreversible: true,
      submitLabel: "提交",
      materials: [],
      note: "不可撤销",
    },
  ]));
  await vault.write("records/transcript.md", "---\ntitle: 成绩单用途\n---\n\n申请英文成绩单两份，用于交换。\n");
  ehall = await EhallService.open({
    vault,
    browserSettings: {
      profileDirectory: join(root, "profile"),
      headless: true,
      timeoutMs: 15_000,
      allowedHosts: ["ehall.nju.edu.cn"],
    },
    stateFile: join(root, "ehall-state.json"),
  });
});

after(async () => {
  await ehall?.close();
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("打开事务页面并读取可填写字段", async () => {
  const page = await ehall.open("transcript");
  assert.match(page.url, /\/apply$/u);
  assert.match(page.title, /成绩单打印申请/u);
  assert.equal(page.loginRequired, false);

  const fields = await ehall.controls();
  const labels = fields.map((field) => field.label);
  assert.ok(labels.includes("姓名"));
  assert.ok(labels.includes("份数"));
  assert.ok(labels.includes("用途"));
  assert.equal(fields.find((field) => field.label === "姓名").required, true);
  assert.match(await ehall.snapshotTree(), /textbox "姓名"/u);
});

test("材料清单指出个人数据库里还缺什么", async () => {
  const preparation = await ehall.prepare("transcript");
  assert.deepEqual(preparation.missing, []);
  assert.equal(preparation.canSubmit, true);
});

test("填写字段后生成字段摘要，内容变化摘要随之改变", async () => {
  await ehall.open("transcript");
  const filled = await ehall.fill("姓名", "张三");
  assert.equal(filled.field.value, "张三");
  assert.equal(filled.field.filledByAssistant, true);
  await ehall.fill("份数", "2");
  await ehall.fill("用途", "交换申请");

  const review = await ehall.review("transcript");
  const byLabel = Object.fromEntries(review.fields.map((field) => [field.label, field.value]));
  assert.equal(byLabel["姓名"], "张三");
  assert.equal(byLabel["份数"], "2");
  assert.equal(byLabel["用途"], "交换申请");
  assert.equal(byLabel["领取方式"], "否");
  assert.match(review.digest, /^[a-f0-9]{64}$/u);
  assert.equal(review.submitLabel, "提交申请");

  const changed = await ehall.fill("姓名", "李四");
  assert.equal(changed.field.value, "李四");
  const after = await ehall.review("transcript");
  assert.notEqual(after.digest, review.digest);
});

test("没有确认时拒绝提交，字段变化后旧确认失效", async () => {
  await ehall.open("transcript");
  await ehall.fill("姓名", "张三");
  const review = await ehall.review("transcript");
  await assert.rejects(() => ehall.submit({}), /还没有被确认/);

  const confirmation = await ehall.confirm(review.digest);
  assert.equal(confirmation.serviceId, "transcript");
  await assert.rejects(() => ehall.confirm("0".repeat(64)), /表单已经变化/);

  await ehall.fill("领取方式", "是");
  await assert.rejects(() => ehall.submit({}), /还没有被确认/);
  assert.equal(submissions.length, 0);
});

test("确认之后提交，并把字段表归档到个人数据库", async () => {
  const review = await ehall.review("transcript");
  await ehall.confirm(review.digest);
  const result = await ehall.submit({ screenshot: "transcript" });
  assert.equal(submissions.length, 1);
  assert.match(submissions[0], /name=%E5%BC%A0%E4%B8%89/u);
  assert.match(result.result.text, /提交成功/u);
  assert.match(result.file, /^ehall\/forms\//u);
  assert.match(result.screenshot, /transcript\.png$/u);

  const archived = await readFile(join(ehall.dependencies.vault.root, result.file), "utf8");
  assert.match(archived, /\| 姓名 \| input \| 是 \| 是 \| 张三 \|/u);
  assert.match(archived, /已点击「提交申请」/u);
  assert.equal(ehall.confirmation(), undefined);
});

test("不可撤销事务既不提供提交，也不接受确认", async () => {
  await ehall.open("course-withdraw");
  const preparation = await ehall.prepare("course-withdraw");
  assert.equal(preparation.canSubmit, false);
  const review = await ehall.review("course-withdraw");
  await ehall.confirm(review.digest);
  await assert.rejects(() => ehall.submit({}), /不可撤销事务/);
  assert.equal(submissions.length, 1);
});

test("只允许访问配置中的办事大厅域名", async () => {
  const browser = await EhallBrowser.launch({
    profileDirectory: join(root, "profile-guard"),
    headless: true,
    timeoutMs: 10_000,
    allowedHosts: ["ehall.nju.edu.cn"],
  });
  try {
    await assert.rejects(() => browser.open("https://example.com/form"), /只允许访问 ehall\.nju\.edu\.cn/);
    await assert.rejects(() => browser.open("http://ehall.nju.edu.cn/form"), /只允许 https/);
  } finally {
    await browser.close();
  }
});
