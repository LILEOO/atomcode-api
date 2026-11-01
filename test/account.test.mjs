import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AccountError,
  claimPlan,
  createAccountManager,
  signInWithOAuth,
} from "../src/account.mjs";

function memoryStore(initial) {
  let value = initial;
  return {
    writes: [],
    async read() {
      return value;
    },
    async write(next) {
      value = next;
      this.writes.push(next);
    },
    async clear() {
      value = undefined;
    },
  };
}

const AUTH = {
  access: "old-access",
  refresh: "old-refresh",
  uid: "42",
  expires: 10_000,
};

test("account manager reports missing auth and rejects an expired record without refresh", async () => {
  const missing = createAccountManager({
    store: memoryStore(undefined),
    oauthBase: "https://oauth.example",
  });
  await assert.rejects(() => missing.getValid(), (error) => error.code === "not_authenticated");

  const expired = createAccountManager({
    store: memoryStore({ access: "old", uid: "1", expires: 1 }),
    oauthBase: "https://oauth.example",
    now: () => 1000,
  });
  await assert.rejects(() => expired.getValid(), (error) => error.signIn === "expired");
});

test("account manager leaves a still-valid record untouched when it cannot refresh", async () => {
  let reads = 0;
  const store = memoryStore({ access: "valid", uid: "1", expires: 10_000 });
  const manager = createAccountManager({
    store,
    oauthBase: "https://oauth.example",
    now: () => 5000,
    refreshSkewMs: 1000,
  });
  const auth = await manager.getValid();
  reads += 1;
  assert.equal(auth.access, "valid");
  assert.equal(reads, 1);
});

test("expiring tokens are refreshed once and persisted with the rotated refresh token", async () => {
  const store = memoryStore(AUTH);
  let calls = 0;
  const manager = createAccountManager({
    store,
    oauthBase: "https://oauth.example",
    now: () => 10_000,
    refreshImpl: async (_base, refreshToken) => {
      calls += 1;
      assert.equal(refreshToken, "old-refresh");
      return { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 };
    },
  });
  const [first, second] = await Promise.all([manager.getValid(), manager.getValid()]);
  assert.equal(calls, 1);
  assert.equal(first.access, "new-access");
  assert.equal(second.refresh, "new-refresh");
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].expires, 3_610_000);
});

