import { spawn } from "node:child_process";
import { claimPlan, signInWithOAuth } from "./account.mjs";
import { createRuntime } from "./runtime.mjs";
import { createGatewayServer } from "./server.mjs";
import {
  checkLogin,
  startLogin,
  tokenFor,
} from "./protocol/oauth.mjs";
import { fetchStatus, planOf } from "./protocol/codingplan.mjs";
import { strings } from "./protocol/i18n.mjs";
import { quotaFromStatus } from "./protocol/quota.mjs";
import { parsePort } from "./storage.mjs";

const HELP = `Usage: atomcode-api <command> [options]

Commands:
  login       Sign in with AtomGit in a browser and claim the CodingPlan
  serve       Start the local OpenAI-compatible API
  logout      Remove the saved AtomCode sign-in
  status      Show account, plan and quota status
  models      List models available to this account
  checkin     Claim the CodingPlan when it is missing or expired
  key         Print the local API key

Options:
  --port <n>  Override the listening port (serve only)
  --json      Print machine-readable output
  --no-open   Do not open the sign-in URL automatically (login only)
  --help      Show this help
`;

export class CliError extends Error {}

export function parseArgs(argv) {
  const args = [...argv];
  const options = { json: false, noOpen: false };
  let command;
  while (args.length) {
    const value = args.shift();
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--version") options.version = true;
    else if (value === "--json") options.json = true;
    else if (value === "--no-open") options.noOpen = true;
    else if (value === "--port") {
      const port = args.shift();
      if (!port) throw new CliError("--port requires a value");
      options.port = parsePort(port);
    } else if (value.startsWith("-")) {
      throw new CliError(`Unknown option: ${value}`);
    } else if (!command) command = value;
    else throw new CliError(`Unexpected argument: ${value}`);
  }
  return { command, options };
}

export function openBrowser(url, spawnImpl = spawn) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

function printClaim(io, claim) {
  io.out(`${claim.outcome.toUpperCase()}: ${claim.message}`);
}

function printStatus(io, { auth, status, usage }) {
  const plan = planOf(status) ?? {};
  io.out(`Account: ${auth.name || auth.email || auth.accountId || auth.uid}`);
  io.out(`Plan: ${usage.plan || plan.plan_name || "not available"}`);
  if (usage.until) io.out(`Until: ${usage.until}`);
  if (!usage.windows.length) io.out("Quota: no active rate-limit window reported");
  for (const window of usage.windows) {
    const detail = window.display ? ` (${window.display})` : "";
    io.out(`Quota: ${window.name}: ${window.used}%${detail}`);
  }
}

async function runLogin(runtime, options, io) {
  const result = await signInWithOAuth({
    store: runtime.store,
    oauthBase: runtime.oauthBase,
    codingPlanBase: runtime.codingPlanBase,
    clientVersion: await runtime.clientVersion(),
    fetchImpl: runtime.fetchImpl,
    startLoginImpl: startLogin,
    checkLoginImpl: checkLogin,
    tokenForImpl: tokenFor,
    onLoginUrl: async (url) => {
      io.out(`Open this URL to authorize AtomCode:\n${url}`);
      if (!options.noOpen) openBrowser(url);
      io.out("Waiting for browser authorization...");
    },
  });
  printClaim(io, result.claim);
  io.out("Sign-in saved. Fetch the local API key with: atomcode-api key");
}

async function runStatus(runtime, options, io) {
  let auth;
  try {
    auth = await runtime.accountManager.getValid();
  } catch (error) {
    if (error.code === "not_authenticated") {
      if (options.json) io.out(JSON.stringify({ authenticated: false }));
      else io.out("Not signed in. Run: atomcode-api login");
      return;
    }
    throw error;
  }
  const status = await fetchStatus(runtime.codingPlanBase, auth.access, {
    fetchImpl: runtime.fetchImpl,
    clientVersion: await runtime.clientVersion(),
  });
  const usage = quotaFromStatus(status, strings("en"), {
    user: auth.name || auth.email || auth.accountId,
  });
  if (options.json) {
    io.out(JSON.stringify({ authenticated: true, account: auth.accountId, usage }));
  } else {
    printStatus(io, { auth, status, usage });
  }
}

async function runModels(runtime, options, io) {
  if (options.json) {
    io.out(JSON.stringify(await runtime.modelService.openAIList()));
    return;
  }
  const { models, source } = await runtime.modelService.list();
  io.out(`Source: ${source}`);
  for (const model of models) {
    io.out(`${model.id}\tcontext=${model.context}\tvision=${model.vision}`);
  }
}

async function runCheckin(runtime, options, io) {
  const auth = await runtime.accountManager.getValid();
  const claim = await claimPlan({
    auth,
    codingPlanBase: runtime.codingPlanBase,
    clientVersion: await runtime.clientVersion(),
    fetchImpl: runtime.fetchImpl,
  });
  if (options.json) io.out(JSON.stringify(claim));
  else printClaim(io, claim);
}

async function runServe(runtime, options, io, signalSource) {
  if (!(await runtime.accountManager.peek())) {
    throw new CliError("Not signed in. Run: atomcode-api login");
  }
  const port = options.port ?? runtime.config.port;
  const server = createGatewayServer({
    apiKey: runtime.config.apiKey,
    accountManager: runtime.accountManager,
    modelService: runtime.modelService,
    upstream: runtime.upstream,
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    const shutdown = () => {
      signalSource.off("SIGINT", shutdown);
      signalSource.off("SIGTERM", shutdown);
      server.close(() => resolve());
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      signalSource.once("SIGINT", shutdown);
      signalSource.once("SIGTERM", shutdown);
      io.out(`AtomCode API listening on http://127.0.0.1:${port}/v1`);
      io.out("Use the local key from: atomcode-api key");
    });
  });
}

export async function runCli(
  argv,
  {
    env = process.env,
    io = { out: (line) => process.stdout.write(`${line}\n`), error: (line) => process.stderr.write(`${line}\n`) },
    fetchImpl,
    signalSource = process,
  } = {},
) {
  const { command, options } = parseArgs(argv);
  if (options.version) {
    io.out("atomcode-api 0.1.0");
    return 0;
  }
  if (options.help || command === "help" || !command) {
    io.out(HELP.trimEnd());
    return 0;
  }
  if (command === "version") {
    io.out("atomcode-api 0.1.0");
    return 0;
  }

  const runtime = await createRuntime({ env, fetchImpl });
  if (command === "login") await runLogin(runtime, options, io);
  else if (command === "serve") await runServe(runtime, options, io, signalSource);
  else if (command === "logout") {
    await runtime.store.clear();
    io.out("Signed out.");
  } else if (command === "status") await runStatus(runtime, options, io);
  else if (command === "models") await runModels(runtime, options, io);
  else if (command === "checkin") await runCheckin(runtime, options, io);
  else if (command === "key") io.out(runtime.config.apiKey);
  else throw new CliError(`Unknown command: ${command}`);
  return 0;
}
