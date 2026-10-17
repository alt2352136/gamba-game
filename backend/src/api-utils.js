export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function safeParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export async function readJsonLimited(request, maxBytes = 8192) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBytes;
  if (!request.body) {
    if (tooLarge) throw new ApiError(413, "request_too_large", "Request body exceeds the allowed size.");
    return {};
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        continue; // Drain the remainder without buffering an oversized body.
      }
      if (!tooLarge) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (tooLarge) throw new ApiError(413, "request_too_large", "Request body exceeds the allowed size.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "invalid_json", "Request body must be valid JSON."); }
}
