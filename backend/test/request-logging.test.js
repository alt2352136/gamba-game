import assert from "node:assert/strict";
import test from "node:test";
import { logOperationalError, logUnexpectedRequestError } from "../src/request-logging.js";

function captureLog(callback) {
  const originalError = console.error;
  let logged = "";
  console.error = (line) => { logged = String(line); };
  try { callback(); }
  finally { console.error = originalError; }
  return JSON.parse(logged);
}

test("unexpected-request logs include a correlation ID, stack context and no raw credentials", () => {
  const record = captureLog(() => logUnexpectedRequestError({
    requestId: "request-123",
    method: "POST",
    path: "/api/session",
    error: new Error("SESSION_SECRET=do-not-log while processing request")
  }));

  assert.equal(record.level, "error");
  assert.equal(record.event, "unhandled_request_error");
  assert.equal(record.requestId, "request-123");
  assert.equal(record.method, "POST");
  assert.equal(record.path, "/api/session");
  assert.match(record.errorStack, /request-logging\.test\.js/);
  assert.doesNotMatch(JSON.stringify(record), /do-not-log/);
});

test("authorization headers and bearer values are redacted", () => {
  const record = captureLog(() => logOperationalError(
    "test_error",
    { requestId: "request-456" },
    new Error("Authorization: Bearer token-value-do-not-log")
  ));
  assert.doesNotMatch(JSON.stringify(record), /token-value-do-not-log/);
  assert.match(record.errorMessage, /redacted/);
});
