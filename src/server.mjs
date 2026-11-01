import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";

export const SERVICE_VERSION = "0.1.0";

class HttpError extends Error {
  constructor(status, message, code = "invalid_request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(header) {
  if (typeof header !== "string") return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function isLoopbackHost(header, localPort) {
  if (typeof header !== "string" || !header.trim()) return false;
  try {
    const parsed = new URL(`http://${header.trim()}`);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    const port = parsed.port ? Number(parsed.port) : 80;
    return loopback && port === localPort;
  } catch {
    return false;
  }
}

async function readRequestBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`, "request_too_large");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`, "request_too_large");
    }
    chunks.push(chunk);
  }
  if (!total) throw new HttpError(400, "Request body is required");
  return Buffer.concat(chunks, total);
}

function parseChatBody(buffer) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new HttpError(400, "Request body must include a model");
  }
  return value;
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  sendJson(res, status, {
    error: {
      message: error.message || "Internal server error",
      type: status >= 500 ? "server_error" : status === 401 ? "authentication_error" : "invalid_request_error",
      code: error.code || (status >= 500 ? "internal_error" : "invalid_request"),
    },
  });
}

function copyUpstreamHeaders(response, res) {
  for (const name of [
    "content-type",
    "cache-control",
    "x-request-id",
    "openai-request-id",
    "retry-after",
  ]) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

export function createGatewayServer({
  apiKey,
  accountManager,
  modelService,
  upstream,
  logger = console,
  maxBodyBytes = 32 * 1024 * 1024,
} = {}) {
  return createHttpServer(async (req, res) => {
    try {
      if (!isLoopbackHost(req.headers.host, req.socket.localPort)) {
        throw new HttpError(403, "Only loopback hosts are accepted", "host_forbidden");
      }
      const url = new URL(req.url || "/", "http://localhost");

      if (url.pathname === "/healthz") {
        if (req.method !== "GET") {
          res.setHeader("allow", "GET");
          throw new HttpError(405, "Method not allowed", "method_not_allowed");
        }
        let authenticated = false;
        try {
          authenticated = Boolean(await accountManager.peek());
        } catch {
          authenticated = false;
        }
        sendJson(res, 200, { ok: true, authenticated, version: SERVICE_VERSION });
        return;
      }

      if (url.pathname !== "/v1/models" && url.pathname !== "/v1/chat/completions") {
        throw new HttpError(404, "Route not found", "not_found");
      }
      if (!safeEqual(bearerToken(req.headers.authorization), apiKey)) {
        throw new HttpError(401, "Invalid local API key", "invalid_api_key");
      }

      if (url.pathname === "/v1/models") {
        if (req.method !== "GET") {
          res.setHeader("allow", "GET");
          throw new HttpError(405, "Method not allowed", "method_not_allowed");
        }
        const models = await modelService.openAIList();
        sendJson(res, 200, models);
        return;
      }

      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "Method not allowed", "method_not_allowed");
      }

      const body = await readRequestBody(req, maxBodyBytes);
      parseChatBody(body);
      const accept =
        typeof req.headers.accept === "string" && req.headers.accept
          ? req.headers.accept
          : "application/json";
      const clientAbort = new AbortController();
      const abortClient = () => clientAbort.abort(new Error("Downstream client disconnected"));
      req.once("aborted", abortClient);
      res.once("close", abortClient);
      const releaseClient = () => {
        req.off("aborted", abortClient);
        res.off("close", abortClient);
      };
      let result;
      try {
        result = await upstream.request({
          method: "POST",
          path: "/v1/chat/completions",
          body,
          accept,
          signal: clientAbort.signal,
        });
      } catch (error) {
        releaseClient();
        throw error;
      }

      res.statusCode = result.response.status;
      copyUpstreamHeaders(result.response, res);
      if (!result.response.body) {
        res.end();
        result.cleanup();
        releaseClient();
        return;
      }

      const stream = Readable.fromWeb(result.response.body);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        releaseClient();
        result.cleanup();
      };
      res.on("close", () => {
        if (!res.writableEnded) result.abort();
        cleanup();
      });
      stream.on("error", (error) => {
        logger.warn?.(`Upstream stream failed: ${error.message}`);
        if (!res.destroyed) res.destroy(error);
        cleanup();
      });
      stream.on("end", cleanup);
      stream.pipe(res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error);
        return;
      }
      if (error.status === 401 || error.code === "not_authenticated" || error.code === "sign_in_expired") {
        sendError(
          res,
          Object.assign(new Error(error.message), {
            status: 401,
            code: error.code || "not_authenticated",
          }),
        );
        return;
      }
      logger.error?.(`Request failed: ${error.message}`);
      sendError(res, Object.assign(new Error("AtomCode upstream request failed"), { status: 502, code: "upstream_error" }));
    }
  });
}
