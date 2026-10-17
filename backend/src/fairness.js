import { bytesToHex } from "./crypto-utils.js";

// Keep the crash formula in one small module so it can be reviewed and tested in isolation.
export function crashPointFromDigest(digest, edgePercent) {
  // Take the first 52 digest bits to define U in [0,1), then mirror
  // floor((100 - edgePercent) / (1-U)) / 100, clamped to x1.00.
  const first13Hex = bytesToHex(digest).slice(0, 13);
  const random52 = BigInt(`0x${first13Hex}`);
  const denominator = 1n << 52n;
  const rtpPercent = BigInt(Math.round(100 - edgePercent));
  const remaining = denominator - random52;
  const cents = (rtpPercent * denominator) / remaining;
  // This ceiling is far above the game's x10 cash-out cap.
  const boundedCents = cents < 100n ? 100n : cents > 100_000_000n ? 100_000_000n : cents;
  return Number(boundedCents) / 100;
}
