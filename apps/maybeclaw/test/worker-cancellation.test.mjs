import assert from "node:assert/strict";
import test from "node:test";
import { fixture, until } from "./fixtures/rpc-coordination-worker.mjs";

const context = () => ({ signal: new AbortController().signal, report() {} });

async function detached(f, execution) {
  const rejected = assert.rejects(f.remote.execute(execution, context()), /outcome reconciliation/u);
  await until(async () => (await f.taskRecord(execution))?.status === "running");
  f.disconnect();
  await rejected;
  assert.equal((await f.remote.recover(execution)).status, "recovery-required");
}

test("Worker 将持久化取消意图发送至仍在运行的真实 RPC 任务", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const execution = await f.task();
  await detached(f, execution);
  await f.remote.cancel(execution);
  assert.equal((await f.taskRecord(execution)).status, "cancelled");
  assert.equal((await f.remote.recover(execution)).status, "cancelled");
  const saved = await f.journal();
  assert.equal(saved.cancelRequested, true);
  assert.equal(saved.outcome.status, "cancelled");
  const controls = await f.controls();
  assert.ok(controls.some(record => record.method === "cancel" && record.cancelRequested));
  assert.ok(controls.some(record => record.method === "recover" && record.cancelRequested));
});

test("active 执行在取消期间断开传输后立即继续发送外部取消", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { disconnectOnAbort: true });
  const execution = await f.task();
  const rejected = assert.rejects(f.remote.execute(execution, context()), /cancelled|outcome reconciliation/u);
  await until(async () => (await f.taskRecord(execution))?.status === "running");
  await f.remote.cancel(execution);
  await rejected;
  await until(async () => (await f.taskRecord(execution))?.status === "cancelled");
  await until(async () => (await f.journal()).outcome?.status === "cancelled");
  assert.equal((await f.journal()).outcome.status, "cancelled");
  assert.ok((await f.controls()).some(record => record.method === "cancel" && record.cancelRequested));
});

test("Worker 保存发送失败的取消请求，并在重新打开后继续取消真实外部任务", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const execution = await f.task();
  await detached(f, execution);
  await f.stopProxy();
  await f.remote.cancel(execution);
  const saved = await f.journal();
  assert.equal(saved.cancelRequested, true);
  assert.equal(saved.outcome.status, "recovery-required");
  assert.match(saved.outcome.detail, /取消请求交付.*未能确认/u);
  assert.equal((await f.taskRecord(execution)).status, "running");
  await f.closeWorker();
  await f.startProxy();
  const reopened = await f.openWorker();
  assert.equal((await f.taskRecord(execution)).status, "cancelled");
  assert.equal((await reopened.recover(execution)).status, "cancelled");
  assert.equal((await f.journal()).cancelRequested, true);
});

test("Worker 在网络恢复后的查询中重试保存的取消请求", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const execution = await f.task();
  await detached(f, execution);
  await f.stopProxy();
  await f.remote.cancel(execution);
  await f.startProxy();
  assert.equal((await f.remote.recover(execution)).status, "cancelled");
  assert.equal((await f.taskRecord(execution)).status, "cancelled");
});

test("取消能力不足时保留不确定结果，外部完成证据仍能确定终态", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { cancelSupported: false });
  const execution = await f.task();
  await detached(f, execution);
  await f.remote.cancel(execution);
  assert.equal((await f.taskRecord(execution)).status, "running");
  assert.equal((await f.journal()).outcome.status, "recovery-required");
  await f.finish(execution);
  await until(async () => (await f.taskRecord(execution))?.status === "completed");
  const recovered = await f.remote.recover(execution);
  assert.equal(recovered.status, "completed");
  assert.match(recovered.output.text, /File is available/u);
});

test("没有 Worker 派发记录时保存取消意图并取消已有的外部执行", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const execution = await f.task();
  const rejected = assert.rejects(f.bridge.execute(execution, context()));
  await until(async () => (await f.taskRecord(execution))?.status === "running");
  await f.remote.cancel(execution);
  await rejected;
  assert.equal((await f.taskRecord(execution)).status, "cancelled");
  assert.equal((await f.remote.recover(execution)).status, "cancelled");
  assert.equal((await f.journal()).cancelRequested, true);
  await assert.rejects(f.remote.execute(execution, context()), /outcome reconciliation/u);
});

test("派发前取消请求经过 Worker 重启后继续阻止执行", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const execution = await f.task();
  await f.remote.cancel(execution);
  assert.equal((await f.remote.recover(execution)).status, "cancelled");
  await f.closeWorker();
  const reopened = await f.openWorker();
  await assert.rejects(reopened.execute(execution, context()), /outcome reconciliation/u);
  assert.equal(await f.taskRecord(execution), undefined);
});

test("Worker 关闭期间重试已经保存且结果不确定的取消请求", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const execution = await f.task();
  await detached(f, execution);
  await f.stopProxy();
  await f.remote.cancel(execution);
  await f.startProxy();
  await f.closeWorker();
  assert.equal((await f.taskRecord(execution)).status, "cancelled");
  assert.equal((await f.journal()).outcome.status, "cancelled");
});

test("Worker 关闭 active 执行时发送持久化取消，并保存外部终态", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { disconnectOnAbort: true });
  const execution = await f.task();
  const rejected = assert.rejects(f.remote.execute(execution, context()), /rejected request \(503\)|outcome reconciliation/u);
  await until(async () => (await f.taskRecord(execution))?.status === "running");
  await f.closeWorker();
  await rejected;
  assert.equal((await f.taskRecord(execution)).status, "cancelled");
  assert.equal((await f.journal()).outcome.status, "cancelled");
});
