// Small Web Crypto helpers shared by authentication, seed storage and round fairness.
export function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid hex value");
  return Uint8Array.from(hex.match(/.{2}/g), pair => parseInt(pair, 16));
}

export async function sha256Hex(text) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function hmacBytes(secretBytes, message) {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

export async function hmacBytesWithKey(key, message) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
