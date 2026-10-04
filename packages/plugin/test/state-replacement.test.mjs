import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { definePlugin, defineService, PluginHost } from "../dist/index.js";

const output = fileURLToPath(new URL("../.test-output/", import.meta.url));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

for (const scope of ["application", "session"]) {
  for (const method of ["set", "update"]) {
    test(`${scope} 插件替换保留正在保存的 ${method} 状态更新`, async t => {
      await mkdir(output, { recursive: true });
      const directory = await mkdtemp(join(output, "state-replacement-"));
      const file = join(directory, "state.json");
      const writing = deferred();
      const release = deferred();
      let disposed = 0;
      let saveTail = Promise.resolve();
      const service = defineService({ id: "verification.state", version: "1.0.0", scope });
      const plugin = definePlugin({
        id: "verification.state", version: "1.0.0", scope, provides: [service],
        state: { version: 1, initial: { count: 0 } },
        setup(context) {
          context.provide(service, context.state);
          return () => { disposed++; };
        },
      });
      const host = await PluginHost.create({ plugins: [plugin] });
      t.after(async () => {
        release.resolve();
        await host.close();
        await rm(directory, { recursive: true, force: true });
      });
      const scopeOptions = {
        id: scope,
        onStateChange(snapshot) {
          const result = saveTail.then(async () => {
            if (snapshot[plugin.id].value.count === 1) {
              writing.resolve();
              await release.promise;
            }
            await writeFile(file, JSON.stringify(snapshot));
          });
          saveTail = result;
          return result;
        },
      };
      const application = await host.createScope("application", scope === "application" ? scopeOptions : { id: "application" });
      const owner = scope === "application" ? application : await application.createScope("session", scopeOptions);
      const state = owner.get(service);
      const update = method === "set" ? state.set({ count: 1 }) : state.update(value => ({ count: value.count + 1 }));
      await writing.promise;
      const replacing = application.replacePlugins([plugin]);
      await setImmediate();
      assert.equal(disposed, 0);
      await assert.rejects(state.set({ count: 2 }), /暂停接受新的状态写入/u);
      release.resolve();
      await Promise.all([update, replacing]);
      assert.deepEqual(owner.get(service).get(), { count: 1 });
      assert.deepEqual(JSON.parse(await readFile(file, "utf8"))[plugin.id].value, { count: 1 });
      assert.equal(disposed, 1);
    });
  }
}

test("插件替换等待活动操作完成状态写入", async t => {
  const entered = deferred();
  const release = deferred();
  const service = defineService({ id: "verification.active-state", version: "1.0.0", scope: "application" });
  const plugin = definePlugin({
    id: "verification.active-state", version: "1.0.0", provides: [service],
    state: { version: 1, initial: { count: 0 } },
    setup(context) { context.provide(service, context.state); },
  });
  const host = await PluginHost.create({ plugins: [plugin] });
  t.after(async () => { release.resolve(); await host.close(); });
  const application = await host.createScope("application", { id: "application" });
  const state = application.get(service);
  const operation = application.use(async () => {
    entered.resolve();
    await release.promise;
    await state.set({ count: 1 });
  });
  await entered.promise;
  const replacing = application.replacePlugins([plugin]);
  await setImmediate();
  release.resolve();
  await Promise.all([operation, replacing]);
  assert.deepEqual(application.get(service).get(), { count: 1 });
});

test("替换插件的 setup 能够更新已经保存的状态", async t => {
  const entered = deferred();
  const release = deferred();
  const service = defineService({ id: "verification.setup-state", version: "1.0.0", scope: "application" });
  const plugin = definePlugin({
    id: "verification.setup-state", version: "1.0.0", provides: [service], config: { increment: 0 },
    state: { version: 1, initial: { count: 0 } },
    async setup(context) {
      await context.state.update(value => ({ count: value.count + context.config.increment }));
      context.provide(service, context.state);
    },
  });
  const host = await PluginHost.create({ plugins: [plugin] });
  t.after(async () => { release.resolve(); await host.close(); });
  const application = await host.createScope("application", { id: "application" });
  const updating = application.get(service).update(async value => {
    entered.resolve();
    await release.promise;
    return { count: value.count + 1 };
  });
  await entered.promise;
  const queued = application.get(service).update(value => ({ count: value.count + 1 }));
  const replacing = application.replacePlugins([{ ...plugin, config: { increment: 5 } }]);
  await setImmediate();
  release.resolve();
  await Promise.all([updating, queued, replacing]);
  assert.deepEqual(application.get(service).get(), { count: 7 });
});

test("插件关闭等待已经接受的状态保存完成后清理资源", async t => {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "state-close-"));
  const file = join(directory, "state.json");
  const writing = deferred();
  const release = deferred();
  let savedAtCleanup;
  const service = defineService({ id: "verification.closing-state", version: "1.0.0", scope: "application" });
  const plugin = definePlugin({
    id: "verification.closing-state", version: "1.0.0", provides: [service],
    state: { version: 1, initial: { count: 0 } },
    setup(context) {
      context.provide(service, context.state);
      return async () => { savedAtCleanup = JSON.parse(await readFile(file, "utf8"))[plugin.id].value; };
    },
  });
  const host = await PluginHost.create({ plugins: [plugin] });
  t.after(async () => { release.resolve(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  const application = await host.createScope("application", {
    id: "application",
    async onStateChange(snapshot) {
      if (snapshot[plugin.id].value.count === 1) { writing.resolve(); await release.promise; }
      await writeFile(file, JSON.stringify(snapshot));
    },
  });
  const updating = application.get(service).set({ count: 1 });
  await writing.promise;
  const closing = application.close();
  await setImmediate();
  assert.equal(savedAtCleanup, undefined);
  release.resolve();
  await Promise.all([updating, closing]);
  assert.deepEqual(savedAtCleanup, { count: 1 });
});
