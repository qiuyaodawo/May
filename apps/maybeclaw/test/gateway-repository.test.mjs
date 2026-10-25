import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { inboxId } from "../dist/channel-store.js";

const base = fileURLToPath(new URL("../../../review/gateway-repository/", import.meta.url));
const operator = { kind: "operator", id: "administrator" };

test("Gateway queries isolate actors and repository state survives reopen and session deletion", async t => {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "records-"));
  const settings = gatewaySettings({ apps: { maybeclaw: { version: 2, agents: [{ id: "reader", adapter: "may" }] } } });
  const options = { directory, settings, configPath: join(directory, "config.json") };
  let gateway = new AgentGateway(options);
  t.after(async () => {
    await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const entry = { account: "telegram:42", conversation: "7", kind: "private", owner: "7" };
  const actor = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: entry.owner };
  const session = gateway.createSession(operator, "Report", ["reader"], [], entry);
  const other = gateway.createSession(operator, "Other report", ["reader"], [], { ...entry, conversation: "8", owner: "8" });
  const message = gateway.record(session, { kind: "assistant", text: "Report complete", agentId: "reader" });
  gateway.record(other, { kind: "assistant", text: "Other report complete", agentId: "reader" });
  const deliveries = gateway.deliveries(actor);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].messageId, message.id);
  assert.throws(() => gateway.deliveries(actor, other.id), /无权访问/);
  assert.throws(() => gateway.configuration(actor), /管理员/);
  deliveries[0].text = "Changed snapshot";
  assert.match(gateway.deliveries(actor)[0].text, /Report complete/);
  const configuration = gateway.configuration(operator);
  configuration.agents.length = 0;
  assert.equal(gateway.configuration(operator).agents.length, 1);

  const input = { account: entry.account, sender: entry.owner, conversation: entry.conversation, eventId: "report-command", messageId: "source-message", text: "/status" };
  const id = inboxId(input);
  gateway.channels.acceptInput(input);
  assert.equal(gateway.channels.beginInput(id), true);
  gateway.channels.finishInput(id, { text: "Report status", sessionId: session.id }, ["Report status"],
    (change, sessionId) => gateway.recordChannelChange(change.input, change.originalState, sessionId));
  const reply = gateway.channels.replies()[0];
  gateway.channels.commitDelivery("reply", reply.id, "sending");
  gateway.channels.commitDelivery("reply", reply.id, "sent", { messageId: "reply-message" });
  const delivery = gateway.deliveries(actor)[0];
  gateway.channels.commitDelivery("current", delivery.id, "sending");
  gateway.channels.commitDelivery("current", delivery.id, "sent", { messageId: "assistant-message" });
  assert.equal(gateway.channels.platformMessage(entry, "assistant-message").agentId, "reader");
  assert.equal(gateway.channels.platformMessage(entry, "reply-message").sessionId, session.id);
  assert.throws(() => gateway.channels.commitDelivery("current", delivery.id, "sending"), /状态已经变化/);

  await gateway.close();
  gateway = new AgentGateway(options);
  assert.equal(gateway.channels.input(id).state, "done");
  assert.equal(gateway.channels.reply(reply.id).status, "sent");
  assert.equal(gateway.channels.platformMessage(entry, "assistant-message").sessionId, session.id);
  await gateway.manageSession(gateway.session(session.id, operator), operator, "delete", true);
  assert.equal(gateway.channels.input(id), undefined);
  assert.equal(gateway.channels.reply(reply.id), undefined);
  assert.equal(gateway.channels.platformMessage(entry, "reply-message"), undefined);
  assert.equal(gateway.channels.platformMessage(entry, "assistant-message"), undefined);
  assert.deepEqual(gateway.deliveries(actor), []);
  assert.equal(gateway.deliveries(operator).length, 1);
});
