import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CliError, openBrowser, parseArgs, runCli } from "../src/cli.mjs";
import { createAuthStore } from "../src/storage.mjs";

const AUTH = {
  version: 1,
  type: "oauth",
  access: "access",
  refresh: "refresh",
  expires: 99_999_999_999_999,
  uid: "42",
  accountId: "tester@example.com",
  email: "tester@example.com",
  name: "Tester",
};

async function sandbox() {
  return mkdtemp(join(tmpdir(), "atomcode-api-cli-"));
}

function io() {
  const lines = [];
  return {
    lines,
    out(line) {
      lines.push(String(line));
    },
    error(line) {
      lines.push(String(line));
    },
  };
}

function protocolFetch({ status = { codingplan_free: { plan_name: "Lite", remaining_days: 4 } } } = {}) {
  return async (url) => {
    const value = String(url);
    if (value.includes("raw.atomgit.com")) {
      return new Response('[workspace.package]\nversion = "5.2.3"\n');
    }
    if (value.includes("auth/login")) {
      return Response.json({ login_url: "https://atomgit.com/login", state: "state" });
    }
    if (value.includes("auth/check")) return Response.json({ valid: true });
    if (value.includes("auth/token")) {
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        user: { id: 42, email: "tester@example.com" },
      });
    }
    if (value.includes("status-v2")) return Response.json(status);
    if (value.includes("models-v2")) {
      return Response.json([{ display_model_name: "m1", context_window: 4096, supports_vision: true }]);
    }
    if (value.includes("claim-v2")) return Response.json({ success: true, plan_name: "Lite", plan_type: "Lite" });
    throw new Error(`unexpected URL: ${value}`);
  };
}

test("parseArgs handles commands, flags and errors", () => {
  assert.deepEqual(parseArgs(["serve", "--port", "9000", "--json"]), {
    command: "serve",
    options: { json: true, noOpen: false, port: 9000 },
  });
  assert.equal(parseArgs(["--version"]).options.version, true);
  assert.throws(() => parseArgs(["--port"]), CliError);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
  assert.throws(() => parseArgs(["models", "extra"]), /Unexpected argument/);
});

test("help, version and key do not require a signed-in account", async () => {
  const home = await sandbox();
  const helpOut = io();
  assert.equal(await runCli(["--help"], { io: helpOut, env: { ATOMCODE_API_HOME: home } }), 0);
  assert.match(helpOut.lines.join("\n"), /Usage:/);

  const versionOut = io();
  assert.equal(await runCli(["--version"], { io: versionOut, env: { ATOMCODE_API_HOME: home } }), 0);
  assert.match(versionOut.lines.join("\n"), /0\.1\.0/);

  const keyOut = io();
  await runCli(["key"], {
    io: keyOut,
    env: { ATOMCODE_API_HOME: home, ATOMCODE_API_KEY: "local-test-key" },
  });
  assert.deepEqual(keyOut.lines, ["local-test-key"]);
  const stored = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  assert.equal(stored.apiKey, "local-test-key");
});

test("login saves credentials, auto-claims the plan and never prints tokens", async () => {
  const home = await sandbox();
  const output = io();
  await runCli(["login", "--no-open"], {
    env: { ATOMCODE_API_HOME: home, ATOMCODE_API_KEY: "local-test-key" },
    io: output,
    fetchImpl: protocolFetch(),
  });
  const text = output.lines.join("\n");
  assert.match(text, /atomgit\.com\/login/);
  assert.match(text, /DONE: The plan is still active/);
  assert.doesNotMatch(text, /access|refresh/i);
  const auth = await createAuthStore({ home }).read();
  assert.equal(auth.uid, "42");
  assert.equal(auth.refresh, "refresh");
});

test("models, status and checkin print human and JSON output", async () => {
  const home = await sandbox();
  await createAuthStore({ home }).write(AUTH);
  const env = { ATOMCODE_API_HOME: home, ATOMCODE_API_KEY: "key" };

  const modelsOut = io();
  await runCli(["models", "--json"], {
    env,
    io: modelsOut,
    fetchImpl: protocolFetch(),
  });
  const models = JSON.parse(modelsOut.lines[0]);
  assert.equal(models.data[0].id, "m1");
  assert.equal(models.data[0].context_window, 4096);

  const humanModels = io();
  await runCli(["models"], { env, io: humanModels, fetchImpl: protocolFetch() });
  assert.match(humanModels.lines.join("\n"), /Source: live/);
  assert.match(humanModels.lines.join("\n"), /m1/);

  const statusOut = io();
  await runCli(["status"], { env, io: statusOut, fetchImpl: protocolFetch() });
  assert.match(statusOut.lines.join("\n"), /Plan: Lite/);
  assert.match(statusOut.lines.join("\n"), /Account: Tester/);

  const checkinOut = io();
  await runCli(["checkin", "--json"], { env, io: checkinOut, fetchImpl: protocolFetch() });
  assert.equal(JSON.parse(checkinOut.lines[0]).outcome, "done");
});

test("status reports signed-out state and logout clears credentials", async () => {
  const home = await sandbox();
  const statusOut = io();
  await runCli(["status"], {
    env: { ATOMCODE_API_HOME: home },
    io: statusOut,
    fetchImpl: protocolFetch(),
  });
  assert.match(statusOut.lines.join("\n"), /Not signed in/);

  await createAuthStore({ home }).write(AUTH);
  const logoutOut = io();
  await runCli(["logout"], {
    env: { ATOMCODE_API_HOME: home },
    io: logoutOut,
    fetchImpl: protocolFetch(),
  });
  assert.equal(await createAuthStore({ home }).read(), undefined);
});

test("unknown commands fail and browser launch tolerates spawn errors", async () => {
  const home = await sandbox();
  await assert.rejects(
    () =>
      runCli(["wat"], {
        env: { ATOMCODE_API_HOME: home },
        fetchImpl: protocolFetch(),
      }),
    /Unknown command/,
  );

  const child = { on() {}, unref() {} };
  assert.equal(openBrowser("https://atomgit.com/login", () => child), true);
  assert.equal(
    openBrowser("https://atomgit.com/login", () => {
      throw new Error("spawn failed");
    }),
    false,
  );
});
