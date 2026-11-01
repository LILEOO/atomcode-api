import {
  FALLBACK_MODELS,
  createCatalog,
  normalizeCodingPlanModel,
} from "./protocol/models.mjs";
import { DEFAULT_OUTPUT } from "./protocol/models.mjs";

function modelList(models) {
  return models.map((model) => ({
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "atomcode",
    context_window: model.context,
    max_output_tokens: model.output,
    supports_vision: model.vision,
    reasoning_effort_levels: model.levels,
  }));
}

function fallbackModels(output) {
  return FALLBACK_MODELS.map((row) => normalizeCodingPlanModel(row, { output })).filter(Boolean);
}

export function createModelService({
  accountManager,
  codingPlanBase,
  clientVersion,
  fetchImpl,
  output = DEFAULT_OUTPUT,
  ttlMs,
  logger = console,
}) {
  const catalog = createCatalog({
    apiBase: codingPlanBase,
    clientVersion: "",
    fetchImpl,
    ttlMs,
    output,
    onReject: (url) => logger.warn?.(`Ignoring untrusted model base URL: ${url}`),
  });
  let lastLive = [];

  async function loadWithRefresh(auth) {
    const version = await clientVersion();
    try {
      return await catalog.load(auth, { clientVersion: version, output });
    } catch (error) {
      if (error.status !== 401) throw error;
      const renewed = await accountManager.refreshAfterUnauthorized(auth);
      return catalog.load(renewed, { clientVersion: version, output });
    }
  }

  async function list() {
    const auth = await accountManager.getValid();
    try {
      const live = await loadWithRefresh(auth);
      if (live.length) lastLive = live;
      if (live.length) return { models: live, source: "live" };
      logger.warn?.("AtomCode returned an empty model catalog; using the fallback list");
    } catch (error) {
      if (error.signIn === "expired" || error.code === "sign_in_expired") throw error;
      logger.warn?.(`Could not refresh the AtomCode model catalog: ${error.message}`);
    }

    if (lastLive.length) return { models: lastLive, source: "cache" };
    return { models: fallbackModels(output), source: "fallback" };
  }

  return {
    list,

    async openAIList() {
      const result = await list();
      return { object: "list", data: modelList(result.models) };
    },

    toOpenAI: modelList,
  };
}
