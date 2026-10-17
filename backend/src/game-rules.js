import { ApiError } from "./api-utils.js";

// Gameplay settings shared by the session lifecycle and its focused tests.
export const STARTING_GOLD = 888;
export const MAX_MULTIPLIER = 10;
export const GROWTH_PER_SECOND = 0.8;
export const MAX_CLIENT_SEED_LENGTH = 128;
export const PUBLIC_HISTORY_LIMIT = 10;
export const LOANS = {
  444: { principal: 444, repayment: 533, rounds: 8 },
  888: { principal: 888, repayment: 1110, rounds: 6 },
  1500: { principal: 1500, repayment: 2025, rounds: 4 }
};

function validateRequestedMultiplierCents(value) {
  if (value === undefined) return undefined; // Older clients may omit this value.
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_MULTIPLIER * 100) {
    throw new ApiError(400, "invalid_cashout_multiplier", "Requested cash-out multiplier must be whole cents from 100 to 1000.");
  }
  return value;
}

// The client-provided multiplier is only a ceiling; the server decides the actual payout.
export function resolveCashoutMultiplierCents(serverLiveMultiplier, requestedMultiplierCents = undefined) {
  const serverCents = Math.max(100, Math.min(MAX_MULTIPLIER * 100, Math.floor(serverLiveMultiplier * 100)));
  if (requestedMultiplierCents === undefined) return serverCents;
  const requestedCents = validateRequestedMultiplierCents(requestedMultiplierCents);
  return Math.min(serverCents, requestedCents);
}

export function readRequestedMultiplierCents(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "requestedMultiplierCents")) return undefined;
  return validateRequestedMultiplierCents(body.requestedMultiplierCents);
}
