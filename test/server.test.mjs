import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";

import {
  bearerToken,
  createGatewayServer,
  isLoopbackHost,
} from "../src/server.mjs";

const KEY = "local-key";

function accountManager(authenticated = true) {
  return {
    async peek() {
      return authenticated ? { access: "secret" } : undefined;
    },
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function withServer(deps, fn) {
  const server = createGatewayServer({
    apiKey: KEY,
    accountManager: accountManager(),
    modelService: {
      async openAIList() {
        return { object: "list", data: [{ id: "m1", object: "model", owned_by: "atomcode" }] };
      },
    },
    upstream: {
      async request() {
        return {
          response: Response.json({ id: "chat-1", choices: [] }),
          cleanup() {},
          abort() {},
        };
      },
    },
    logger: { warn() {}, error() {} },
    ...deps,
  });
  const base = await listen(server);
  try {
    return await fn(base, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("bearerToken and loopback Host validation are strict", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), undefined);
  assert.equal(bearerToken(undefined), undefined);
  assert.equal(isLoopbackHost("127.0.0.1:8787", 8787), true);
  assert.equal(isLoopbackHost("localhost:8787", 8787), true);
  assert.equal(isLoopbackHost("[::1]:8787", 8787), true);
  assert.equal(isLoopbackHost("127.0.0.1:9999", 8787), false);
  assert.equal(isLoopbackHost("evil.example:8787", 8787), false);
  assert.equal(isLoopbackHost(undefined, 8787), false);
  assert.equal(isLoopbackHost("not a host", 8787), false);
});

test("health is public, reports auth state and rejects non-loopback hosts", async () => {
  await withServer({}, async (base, server) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, authenticated: true, version: "0.1.0" });

    const port = server.address().port;
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/healthz",
          headers: { host: `evil.example:${port}` },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "host_forbidden");
  });
});

test("models endpoint requires the local key and returns OpenAI model shape", async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    const response = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, "m1");
  });
});

test("chat forwards the exact body and streams the upstream response", async () => {
  let forwarded;
  const encoder = new TextEncoder();
  const upstream = {
    async request(request) {
      forwarded = request;
      return {
        response: new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: first\n\n"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
        cleanup() {},
        abort() {},
      };
    },
  };
  await withServer({ upstream }, async (base) => {
    const body = '{"model":"m1","stream":true,"messages":[{"role":"user","content":"你好"}]}';
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: first\n\ndata: [DONE]\n\n");
    assert.equal(forwarded.body.toString("utf8"), body);
    assert.equal(forwarded.accept, "text/event-stream");
  });
});

test("chat validates JSON/model, body size and methods", async () => {
  await withServer({ maxBodyBytes: 20 }, async (base) => {
    const headers = {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    };
    const invalid = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: "{",
    });
    assert.equal(invalid.status, 400);

    const missingModel = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(missingModel.status, 400);

    const large = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "m1", messages: ["x".repeat(100)] }),
    });
    assert.equal(large.status, 413);

    const wrongMethod = await fetch(`${base}/v1/chat/completions`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    assert.equal(wrongMethod.status, 405);
  });
});

test("server maps account, upstream and route failures to OpenAI errors", async () => {
  const throwingUpstream = {
    async request() {
      throw Object.assign(new Error("No AtomCode account is signed in"), {
        status: 401,
        code: "not_authenticated",
      });
    },
  };
  await withServer({ upstream: throwingUpstream }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: '{"model":"m1"}',
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "not_authenticated");
  });

  await withServer(
    {
      upstream: {
        async request() {
          throw new Error("network down");
        },
      },
    },
    async (base) => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: '{"model":"m1"}',
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, "upstream_error");
    },
  );

  await withServer({}, async (base) => {
    const response = await fetch(`${base}/missing`);
    assert.equal(response.status, 404);
  });
});

test("health reports unauthenticated and model service failures stay retryable", async () => {
  await withServer(
    {
      accountManager: accountManager(false),
      modelService: {
        async openAIList() {
          throw Object.assign(new Error("not signed in"), { status: 401, code: "not_authenticated" });
        },
      },
    },
    async (base) => {
      assert.equal((await (await fetch(`${base}/healthz`)).json()).authenticated, false);
      const response = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      assert.equal(response.status, 401);
    },
  );
});

test("client disconnect aborts an upstream request that is still waiting for headers", async () => {
  let upstreamAborted;
  const aborted = new Promise((resolve) => {
    upstreamAborted = resolve;
  });
  const upstream = {
    async request({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            upstreamAborted(true);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  await withServer({ upstream }, async (base, server) => {
    const port = server.address().port;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
    });
    req.on("error", () => {});
    req.end('{"model":"m1"}');
    await new Promise((resolve) => setTimeout(resolve, 10));
    req.destroy();
    assert.equal(await Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("abort timeout")), 500)),
    ]), true);
  });
});
