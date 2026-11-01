import {
  claimCodingPlan,
  fetchStatus,
  planNeedsClaim,
  planOf,
} from "./protocol/codingplan.mjs";
import { refreshTokens } from "./protocol/oauth.mjs";

const DEFAULT_TOKEN_LIFETIME_MS = 7 * 24 * 3600_000;

export class AccountError extends Error {
  constructor(message, { code = "account_error", status = 401, signIn } = {}) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    this.status = status;
    if (signIn) this.signIn = signIn;
  }
}

function expiryFrom(now, expiresIn) {
  return now + (Number(expiresIn) > 0 ? Number(expiresIn) * 1000 : DEFAULT_TOKEN_LIFETIME_MS);
}

export function createAccountManager({
  store,
  oauthBase,
  refreshImpl = refreshTokens,
  now = Date.now,
  refreshSkewMs = 60_000,
} = {}) {
  let refreshInflight;

  async function peek() {
    return store.read();
  }

  async function refresh(record) {
    if (!record?.refresh) {
      throw new AccountError("AtomCode sign-in has expired; run atomcode-api login", {
        code: "sign_in_expired",
        signIn: "expired",
      });
    }
    if (refreshInflight) return refreshInflight;

    refreshInflight = (async () => {
      let renewed;
      try {
        renewed = await refreshImpl(oauthBase, record.refresh);
      } catch (error) {
        if (error.signIn === "expired") {
          throw new AccountError("AtomCode sign-in has expired; run atomcode-api login", {
            code: "sign_in_expired",
            signIn: "expired",
          });
        }
        throw new AccountError(`AtomCode token refresh failed: ${error.message}`, {
          code: "refresh_failed",
          status: 503,
        });
      }
      const next = {
        ...record,
        access: renewed.accessToken,
        refresh: renewed.refreshToken ?? record.refresh,
        expires: expiryFrom(now(), renewed.expiresIn),
      };
      await store.write(next);
      return next;
    })().finally(() => {
      refreshInflight = undefined;
    });
    return refreshInflight;
  }

  async function getValid({ force = false } = {}) {
    const record = await store.read();
    if (!record) {
      throw new AccountError("No AtomCode account is signed in; run atomcode-api login", {
        code: "not_authenticated",
      });
    }
    const expiresAt = Number.isFinite(record.expires) ? record.expires : undefined;
    const withinSkew = expiresAt !== undefined && expiresAt <= now() + refreshSkewMs;
    if (force) return refresh(record);
    if (withinSkew && record.refresh) {
      try {
        return await refresh(record);
      } catch (error) {
        if (error.code === "refresh_failed" && expiresAt > now()) return record;
        throw error;
      }
    }
    if (expiresAt !== undefined && expiresAt <= now()) {
      throw new AccountError("AtomCode sign-in has expired; run atomcode-api login", {
        code: "sign_in_expired",
        signIn: "expired",
      });
    }
    return record;
  }

  async function refreshAfterUnauthorized(record) {
    return refresh(record);
  }

  return { peek, getValid, refreshAfterUnauthorized };
}

function authFromToken(token, now) {
  if (!token?.accessToken || !token?.user?.id) {
    throw new Error("OAuth returned incomplete account credentials");
  }
  const user = token.user;
  return {
    version: 1,
    type: "oauth",
    access: token.accessToken,
    ...(token.refreshToken ? { refresh: token.refreshToken } : {}),
    expires: expiryFrom(now, token.expiresIn),
    uid: String(user.id),
    accountId: user.email || user.username || String(user.id),
    ...(user.email ? { email: user.email } : {}),
    ...(user.name || user.username ? { name: user.name || user.username } : {}),
  };
}

export async function claimPlan({
  auth,
  codingPlanBase,
  clientVersion,
  fetchImpl,
}) {
  if (!auth?.access) {
    return { outcome: "failed", message: "No signed-in AtomCode account" };
  }

  let status;
  let statusError;
  try {
    status = await fetchStatus(codingPlanBase, auth.access, {
      fetchImpl,
      clientVersion,
    });
  } catch (error) {
    statusError = error;
    if (error.signIn === "expired") {
      return { outcome: "failed", message: "AtomCode sign-in has expired" };
    }
  }

  if (status && !planNeedsClaim(status)) {
    const plan = planOf(status);
    return {
      outcome: "done",
      planName: plan?.plan_name ?? "",
      message: plan?.plan_name
        ? `The plan is still active: ${plan.plan_name}`
        : "The plan is still active; nothing to claim",
    };
  }

  const claimed = await claimCodingPlan(codingPlanBase, auth.access, {
    fetchImpl,
    clientVersion,
  });
  if (claimed.claimed) {
    return {
      outcome: claimed.duplicate ? "done" : "claimed",
      planName: claimed.planName,
      tier: claimed.tier,
      message: claimed.duplicate
        ? `The plan is already active${claimed.planName ? `: ${claimed.planName}` : ""}`
        : `Plan claimed${claimed.planName ? `: ${claimed.planName}` : ""}`,
    };
  }

  return {
    outcome: "failed",
    message:
      claimed.message ||
      statusError?.message ||
      "No CodingPlan tier is currently available",
  };
}

export async function signInWithOAuth({
  store,
  oauthBase,
  codingPlanBase,
  clientVersion,
  fetchImpl,
  startLoginImpl,
  checkLoginImpl,
  tokenForImpl,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 2_000,
  timeoutMs = 9 * 60_000,
  onLoginUrl = async () => {},
}) {
  const started = await startLoginImpl(oauthBase, { fetchImpl, clientVersion });
  await onLoginUrl(started.loginUrl);

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await checkLoginImpl(oauthBase, started.state, { fetchImpl, clientVersion })) break;
    if (now() >= deadline) throw new Error("AtomCode sign-in timed out");
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }

  const token = await tokenForImpl(oauthBase, started.state, { fetchImpl, clientVersion });
  const auth = authFromToken(token, now());
  await store.write(auth);
  const claim = await claimPlan({ auth, codingPlanBase, clientVersion, fetchImpl });
  return { auth, claim };
}
