import { DEFAULT_GATEWAY_BASE_URL } from "./protocol/internal.mjs";
import { MASTER_KEY_HEX, signAtomGitRequest } from "./protocol/sign.mjs";
import { userAgentOf } from "./protocol/oauth.mjs";

export const GATEWAY_ORIGIN = new URL(DEFAULT_GATEWAY_BASE_URL).origin;
export const CHAT_COMPLETIONS_URL = `${DEFAULT_GATEWAY_BASE_URL}/chat/completions`;

export function assertGatewayURL(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== GATEWAY_ORIGIN) {
    throw new Error(`Blocked request to non-AtomCode gateway: ${url.origin}`);
  }
  return url;
}

function abortableSignal({ signal, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onAbort = () => abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs > 0) {
    timer = setTimeout(() => abort(new Error("AtomCode gateway response timed out")), timeoutMs);
  }
  return {
    signal: controller.signal,
    clearTimer() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    abort,
  };
}

export function createUpstreamClient({
  accountManager,
  clientVersion,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = 120_000,
  masterKeyHex = MASTER_KEY_HEX,
}) {
  async function send(auth, { method, path, body, accept, signal }) {
    const target = assertGatewayURL(new URL(path, GATEWAY_ORIGIN));
    const version = await clientVersion();
    const headers = new Headers({
      accept: accept || "application/json",
      authorization: `Bearer ${auth.access}`,
      "user-agent": userAgentOf(version),
      ...(body ? { "content-type": "application/json" } : {}),
    });
    const signed = signAtomGitRequest({
      method,
      path: target.pathname,
      body,
      oauthToken: auth.access,
      userId: auth.uid,
      clientVersion: version,
      masterKeyHex,
    });
    for (const [key, value] of Object.entries(signed)) headers.set(key, value);

    const control = abortableSignal({ signal, timeoutMs });
    try {
      const response = await fetchImpl(target, {
        method,
        headers,
        body,
        redirect: "error",
        signal: control.signal,
      });
      control.clearTimer();
      return {
        response,
        abort: () => control.abort(new Error("Downstream client disconnected")),
        cleanup: () => control.dispose(),
      };
    } catch (error) {
      control.dispose();
      throw error;
    }
  }

  async function request({ method = "POST", path = "/v1/chat/completions", body, accept, signal } = {}) {
    const auth = await accountManager.getValid();
    let result = await send(auth, { method, path, body, accept, signal });
    if (result.response.status !== 401) return result;

    let renewed;
    try {
      renewed = await accountManager.refreshAfterUnauthorized(auth);
    } catch {
      return result;
    }
    await result.response.body?.cancel().catch(() => {});
    result.cleanup();
    result = await send(renewed, { method, path, body, accept, signal });
    return result;
  }

  return { request, send };
}
