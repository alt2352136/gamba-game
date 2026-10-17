import { signedSessionToken, verifySessionToken } from "./auth.js";
import { logUnexpectedRequestError, logOperationalError } from "./request-logging.js";
import { ApiError, json, readJsonLimited, SECURITY_HEADERS } from "./api-utils.js";
import { crashPointFromDigest } from "./fairness.js";

export { GameSession } from "./game-session.js";
export { resolveCashoutMultiplierCents } from "./game-rules.js";
export { crashPointFromDigest };

function configuredOrigins(env) {
  // ALLOWED_ORIGIN remains supported for upgrades from the first deployed version.
  const value = env.ALLOWED_ORIGINS ?? env.ALLOWED_ORIGIN ?? "";
  return new Set(String(value).split(",").map(origin => origin.trim()).filter(Boolean));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowedOrigins = configuredOrigins(env);
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, idempotency-key",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };

  // Non-browser clients do not send Origin and do not need CORS headers.
  if (origin && allowedOrigins.has(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

export default {
  async fetch(request, env) {
    // Timestamp requests at the edge before authentication/DO dispatch so queued concurrent
    // starts can be distinguished from genuinely new starts after a prior response completed.
    const edgeReceivedAt = Date.now();
    const requestId = crypto.randomUUID();
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("origin");
    const allowedOrigins = configuredOrigins(env);
    if (origin && !allowedOrigins.has(origin)) return json({ error: "origin_not_allowed" }, 403, { vary: "Origin" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "gamba-crash-backend", protocol: 1 }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        if (!env.SESSION_SECRET || !env.SEED_ENCRYPTION_KEY) return json({ error: "server_not_configured" }, 503, cors);
        await readJsonLimited(request);
        const sessionId = crypto.randomUUID();
        const token = await signedSessionToken(sessionId, env.SESSION_SECRET);
        const id = env.GAME_SESSIONS.idFromName(sessionId);
        const stub = env.GAME_SESSIONS.get(id);
        const result = await stub.fetch("https://session.internal/internal/init", {
          method: "POST",
          headers: { "content-type": "application/json", "x-gamba-request-id": requestId },
          body: JSON.stringify({ sessionId, edgePercent: Number(env.HOUSE_EDGE_PERCENT ?? 1) })
        });
        if (!result.ok) {
          logOperationalError("session_initialization_failed", { requestId, status: result.status });
          return json({ error: "session_init_failed", requestId }, 500, cors);
        }
        return json({ sessionId, token, ...(await result.json()) }, 201, cors);
      }

      const isEventSocket = request.method === "GET" && url.pathname === "/api/round/events" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket";
      const auth = request.headers.get("authorization") || "";
      let token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      // Browser WebSocket APIs cannot set Authorization headers. Carry the session token in a
      // negotiated subprotocol (never in the URL), and still verify the same signed token.
      if (isEventSocket && !token) {
        const protocols = String(request.headers.get("sec-websocket-protocol") || "")
          .split(",").map(value => value.trim());
        const authProtocol = protocols.find(value => value.startsWith("gamba-auth."));
        if (authProtocol) token = authProtocol.slice("gamba-auth.".length);
      }
      const sessionId = await verifySessionToken(token, env.SESSION_SECRET || "");
      if (!sessionId) return json({ error: "unauthorized" }, 401, cors);
      if (!url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404, cors);
      const id = env.GAME_SESSIONS.idFromName(sessionId);
      const stub = env.GAME_SESSIONS.get(id);
      // Preserve the original upgrade request for WebSockets; ordinary API requests use
      // the internal origin so route handling does not depend on the public hostname.
      let forwarded = isEventSocket ? request : new Request(`https://session.internal${url.pathname}${url.search}`, request);
      if (!isEventSocket) {
        const headers = new Headers(forwarded.headers);
        // Internal tracing/timing headers are always overwritten at the trusted edge.
        headers.set("x-gamba-request-id", requestId);
        if (request.method === "POST" && url.pathname === "/api/round/start") {
          headers.set("x-gamba-internal-received-at", String(edgeReceivedAt));
        }
        forwarded = new Request(forwarded, { headers });
      }
      const response = await stub.fetch(forwarded);
      // Re-wrapping a 101 response would discard the WebSocket upgrade.
      if (isEventSocket && response.status === 101) return response;
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code, message: error.message }, error.status, cors);
      logUnexpectedRequestError({ requestId, method: request.method, path: url.pathname, error });
      // Do not leak stack traces, seeds, or secret configuration in API responses.
      return json({ error: "internal_error", requestId }, 500, cors);
    }
  }
};