test("refresh failures distinguish expired sign-in from transient failures", async () => {
  const expired = createAccountManager({
    store: memoryStore(AUTH),
    oauthBase: "https://oauth.example",
    now: () => 10_000,
    refreshImpl: async () => {
      throw Object.assign(new Error("expired"), { signIn: "expired" });
    },
  });
  await assert.rejects(
    () => expired.getValid(),
    (error) => error instanceof AccountError && error.code === "sign_in_expired",
  );

  const transient = createAccountManager({
    store: memoryStore(AUTH),
    oauthBase: "https://oauth.example",
    now: () => 10_000,
    refreshImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    () => transient.getValid(),
    (error) => error.code === "refresh_failed" && error.status === 503,
  );

  const stillFresh = createAccountManager({
    store: memoryStore({ ...AUTH, expires: 70_000 }),
    oauthBase: "https://oauth.example",
    now: () => 10_000,
    refreshImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal((await stillFresh.getValid()).access, "old-access");
});

test("refreshAfterUnauthorized always uses the refresh token", async () => {
  const manager = createAccountManager({
    store: memoryStore({ access: "still-valid", uid: "1", refresh: "r", expires: 99_999 }),
    oauthBase: "https://oauth.example",
    refreshImpl: async () => ({ accessToken: "next", refreshToken: "r2", expiresIn: 1 }),
  });
  assert.equal((await manager.refreshAfterUnauthorized(AUTH)).access, "next");
});

test("claimPlan reports active, freshly claimed, duplicate and failed plans", async () => {
  const activeFetch = async (url) => {
    assert.match(String(url), /status-v2$/);
    return Response.json({
      codingplan_free: { plan_name: "Lite", remaining_days: 2 },
    });
  };
  const active = await claimPlan({
    auth: AUTH,
    codingPlanBase: "https://plan.example",
    clientVersion: "5.2.3",
    fetchImpl: activeFetch,
  });
  assert.equal(active.outcome, "done");

  const claimed = await claimPlan({
    auth: AUTH,
    codingPlanBase: "https://plan.example",
    clientVersion: "5.2.3",
    fetchImpl: async (url, init) => {
      if (String(url).includes("status-v2")) return Response.json({});
      if (String(url).includes("claim-v2")) {
        assert.equal(JSON.parse(init.body).plan_type, "Max");
        return Response.json({ success: true, plan_name: "Max", plan_type: "Max" });
      }
      throw new Error("unexpected");
    },
  });
  assert.equal(claimed.outcome, "claimed");
  assert.match(claimed.message, /Max/);
});

test("claimPlan maps duplicate and failed claims without throwing", async () => {
  const duplicate = await claimPlan({
    auth: AUTH,
    codingPlanBase: "https://plan.example",
    clientVersion: "5.2.3",
    fetchImpl: async (url) => {
      if (String(url).includes("status-v2")) return Response.json({});
      return Response.json({ duplicate: true, plan_type: "Lite" });
    },
  });
  assert.equal(duplicate.outcome, "done");

  const failed = await claimPlan({
    auth: AUTH,
    codingPlanBase: "https://plan.example",
    clientVersion: "5.2.3",
    fetchImpl: async (url) => {
      if (String(url).includes("status-v2")) return Response.json({});
      return Response.json({ message: "quota full" }, { status: 400 });
    },
  });
  assert.equal(failed.outcome, "failed");
  assert.match(failed.message, /quota full/);
});

test("claimPlan handles no account, expired status and transient status errors", async () => {
  assert.equal(
    (await claimPlan({ auth: undefined, codingPlanBase: "https://x", clientVersion: "v" })).outcome,
    "failed",
  );

  const expired = await claimPlan({
    auth: AUTH,
    codingPlanBase: "https://x",
    clientVersion: "v",
    fetchImpl: async () => Response.json({}, { status: 401 }),
  });
  assert.equal(expired.outcome, "failed");

  let claimCalls = 0;
  const transient = await claimPlan({
    auth: AUTH,
    codingPlanBase: "https://x",
    clientVersion: "v",
    fetchImpl: async (url) => {
      if (String(url).includes("status-v2")) return new Response("offline", { status: 503 });
      claimCalls += 1;
      return Response.json({ success: true, plan_name: "Lite", plan_type: "Lite" });
    },
  });
  assert.equal(transient.outcome, "claimed");
  assert.equal(claimCalls, 1);
});

test("OAuth sign-in polls, persists credentials and claims the plan", async () => {
  const store = memoryStore(undefined);
  const checks = [false, true];
  const urls = [];
  const result = await signInWithOAuth({
    store,
    oauthBase: "https://oauth.example",
    codingPlanBase: "https://plan.example",
    clientVersion: "5.2.3",
    now: () => 1_000,
    sleep: async () => {},
    timeoutMs: 100,
    startLoginImpl: async () => ({ loginUrl: "https://atomgit.com/login", state: "s" }),
    checkLoginImpl: async () => checks.shift(),
    tokenForImpl: async () => ({
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 60,
      user: { id: 7, email: "a@example.com" },
    }),
    onLoginUrl: async (url) => urls.push(url),
    fetchImpl: async (url) => {
      if (String(url).includes("status-v2")) {
        return Response.json({ codingplan_free: { plan_name: "Lite", remaining_days: 2 } });
      }
      throw new Error("unexpected");
    },
  });
  assert.deepEqual(urls, ["https://atomgit.com/login"]);
  assert.equal(result.auth.uid, "7");
  assert.equal(result.auth.expires, 61_000);
  assert.equal(result.claim.outcome, "done");
  assert.deepEqual(await store.read(), result.auth);
});

test("OAuth sign-in times out without persisting credentials", async () => {
  const store = memoryStore(undefined);
  await assert.rejects(
    () =>
      signInWithOAuth({
        store,
        oauthBase: "https://oauth.example",
        codingPlanBase: "https://plan.example",
        clientVersion: "5.2.3",
        now: () => 100,
        timeoutMs: 0,
        startLoginImpl: async () => ({ loginUrl: "https://atomgit.com/login", state: "s" }),
        checkLoginImpl: async () => false,
      }),
    /timed out/,
  );
  assert.equal(store.writes.length, 0);
});
