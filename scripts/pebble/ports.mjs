// What is on a local port? Pebble never acts on a port it can't identify.
import http from "node:http";
import net from "node:net";

const HOST = "127.0.0.1";
/**
 * The app's dev server listens on `localhost`, which on macOS may be IPv6 (::1) only, so app
 * probes use the name (Node tries both families) and binding is checked on both addresses.
 */
export const WEB_HOST = "localhost";
const WEB_BIND_HOSTS = ["127.0.0.1", "::1"];

/** GET http://<host>:<port><path>; null when nothing answers in time. Never via a proxy. */
export function httpGet(port, urlPath, { host = HOST, timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    // Always destroy the socket when done, so no half-open connection outlives the probe.
    const finish = (value) => {
      request.destroy();
      resolve(value);
    };
    const request = http.get(
      { host, port, path: urlPath, timeout: timeoutMs, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 1_000_000) body += chunk;
        });
        response.on("end", () => finish({ status: response.statusCode ?? 0, body }));
        response.on("error", () => finish(null));
      },
    );
    request.on("timeout", () => finish(null));
    request.on("error", () => finish(null));
  });
}

/** True when something accepts a TCP connection on the port. */
export function canConnect(port, { host = HOST, timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(true)); // accepted but silent: still occupied
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

/**
 * True when the port can be bound the way the worker binds it. Node listens with
 * SO_REUSEADDR (as uvicorn does), so connections left over from a previous run don't block
 * it, but another program's listener does.
 */
export function canBind(port, host = HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    // An address family this computer doesn't have (e.g. no IPv6) can't be occupied.
    server.once("error", (error) =>
      resolve(["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)),
    );
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A parsed Pebble /health payload, or null when the body isn't one. */
export function parsePebbleHealth(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const ok =
    data !== null &&
    typeof data === "object" &&
    typeof data.schemaVersion === "string" &&
    /^1\.\d+$/.test(data.schemaVersion) &&
    typeof data.workerVersion === "string" &&
    Array.isArray(data.providers) &&
    typeof data.tools === "object";
  return ok ? data : null;
}

/**
 * The worker port's state:
 * - `pebble`: a Pebble worker of this version running FunASR;
 * - `pebble-incompatible`: a Pebble worker of another version or provider;
 * - `other`: something else accepts connections, or the port can't be bound;
 * - `free`: nothing accepts connections and the port can be bound.
 */
export async function classifyWorkerPort(port, { expectedVersion }) {
  const response = await httpGet(port, "/health");
  if (response) {
    const health = parsePebbleHealth(response.body);
    if (!health) return { state: "other" };
    const [provider, ...others] = health.providers;
    const compatible =
      health.workerVersion === expectedVersion && provider?.id === "funasr" && !others.length;
    return { state: compatible ? "pebble" : "pebble-incompatible", health };
  }
  if (await canConnect(port)) return { state: "other" };
  return { state: (await canBind(port)) ? "free" : "other" };
}

/** The web port's state: `pebble` (the Pebble app is being served), `other` or `free`. */
export async function classifyWebPort(port) {
  const response = await httpGet(port, "/", { host: WEB_HOST });
  if (response) return { state: isPebblePage(response.body) ? "pebble" : "other" };
  if (await canConnect(port, { host: WEB_HOST })) return { state: "other" };
  for (const host of WEB_BIND_HOSTS) {
    if (!(await canBind(port, host))) return { state: "other" };
  }
  return { state: "free" };
}

export const isPebblePage = (body) => body.includes("<title>Pebble</title>");
