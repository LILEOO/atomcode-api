import { test } from "node:test";
import assert from "node:assert/strict";

import { createModelService } from "../src/models-service.mjs";

const AUTH = { access: "access", uid: "42" };

function accountManager(overrides = {}) {
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

function catalogFetch({ status = {}, models = [], failModels, onAuthorization } = {}) {
  return async (url, init) => {
    if (String(url).includes("status-v2")) {
      if (status instanceof Error) throw status;
      return new Response(JSON.stringify(status.body ?? {}), { status: status.code ?? 200 });
    }
    if (String(url).includes("models-v2")) {
      onAuthorization?.(init.headers.authorization);
      if (failModels) throw failModels;
      return new Response(JSON.stringify(models), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

test("model service returns live catalog and OpenAI model metadata", async () => {
  const manager = accountManager();
  const service = createModelService({
    accountManager: manager,
    codingPlanBase: "https://plan.example",
    clientVersion: async () => "5.2.3",
    fetchImpl: catalogFetch({
      status: { body: { codingplan_free: { plan_name: "Lite" } } },
      models: [
        {
          display_model_name: "qwen/test",
          context_window: 1000,
          supports_vision: true,
          reasoning_effort_levels: ["low"],
        },
      ],
    }),
    logger: { warn() {} },
  });

  const result = await service.list();
  assert.equal(result.source, "live");
  assert.equal(result.models[0].id, "qwen/test");
  const list = await service.openAIList();
  assert.equal(list.object, "list");
  assert.equal(list.data[0].id, "qwen/test");
  assert.equal(list.data[0].owns_by, undefined);
  assert.equal(list.data[0].owned_by, "atomcode");
  assert.equal(list.data[0].context_window, 1000);
  assert.equal(list.data[0].supports_vision, true);
});

test("catalog is cached for the configured TTL", async () => {
  let calls = 0;
  const service = createModelService({
    accountManager: accountManager(),
    codingPlanBase: "https://plan.example",
    clientVersion: async () => "5.2.3",
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes("status-v2")) return Response.json({ codingplan_free: { plan_name: "Lite" } });
      return Response.json([{ display_model_name: "m1" }]);
    },
    logger: { warn() {} },
  });
  await service.list();
  await service.list();
  assert.equal(calls, 2, "one status and one models request total");
});

test("401 refreshes once and retries model discovery", async () => {
  let statusCalls = 0;
  let refreshed = 0;
  const service = createModelService({
    accountManager: accountManager({
      async refreshAfterUnauthorized() {
        refreshed += 1;
        return { ...AUTH, access: "renewed" };
      },
    }),
    codingPlanBase: "https://plan.example",
    clientVersion: async () => "5.2.3",
    fetchImpl: async (url, init) => {
      if (String(url).includes("status-v2")) {
        statusCalls += 1;
        return statusCalls === 1
          ? Response.json({}, { status: 401 })
          : Response.json({ codingplan_free: { plan_name: "Lite" } });
      }
      assert.equal(init.headers.authorization, "Bearer renewed");
      return Response.json([{ display_model_name: "m1" }]);
    },
    logger: { warn() {} },
  });
  const result = await service.list();
  assert.equal(result.source, "live");
  assert.equal(refreshed, 1);
});

test("transient discovery failure falls back, then last live data wins over fallback", async () => {
  let fail = false;
  const service = createModelService({
    accountManager: accountManager(),
    codingPlanBase: "https://plan.example",
    clientVersion: async () => "5.2.3",
    ttlMs: 0,
    fetchImpl: async (url) => {
      if (fail) throw new Error("offline");
      if (String(url).includes("status-v2")) return Response.json({ codingplan_free: { plan_name: "Lite" } });
      return Response.json([{ display_model_name: "live-model", context_window: 2048 }]);
    },
    logger: { warn() {} },
  });
  assert.equal((await service.list()).source, "live");
  fail = true;
  const cached = await service.list();
  assert.equal(cached.source, "cache");
  assert.equal(cached.models[0].id, "live-model");

  const cold = createModelService({
    accountManager: accountManager(),
    codingPlanBase: "https://plan.example",
    clientVersion: async () => "5.2.3",
    fetchImpl: async () => {
      throw new Error("offline");
    },
    logger: { warn() {} },
  });
  const fallback = await cold.list();
  assert.equal(fallback.source, "fallback");
  assert.ok(fallback.models.some((model) => model.id === "qwen3.8-27b"));
});

test("empty live catalog is treated as fallback", async () => {
  let calls = 0;
  const service = createModelService({
    accountManager: accountManager(),
    codingPlanBase: "https://plan.example",
    clientVersion: async () => "5.2.3",
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes("status-v2")) return Response.json({ codingplan_free: { plan_name: "Lite" } });
      return Response.json([]);
    },
    logger: { warn() {} },
  });
  assert.equal((await service.list()).source, "fallback");
  assert.equal(calls, 2);
});
