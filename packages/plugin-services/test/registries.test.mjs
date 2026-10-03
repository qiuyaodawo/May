import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import test from "node:test";
import { ContextWrappers, InstructionSources, ToolSources } from "../dist/index.js";
import { InMemoryContextFactory } from "../../context/dist/index.js";

test("ordered tool contributions execute actual file resources and snapshots retain their catalog", async t => {
  const file = await open(new URL("../../../README.md", import.meta.url), "r");
  t.after(() => file.close());
  const sources = new ToolSources();
  const tool = name => ({ name, description: "Read repository documentation", inputSchema: { type: "object" },
    async execute() { return (await file.stat()).size; },
  });
  const removeLater = sources.add(() => [tool("later")], { id: "later", pluginOrder: 20 });
  sources.add(() => [tool("earlier")], { id: "earlier", pluginOrder: 10 });
  sources.add(() => [tool("ordered")], { id: "ordered", order: -1, pluginOrder: 30 });
  const snapshot = sources.snapshot();
  assert.deepEqual(snapshot.names(), ["ordered", "earlier", "later"]);
  removeLater(); removeLater();
  assert.deepEqual(sources.snapshot().names(), ["ordered", "earlier"]);
  assert.ok(await snapshot.require("later").execute({}, { signal: new AbortController().signal }) > 0);
  assert.throws(() => sources.add(() => [], { id: "earlier" }), /Duplicate contribution/);
  const removeDuplicate = sources.add(() => [tool("earlier")], { id: "duplicate" });
  assert.throws(() => sources.snapshot(), /Duplicate tool name/);
  removeDuplicate();
  assert.equal(sources.snapshot().size, 2);
});

test("instructions execute in deterministic order and reject invalid content", () => {
  const instructions = new InstructionSources();
  instructions.add(() => "later", { id: "later", pluginOrder: 4 });
  let text = "earlier";
  const remove = instructions.add(() => text, { id: "earlier", pluginOrder: 2 });
  assert.equal(instructions.snapshot(), "earlier\n\nlater");
  text = "updated";
  assert.equal(instructions.snapshot(), "updated\n\nlater");
  remove();
  assert.equal(instructions.snapshot(), "later");
  assert.throws(() => instructions.add(() => "", { id: "invalid", order: Infinity }), /finite/);
  instructions.add(() => undefined, { id: "invalid" });
  assert.throws(() => instructions.snapshot(), /must return a string/);
});

test("Context wrappers apply in declaration order and create independent real contexts", async () => {
  const wrappers = new ContextWrappers();
  const observed = [];
  const wrap = name => factory => ({ create(options) {
    observed.push(name);
    return factory.create({ ...options, instructions: `${options.instructions ?? ""}:${name}` });
  } });
  wrappers.add(wrap("later"), { id: "later", pluginOrder: 20 });
  const remove = wrappers.add(wrap("earlier"), { id: "earlier", pluginOrder: 10 });
  const base = new InMemoryContextFactory();
  const first = wrappers.apply(base).create({ instructions: "first" });
  const second = wrappers.apply(base).create({ instructions: "second" });
  assert.deepEqual(observed, ["later", "earlier", "later", "earlier"]);
  assert.equal((await first.context.snapshot()).instructions, "first:later:earlier");
  assert.equal((await second.context.snapshot()).instructions, "second:later:earlier");
  remove();
  assert.equal((await wrappers.apply(base).create({}).context.snapshot()).instructions, ":later");
  wrappers.add(() => undefined, { id: "invalid" });
  assert.throws(() => wrappers.apply(base), /must return a ContextFactory/);
});
