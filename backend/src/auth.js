import { base64url, hmacBytes, sha256Hex } from "./crypto-utils.js";

export async function signedSessionToken(sessionId, secret) {
  const signature = await hmacBytes(new TextEncoder().encode(secret), sessionId);
  return `${sessionId}.${base64url(signature)}`;
}

let cachedSessionVerifier = null;
let sessionVerifierKeyPromise = null;

async function getSessionVerifierKey(secret) {
  const fingerprint = await sha256Hex(secret);
  if (cachedSessionVerifier?.fingerprint === fingerprint) return cachedSessionVerifier.key;
  if (sessionVerifierKeyPromise?.fingerprint === fingerprint) return sessionVerifierKeyPromise.promise;

  const record = { fingerprint, promise: null };
  record.promise = (async () => {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    // Do not let a request using an old secret replace the cache after a rotation.
    if (sessionVerifierKeyPromise === record) cachedSessionVerifier = { fingerprint, key };
    return key;
  })();
  sessionVerifierKeyPromise = record;
  try {
    return await record.promise;
  } finally {
    if (sessionVerifierKeyPromise === record) sessionVerifierKeyPromise = null;
  }
}

export async function verifySessionToken(token, secret) {
  if (typeof token !== "string" || typeof secret !== "string" || secret.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const sessionId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^[A-Za-z0-9_-]{40,50}$/.test(signature)) return null;
  const key = await getSessionVerifierKey(secret);
  let sigBytes;
  try {
    const padded = signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - signature.length % 4) % 4);
    sigBytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(sessionId));
  return ok ? sessionId : null;
}
