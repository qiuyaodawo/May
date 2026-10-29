import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PluginHost, defineService } from "@sortedyuan/may/plugin";
import { ChannelStore, createDeliveryPlugin, deliveryServices, digest, inboxId, channelTextPages, boundedBytes } from "../../dist/delivery/index.js";

test("channel journals retain inbox, cursor and uncertain delivery evidence after reopen", async t => {
  const base = fileURLToPath(new URL("../../../../plugin-verification/channel-journal/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "records-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "channels.jsonl");
  const input = { account: "telegram:271", eventId: "event-document", sender: "991", conversation: "991", text: "Read documentation" };
  let store = await ChannelStore.open(path);
  await store.put({ kind: "inbox", id: inboxId(input), input, processed: false });
  const delivery = { kind: "delivery", id: digest({ input: input.eventId }), account: input.account, sender: input.sender, conversation: input.conversation, text: "Document loaded", status: "sending" };
  await store.put(delivery);
  await Promise.all([store.close(), store.close()]);
  await appendFile(path, '{"kind":"cursor"');
  await unlink(`${path}.access`);
  await unlink(`${path}.access.gate`);
  assert.equal((await ChannelStore.inspect(path)).find(record => record.id === delivery.id).status, "sending");
  store = await ChannelStore.open(path);
  assert.equal(store.get(inboxId(input)).kind, "inbox");
  assert.equal(store.get(delivery.id).status, "unknown");
  assert.ok((await readFile(path, "utf8")).endsWith("\n"));
  await store.remove([delivery.id]);
  await store.close();
  assert.equal((await ChannelStore.inspect(path)).length, 1);
});

test("delivery plugin resolves actual journal dependencies and owns an empty registry", async t => {
  const base = fileURLToPath(new URL("../../../../plugin-verification/channel-host/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await ChannelStore.open(join(directory, "channel.jsonl"));
  const ingress = defineService({ id: "test.file-channel-ingress", version: "1.0.0", scope: "host" });
  const host = await PluginHost.create({ plugins: [createDeliveryPlugin({ ingress })], services: [{ service: ingress, value: {
    store, async receive(input) { await store.put({ kind: "inbox", id: inboxId(input), input, processed: false }); },
  } }] });
  assert.deepEqual(host.get(deliveryServices.registry).list(), []);
  assert.equal(host.get(deliveryServices.registry).errors().size, 0);
  assert.equal(typeof host.get(deliveryServices.delivery).attempt, "function");
  await host.close(); await store.close();
});

test("an independent file channel persists custom attachment references and sends through its own transport", async t => {
  const base = fileURLToPath(new URL("../../../../review/independent-file-channel/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "channel-"));
  const path = join(directory, "channels.jsonl"), documentId = "report.txt";
  const input = { account: "local-files:inbox", eventId: "document-1", sender: "local", conversation: "reports", text: "Read report",
    attachments: [{ id: "report", kind: "file", source: { platform: "local-files", documentId } }] };
  await writeFile(join(directory, documentId), "Independent channel content");
  await writeFile(join(directory, "input.json"), JSON.stringify(input));
  const store = await ChannelStore.open(path);
  let host;
  t.after(async () => { await host?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const adapter = {
    name: "local-files", account: input.account, allowUsers: ["local"],
    status: () => "ready",
    async run(receive, _store, signal) {
      signal.throwIfAborted();
      await receive(JSON.parse(await readFile(join(directory, "input.json"), "utf8")));
    },
    async readAttachment(source, attachment, signal) {
      signal.throwIfAborted();
      if (source.account !== input.account || source.sender !== "local" || attachment.source.platform !== "local-files"
        || attachment.source.documentId !== documentId) throw new Error("File channel reference is not authorized");
      return { data: await readFile(join(directory, attachment.source.documentId)), mediaType: "text/plain" };
    },
    async send(delivery, signal) {
      signal.throwIfAborted();
      await writeFile(join(directory, "output.txt"), delivery.text, { flag: "wx" });
      return { messageId: "output.txt" };
    },
  };
  const ingress = defineService({ id: "test.independent-channel-ingress", version: "1.0.0", scope: "host" });
  const accepted = Promise.withResolvers();
  host = await PluginHost.create({ plugins: [createDeliveryPlugin({ ingress })], services: [{ service: ingress, value: {
    store, async receive(received) { await store.put({ kind: "inbox", id: inboxId(received), input: received, processed: false }); accepted.resolve(); },
    onError(_account, error) { accepted.reject(error); },
  } }] });
  const unregister = host.get(deliveryServices.registry).register(adapter);
  await accepted.promise;
  const saved = store.get(inboxId(input));
  assert.deepEqual(saved.input.attachments[0].source, input.attachments[0].source);
  assert.equal(Buffer.from((await adapter.readAttachment(saved.input, saved.input.attachments[0], new AbortController().signal)).data).toString(), "Independent channel content");
  const delivery = { kind: "delivery", id: digest("independent-reply"), account: input.account, sender: input.sender, conversation: input.conversation, text: "Report received", status: "pending" };
  await store.put(delivery);
  await host.get(deliveryServices.delivery).attempt(adapter, delivery, { signal: new AbortController().signal,
    commit: (status, receipt) => store.put({ ...delivery, status, ...(receipt ? { messageId: receipt.messageId } : {}) }) });
  assert.equal(await readFile(join(directory, "output.txt"), "utf8"), delivery.text);
  assert.equal(store.get(delivery.id).status, "sent");
  await unregister();
  await host.close(); await store.close();
  assert.deepEqual((await ChannelStore.inspect(path)).find(record => record.id === inboxId(input)).input.attachments, input.attachments);
});

test("channel inspections remain readable while records are removed", async t => {
  const base = fileURLToPath(new URL("../../../../review/delivery-journal-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "readers-"));
  const path = join(directory, "channels.jsonl");
  const store = await ChannelStore.open(path);
  let stopped = false;
  let readers = [];
  t.after(async () => {
    stopped = true;
    await Promise.all(readers);
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const content = "x".repeat(4096);
  for (let index = 0; index < 64; index++) {
    await store.put({ kind: "delivery", id: digest(index), account: "account", sender: "sender", conversation: "conversation", text: content, status: "pending" });
  }
  readers = Array.from({ length: 8 }, async () => {
    let count = 64;
    while (!stopped) {
      const records = await ChannelStore.inspect(path);
      assert.ok(records.length <= count);
      assert.ok(records.every(record => record.text === content));
      count = records.length;
    }
  });
  try {
    for (let index = 0; index < 32; index++) await store.remove([digest(index)]);
  } finally { stopped = true; await Promise.all(readers); }
  assert.equal((await ChannelStore.inspect(path)).length, 32);
});

test("channel text preserves Unicode boundaries and bounded reads reject oversized bytes", async () => {
  const pages = channelTextPages("Reading 😃 documentation ".repeat(30), 64);
  assert.ok(pages.every(page => page.length <= 64));
  assert.equal(pages.map(page => page.slice(page.indexOf("\n") + 1)).join(""), "Reading 😃 documentation ".repeat(30));
  const text = "channel bytes";
  assert.equal(Buffer.from(await boundedBytes(new Response(text), 32)).toString(), text);
  await assert.rejects(boundedBytes(new Response(text), 3), /limit exceeded/);
});
