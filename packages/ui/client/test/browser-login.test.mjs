import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BrowserLogin } from "../dist/browser-login.js";

test("浏览器连接凭据只能兑换一次，关闭后失效", () => {
  const token = randomBytes(32).toString("base64url");
  const login = new BrowserLogin(token);
  const ticket = login.issue();
  assert.notEqual(ticket, token);
  assert.throws(() => login.redeem(randomBytes(32).toString("base64url")), { status: 401 });
  assert.ok(login.redeem(ticket) === token);
  assert.throws(() => login.redeem(ticket), { status: 401 });
  const pending = login.issue();
  login.clear();
  assert.throws(() => login.redeem(pending), { status: 401 });
});

test("浏览器连接凭据限制有效期和待连接数量", async () => {
  const login = new BrowserLogin(randomBytes(32).toString("base64url"));
  Array.from({ length: 8 }, () => login.issue());
  assert.throws(() => login.issue(), { status: 429 });
  const expiring = new BrowserLogin(randomBytes(32).toString("base64url"), 30);
  const ticket = expiring.issue();
  await delay(40);
  assert.throws(() => expiring.redeem(ticket), { status: 401 });
  const next = expiring.issue();
  assert.equal(typeof expiring.redeem(next), "string");
});
