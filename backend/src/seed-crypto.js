import { base64url, fromBase64, bytesToHex, hexToBytes } from "./crypto-utils.js";

// Server seeds are stored encrypted at rest and are only decrypted when needed for a round.
export async function encryptSeed(seedHex, keyB64) {
  const rawKey = fromBase64(keyB64);
  if (rawKey.length !== 32) throw new Error("SEED_ENCRYPTION_KEY must decode to exactly 32 bytes");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, hexToBytes(seedHex));
  return { iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}

export async function decryptSeed(ivB64, cipherB64, keyB64) {
  const rawKey = fromBase64(keyB64);
  if (rawKey.length !== 32) throw new Error("SEED_ENCRYPTION_KEY must decode to exactly 32 bytes");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const iv = fromBase64(ivB64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - ivB64.length % 4) % 4));
  const cipher = fromBase64(cipherB64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - cipherB64.length % 4) % 4));
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher));
  return bytesToHex(clear);
}
