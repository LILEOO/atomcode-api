import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_PORT = 8787;
const DEFAULT_API_KEY_PREFIX = "atc_";

export function atomCodeHome(env = process.env) {
  const configured = env.ATOMCODE_API_HOME;
  return configured ? resolve(configured) : join(homedir(), ".atomcode-api");
}

export function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

export function newApiKey() {
  return `${DEFAULT_API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

async function ensurePrivateDirectory(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => {});
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in ${path}`);
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function effectiveApiKey(configured, envValue) {
  if (typeof envValue === "string" && envValue.trim()) return envValue.trim();
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return newApiKey();
}

export async function loadOrCreateConfig({ home, env = process.env } = {}) {
  home = home ?? atomCodeHome(env);
  await ensurePrivateDirectory(home);
  const path = join(home, "config.json");
  const stored = (await readJson(path)) ?? {};
  const apiKey = effectiveApiKey(stored.apiKey, env.ATOMCODE_API_KEY);
  const port = parsePort(env.ATOMCODE_API_PORT, parsePort(stored.port, DEFAULT_PORT));
  const config = {
    version: 1,
    apiKey,
    port,
    clientVersion: typeof stored.clientVersion === "string" ? stored.clientVersion : undefined,
    autoVersion: stored.autoVersion !== false,
    masterKeyHex: typeof stored.masterKeyHex === "string" ? stored.masterKeyHex : undefined,
  };

  const changed =
    stored.version !== config.version ||
    stored.apiKey !== config.apiKey ||
    stored.port !== config.port ||
    stored.clientVersion !== config.clientVersion ||
    stored.autoVersion !== config.autoVersion ||
    stored.masterKeyHex !== config.masterKeyHex;
  if (changed) await atomicWriteJson(path, config);
  return { ...config, home, configPath: path };
}

function validAuth(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.access === "string" &&
      value.access &&
      value.uid !== undefined &&
      value.uid !== null &&
      value.uid !== "",
  );
}

export function createAuthStore({ home = atomCodeHome() } = {}) {
  const path = join(home, "auth.json");

  return {
    path,

    async read() {
      const value = await readJson(path);
      if (value === undefined) return undefined;
      if (!validAuth(value)) throw new Error(`invalid auth data in ${path}`);
      return value;
    },

    async write(value) {
      if (!validAuth(value)) throw new Error("refusing to persist incomplete auth data");
      await ensurePrivateDirectory(home);
      await atomicWriteJson(path, value);
    },

    async clear() {
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
