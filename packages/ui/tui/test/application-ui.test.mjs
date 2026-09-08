import assert from "node:assert/strict";
import test from "node:test";

import {
  ListSelectionModel,
  resolveListInput,
  SlashCommandRegistry,
} from "../dist/index.js";

test("parses, matches, and completes registered slash commands", async () => {
  const registry = new SlashCommandRegistry([
    {
      name: "/resume",
      aliases: ["/r"],
      usage: "/resume [id]",
      description: "Resume a session",
    },
    { name: "/quit", usage: "/quit", description: "Exit" },
  ]);

  const parsed = registry.parse(" /R one ");
  assert.equal(parsed.type, "command");
  assert.equal(parsed.definition.name, "/resume");
  assert.deepEqual(parsed.arguments, ["one"]);
  assert.deepEqual(registry.match("/re").map((item) => item.value), ["/resume"]);

  const suggest = registry.createSuggester(({ invokedAs, argumentPrefix }) => [
    { value: `${invokedAs} ${argumentPrefix}1`, label: `${argumentPrefix}1` },
  ]);
  assert.deepEqual(await suggest("/resume abc"), [
    { value: "/resume abc1", label: "abc1" },
  ]);
});

test("maintains reusable filtered list selection state", () => {
  const model = new ListSelectionModel(
    [{ id: "alpha" }, { id: "beta" }, { id: "bravo" }],
    {
      filter: (item, query) => item.id.includes(query),
      pageSize: 2,
    },
  );
  model.setQuery("b");
  assert.deepEqual(model.items.map((item) => item.id), ["beta", "bravo"]);
  model.move("down");
  assert.equal(model.selected?.id, "bravo");
  model.move("down");
  assert.equal(model.selected?.id, "beta");
  model.backspaceQuery();
  model.move("end");
  assert.equal(model.selected?.id, "bravo");
  assert.equal(resolveListInput(model.items, "2", (item) => item.id)?.id, "beta");
});
