import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  atomCodeHome,
  createAuthStore,
  loadOrCreateConfig,
  newApiKey,
  parsePort,
} from "../src/storage.mjs";

async function tempHome() {
  return mkdtemp(join(tmpdir(), "atomcode-api-storage-"));
}

test("atomCodeHome honours ATOMCODE_API_HOME and resolves relative paths", () => {
  assert.match(atomCodeHome({ ATOMCODE_API_HOME: "/tmp/atomcode-test" }), /atomcode-test$/);
  assert.match(atomCodeHome({ ATOMCODE_API_HOME: "relative-home" }), /relative-home$/);
  assert.match(atomCodeHome({}), /\.atomcode-api$/);
});

test("parsePort validates bounds and fallbacks", () => {
  assert.equal(parsePort(undefined), 8787);
  assert.equal(parsePort(""), 8787);
  assert.equal(parsePort("9000"), 9000);
  for (const value of [0, 65536, "abc", 1.5]) {
    assert.throws(() => parsePort(value), /invalid port/);
  }
});

test("newApiKey has an identifiable prefix and high entropy", () => {
  const a = newApiKey();
  const b = newApiKey();
  assert.match(a, /^atc_[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(a, b);
});

test("config is generated once with private permissions and environment overrides win", async () => {
  const home = await tempHome();
  const first = await loadOrCreateConfig({ home, env: {} });
  assert.equal(first.port, 8787);
  assert.match(first.apiKey, /^atc_/);
  assert.equal((await stat(join(home, "config.json"))).mode & 0o777, 0o600);

  const second = await loadOrCreateConfig({
    home,
    env: { ATOMCODE_API_KEY: "env-key", ATOMCODE_API_PORT: "9123" },
  });
  assert.equal(second.apiKey, "env-key");
  assert.equal(second.port, 9123);

  const stored = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  assert.equal(stored.apiKey, "env-key");
  assert.equal(stored.port, 9123);
});

test("config preserves advanced options and rejects malformed JSON/ports", async () => {
  const home = await tempHome();
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      apiKey: "stored-key",
      port: 8100,
      clientVersion: "6.0.0",
      autoVersion: false,
      masterKeyHex: "a".repeat(64),
    }),
  );
  const config = await loadOrCreateConfig({ home, env: {} });
  assert.equal(config.clientVersion, "6.0.0");
  assert.equal(config.autoVersion, false);
  assert.equal(config.masterKeyHex, "a".repeat(64));

  await assert.rejects(
    () => loadOrCreateConfig({ home, env: { ATOMCODE_API_PORT: "bad" } }),
    /invalid port/,
  );
  await writeFile(join(home, "config.json"), "{");
  await assert.rejects(() => loadOrCreateConfig({ home, env: {} }), /invalid JSON/);
});

test("auth store reads, writes atomically, rejects incomplete data and clears", async () => {
  const home = await tempHome();
  const store = createAuthStore({ home });
  assert.equal(await store.read(), undefined);

  const auth = { access: "access", uid: "1", refresh: "refresh", expires: 123 };
  await store.write(auth);
  assert.deepEqual(await store.read(), auth);
  assert.equal((await stat(join(home, "auth.json"))).mode & 0o777, 0o600);

  await assert.rejects(() => store.write({ access: "access" }), /incomplete auth/);
  await writeFile(join(home, "auth.json"), JSON.stringify({ access: "access" }));
  await assert.rejects(() => store.read(), /invalid auth data/);

  await store.clear();
  assert.equal(await store.read(), undefined);
  await store.clear();
});
