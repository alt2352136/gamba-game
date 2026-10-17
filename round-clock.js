// Clock helpers for the visible multiplier. The server remains authoritative for settlement.
export function estimateServerTime(serverTimeAnchor, performanceTimeAnchor, performanceNow, fallbackTime) {
  if (Number.isFinite(serverTimeAnchor) && Number.isFinite(performanceTimeAnchor)) {
    return serverTimeAnchor + (performanceNow - performanceTimeAnchor);
  }
  return fallbackTime;
}

export function nextServerTimeAnchor(serverTimeAnchor, performanceTimeAnchor, serverTime, receivedAt) {
  if (serverTime === null || serverTime === undefined || !Number.isFinite(Number(serverTime))) return null;

  const incoming = Number(serverTime);
  const projected = Number.isFinite(serverTimeAnchor) && Number.isFinite(performanceTimeAnchor)
    ? serverTimeAnchor + (receivedAt - performanceTimeAnchor)
    : null;

  return {
    serverTimeAnchor: projected === null ? incoming : Math.max(projected, incoming),
    performanceTimeAnchor: receivedAt
  };
}

export function calculateVisibleMultiplier(serverTime, roundStartedAt, growthPerSecond, maxMultiplier) {
  const elapsed = Math.max(0, (serverTime - Number(roundStartedAt)) / 1000);
  return Math.min(maxMultiplier, 1 + elapsed * growthPerSecond);
}
