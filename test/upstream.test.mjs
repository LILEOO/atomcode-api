import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertGatewayURL,
  createUpstreamClient,
  GATEWAY_ORIGIN,
} from "../src/upstream.mjs";

const AUTH = { access: "access", uid: "42", refresh: "refresh" };

function manager(overrides = {}) {
  return {
    async getValid() {
      return AUTH;
    },
    async refreshAfterUnauthorized() {
      return { ...AUTH, access: "renewed" };
    },
    ...overrides,
  };
}

test("gateway URL validation accepts only the official signed endpoint origin", () => {
  assert.equal(assertGatewayURL("https://llm-api.atomgit.com/v1/chat/completions").origin, GATEWAY_ORIGIN);
  for (const value of [
    "https://evil.example/v1",
    "http://llm-api.atomgit.com/v1",
    "https://user:pass@llm-api.atomgit.com/v1",
  ]) {
    assert.throws(() => assertGatewayURL(value), /Blocked request/);
  }
});

test("chat requests preserve body bytes and add AtomCode signature headers", async () => {
  let captured;
  const body = Buffer.from('{"model":"m1","messages":[{"role":"user","content":"中文"}]}');
  const client = createUpstreamClient({
    accountManager: manager(),
    clientVersion: async () => "5.2.3",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return Response.json({ ok: true });
    },
  });
  const result = await client.request({
    method: "POST",
    path: "/v1/chat/completions",
    body,
    accept: "text/event-stream",
  });
  assert.equal(result.response.status, 200);
  assert.equal(captured.url.origin, GATEWAY_ORIGIN);
  assert.equal(captured.url.pathname, "/v1/chat/completions");
  assert.equal(captured.init.body, body);
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.headers.get("authorization"), "Bearer access");
  assert.equal(captured.init.headers.get("user-agent"), "atomcode/5.2.3");
  assert.equal(captured.init.headers.get("accept"), "text/event-stream");
  assert.match(captured.init.headers.get("x-atomcode-sig"), /^v1:[0-9a-f]{64}$/);
  result.cleanup();
});

test("upstream 401 refreshes and retries with a new signature exactly once", async () => {
  const calls = [];
  let refreshes = 0;
  const client = createUpstreamClient({
    accountManager: manager({
      async refreshAfterUnauthorized() {
        refreshes += 1;
        return { ...AUTH, access: "renewed" };
      },
    }),
    clientVersion: async () => "5.2.3",
    fetchImpl: async (_url, init) => {
      calls.push(init.headers.get("authorization"));
      return calls.length === 1
        ? Response.json({ error: "expired" }, { status: 401 })
        : Response.json({ ok: true });
    },
  });
  const result = await client.request({ body: Buffer.from("{}") });
  assert.equal(result.response.status, 200);
  assert.deepEqual(calls, ["Bearer access", "Bearer renewed"]);
  assert.equal(refreshes, 1);
  result.cleanup();
});

test("upstream 401 is preserved when refresh fails or no refresh token exists", async () => {
  const failedRefresh = createUpstreamClient({
    accountManager: manager({
      async refreshAfterUnauthorized() {
        throw new Error("no refresh");
      },
    }),
    clientVersion: async () => "5.2.3",
    fetchImpl: async () => Response.json({ error: "expired" }, { status: 401 }),
  });
  const first = await failedRefresh.request({ body: Buffer.from("{}") });
  assert.equal(first.response.status, 401);
  first.cleanup();

  const noRefresh = createUpstreamClient({
    accountManager: manager(),
    clientVersion: async () => "5.2.3",
    fetchImpl: async () => Response.json({ error: "expired" }, { status: 401 }),
  });
  const second = await noRefresh.request({ body: Buffer.from("{}") });
  assert.equal(second.response.status, 401);
  second.cleanup();
});

test("downstream abort is propagated to the upstream fetch", async () => {
  const controller = new AbortController();
  const client = createUpstreamClient({
    accountManager: manager(),
    clientVersion: async () => "5.2.3",
    fetchImpl: async (_url, init) => {
      if (init.signal.aborted) throw init.signal.reason;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const pending = client.request({ body: Buffer.from("{}"), signal: controller.signal });
  controller.abort(new Error("client left"));
  await assert.rejects(pending, /client left/);
});
