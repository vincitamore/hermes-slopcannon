// The agent token goes only to the managed API, or to one origin the person
// names in the environment beside the token. A production file, ledger or
// manifest written by the agent cannot widen this.

export const DEFAULT_ORIGIN = "https://api.slop.cc";
export const ORIGIN_ENV = "SLOPCANNON_AGENT_ORIGIN";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The configured API origin: ORIGIN_ENV when set, otherwise the managed API. */
export function allowedOrigin(env = process.env) {
  const named = env[ORIGIN_ENV]?.trim();
  if (!named) return DEFAULT_ORIGIN;
  let url;
  try { url = new URL(named); } catch { throw new Error(`${ORIGIN_ENV} is not a URL.`); }
  if (url.username || url.password) throw new Error(`${ORIGIN_ENV} must not carry credentials.`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`${ORIGIN_ENV} must be an https origin (plain http only on this machine).`);
  }
  return url.origin;
}

/** Return the origin of `value` when the token may be sent there; throw otherwise. */
export function trustedOrigin(value, env = process.env) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Origin ${JSON.stringify(String(value))} is not a URL.`); }
  if (url.username || url.password) throw new Error("An origin must not carry credentials.");
  const allowed = allowedOrigin(env);
  if (url.origin !== allowed) {
    throw new Error(`The agent token is sent only to ${allowed}; ${url.origin} was refused. To use another API origin, set ${ORIGIN_ENV} in the environment.`);
  }
  return url.origin;
}
