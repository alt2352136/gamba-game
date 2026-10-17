import assert from "node:assert/strict";
import test from "node:test";
import {
  readLastReveal,
  readStoredSession,
  storeLastReveal,
  storeSession
} from "../../browser-storage.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

const SESSION_KEY = "session";
const REVEAL_KEY = "reveal";
const validSession = { sessionId: "session-1", token: "signed-token" };
const validReveal = { epoch: 2, serverSeed: "revealed-seed", commitment: "seed-commitment" };

test("stored session prefers the persistent copy", () => {
  const local = memoryStorage({ [SESSION_KEY]: JSON.stringify(validSession) });
  const session = memoryStorage({ [SESSION_KEY]: JSON.stringify({ sessionId: "old", token: "old" }) });
  assert.deepEqual(readStoredSession(local, session, SESSION_KEY), validSession);
});

test("legacy tab-scoped session is migrated to persistent storage", () => {
  const local = memoryStorage();
  const session = memoryStorage({ [SESSION_KEY]: JSON.stringify(validSession) });
  assert.deepEqual(readStoredSession(local, session, SESSION_KEY), validSession);
  assert.equal(local.getItem(SESSION_KEY), JSON.stringify(validSession));
  assert.equal(session.getItem(SESSION_KEY), null);
});

test("malformed or incomplete session records are ignored", () => {
  assert.equal(readStoredSession(memoryStorage({ [SESSION_KEY]: "{" }), memoryStorage(), SESSION_KEY), null);
  assert.equal(readStoredSession(memoryStorage({ [SESSION_KEY]: JSON.stringify({ token: "only-token" }) }), memoryStorage(), SESSION_KEY), null);
});

test("storing a session removes the legacy copy when possible", () => {
  const local = memoryStorage();
  const session = memoryStorage({ [SESSION_KEY]: JSON.stringify(validSession) });
  storeSession(local, session, SESSION_KEY, validSession);
  assert.equal(local.getItem(SESSION_KEY), JSON.stringify(validSession));
  assert.equal(session.getItem(SESSION_KEY), null);
});

test("revealed fairness data can be recovered from either storage area", () => {
  assert.deepEqual(readLastReveal(memoryStorage({ [REVEAL_KEY]: JSON.stringify(validReveal) }), memoryStorage(), REVEAL_KEY), validReveal);
  assert.deepEqual(readLastReveal(memoryStorage(), memoryStorage({ [REVEAL_KEY]: JSON.stringify(validReveal) }), REVEAL_KEY), validReveal);
  assert.equal(readLastReveal(memoryStorage({ [REVEAL_KEY]: "{}" }), memoryStorage(), REVEAL_KEY), null);
});

test("revealed fairness data falls back to session storage if persistent storage fails", () => {
  const local = memoryStorage();
  local.setItem = () => { throw new Error("storage unavailable"); };
  const session = memoryStorage();
  storeLastReveal(local, session, REVEAL_KEY, validReveal);
  assert.equal(session.getItem(REVEAL_KEY), JSON.stringify(validReveal));
});
