import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, json, readJsonLimited } from "../src/api-utils.js";

test("JSON responses include the expected no-store security headers", async () => {
  const response = json({ ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.deepEqual(await response.json(), { ok: true });
});

test("bounded JSON parser accepts valid payloads", async () => {
  const request = new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stake: 20 })
  });
  assert.deepEqual(await readJsonLimited(request), { stake: 20 });
});

test("bounded JSON parser rejects malformed JSON with a client error", async () => {
  const request = new Request("https://example.test/api", { method: "POST", body: "not-json" });
  await assert.rejects(readJsonLimited(request), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_json");
    return true;
  });
});

test("bounded JSON parser rejects oversized bodies while reading the stream", async () => {
  const request = new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tooLarge: "x".repeat(100) })
  });
  await assert.rejects(readJsonLimited(request, 16), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 413);
    assert.equal(error.code, "request_too_large");
    return true;
  });
});
