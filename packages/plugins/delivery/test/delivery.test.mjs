import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PluginHost, defineService } from "@may/plugin";
import { ChannelStore, createDeliveryPlugin, deliveryServices, digest, inboxId, channelTextPages, boundedBytes } from "../dist/index.js";

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

test("channel text preserves Unicode boundaries and bounded reads reject oversized bytes", async () => {
  const pages = channelTextPages("Reading 😃 documentation ".repeat(30), 64);
  assert.ok(pages.every(page => page.length <= 64));
  assert.equal(pages.map(page => page.slice(page.indexOf("\n") + 1)).join(""), "Reading 😃 documentation ".repeat(30));
  const text = "channel bytes";
  assert.equal(Buffer.from(await boundedBytes(new Response(text), 32)).toString(), text);
  await assert.rejects(boundedBytes(new Response(text), 3), /limit exceeded/);
});
