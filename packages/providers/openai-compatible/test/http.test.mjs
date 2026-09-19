import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  parseRetryAfterMs,
  readSseData,
} from "@may/provider-openai-compatible/http";

test("readSseData 解析按字节分段的 UTF-8 与 SSE 事件", async (t) => {
  const url = await startServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "\uFEFF: heartbeat\r\nid: 42\r\nevent: delta\r\nretry: 1000\r\n" +
      "data: 中文 😀\r\ndata: second\r\n\r\n" +
      "data:  leading space\n\n" +
      "data: lone CR\r\rdata:\r\rdata\n\n" +
      "data: final",
    );
  });
  const response = await fetch(url);
  const fragmented = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.length; index += 1) {
        controller.enqueue(chunk.subarray(index, index + 1));
      }
    },
  }));
  const events = await collect(new Response(fragmented));
  assert.deepEqual(events, [
    "中文 😀\nsecond",
    " leading space",
    "lone CR",
    "",
    "",
    "final",
  ]);
});

test("readSseData 在 EOF 完成最后一个事件且不会重复发送", async (t) => {
  const endings = ["", "\n", "\r", "\r\n", "\n\n", "\r\n\r\n"];
  const url = await startServer(t, (request, response) => {
    const index = Number(new URL(request.url, "http://localhost").searchParams.get("index"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: final${endings[index]}`);
  });
  for (let index = 0; index < endings.length; index += 1) {
    assert.deepEqual(await collect(await fetch(`${url}?index=${index}`)), ["final"]);
  }
});

test("readSseData 中止等待时释放 HTTP 连接并保留原因", { timeout: 5000 }, async (t) => {
  const { response, closed } = await openStream(t);
  const controller = new AbortController();
  const events = readSseData(response, controller.signal, protocolError, "Test");
  assert.deepEqual(await events.next(), { value: "first", done: false });
  const pending = events.next();
  const reason = new Error("用户取消");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await closed;
  assert.equal(response.body.locked, false);
});

test("readSseData 提前结束迭代时释放 HTTP 连接", { timeout: 5000 }, async (t) => {
  const { response, closed } = await openStream(t);
  const events = readSseData(response, new AbortController().signal, protocolError, "Test");
  assert.deepEqual(await events.next(), { value: "first", done: false });
  await events.return();
  await closed;
  assert.equal(response.body.locked, false);
});

test("readSseData 中止后停止交付同一 chunk 中的其他事件", async (t) => {
  const url = await startServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: first\n\ndata: second\n\n");
  });
  const response = await fetch(url);
  const controller = new AbortController();
  const events = readSseData(response, controller.signal, protocolError, "Test");
  assert.deepEqual(await events.next(), { value: "first", done: false });
  const reason = new Error("用户取消");
  controller.abort(reason);
  await assert.rejects(events.next(), (error) => error === reason);
  assert.equal(response.body.locked, false);
});

test("readSseData 传播 HTTP 连接异常并释放 reader", { timeout: 5000 }, async (t) => {
  let serverResponse;
  const url = await startServer(t, (_request, response) => {
    serverResponse = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  const response = await fetch(url);
  const events = readSseData(response, new AbortController().signal, protocolError, "Test");
  assert.deepEqual(await events.next(), { value: "first", done: false });
  const pending = events.next();
  serverResponse.destroy();
  await assert.rejects(pending, TypeError);
  assert.equal(response.body.locked, false);
});

test("readSseData 开始前已经中止时释放 HTTP 连接", { timeout: 5000 }, async (t) => {
  const { response, closed } = await openStream(t);
  const controller = new AbortController();
  controller.abort("用户取消");
  const events = readSseData(response, controller.signal, protocolError, "Test");
  await assert.rejects(events.next(), { name: "AbortError" });
  await closed;
  assert.equal(response.body.locked, false);
});

test("readSseData 使用调用方错误类型报告空 body", async (t) => {
  const url = await startServer(t, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await assert.rejects(collect(await fetch(url)), {
    name: "TypeError",
    message: "Test response has no body",
  });
});

test("parseRetryAfterMs 支持秒数与 HTTP 日期", () => {
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs("invalid"), undefined);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs("1.5"), 1500);
  assert.equal(parseRetryAfterMs("0.0006"), 1);
  assert.equal(parseRetryAfterMs("Wed, 01 Jan 2020 00:00:00 GMT"), 0);

  const timestamp = Math.floor(Date.now() / 1000) * 1000 + 60_000;
  const before = Date.now();
  const delay = parseRetryAfterMs(new Date(timestamp).toUTCString());
  const after = Date.now();
  assert.ok(delay >= timestamp - after);
  assert.ok(delay <= timestamp - before);
});

async function startServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function openStream(t) {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const url = await startServer(t, (_request, response) => {
    response.once("close", resolveClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  return { response: await fetch(url), closed };
}

async function collect(response) {
  const events = [];
  for await (const data of readSseData(
    response,
    new AbortController().signal,
    protocolError,
    "Test",
  )) {
    events.push(data);
  }
  return events;
}

function protocolError(message, options) {
  return new TypeError(message, options);
}
