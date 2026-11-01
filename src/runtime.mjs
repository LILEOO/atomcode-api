import { createAccountManager } from "./account.mjs";
import { createModelService } from "./models-service.mjs";
import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_CODING_PLAN_API_URL,
  DEFAULT_PLATFORM_BASE_URL,
} from "./protocol/internal.mjs";
import { MASTER_KEY_HEX } from "./protocol/sign.mjs";
import { createVersionSource } from "./protocol/version.mjs";
import { createAuthStore, loadOrCreateConfig } from "./storage.mjs";
import { createUpstreamClient } from "./upstream.mjs";

function configuredMasterKey(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : MASTER_KEY_HEX;
}

export async function createRuntime({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  now = Date.now,
} = {}) {
  const config = await loadOrCreateConfig({ env });
  const store = createAuthStore({ home: config.home });
  const accountManager = createAccountManager({
    store,
    oauthBase: DEFAULT_PLATFORM_BASE_URL,
    now,
  });
  const fallbackVersion = config.clientVersion || DEFAULT_CLIENT_VERSION;
  const versions = createVersionSource({
    fallback: fallbackVersion,
    fetchImpl,
    onError: (error) => logger.warn?.(`AtomCode version refresh failed: ${error.message}`),
  });
  if (config.autoVersion) versions.poke();
  const clientVersion = () =>
    config.autoVersion ? versions.ensure() : Promise.resolve(fallbackVersion);
  const modelService = createModelService({
    accountManager,
    codingPlanBase: DEFAULT_CODING_PLAN_API_URL,
    clientVersion,
    fetchImpl,
    logger,
  });
  const upstream = createUpstreamClient({
    accountManager,
    clientVersion,
    fetchImpl,
    masterKeyHex: configuredMasterKey(config.masterKeyHex),
  });

  return {
    config,
    store,
    accountManager,
    versions,
    clientVersion,
    modelService,
    upstream,
    codingPlanBase: DEFAULT_CODING_PLAN_API_URL,
    oauthBase: DEFAULT_PLATFORM_BASE_URL,
    fetchImpl,
  };
}
