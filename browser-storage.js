function parseStoredSession(storage, key) {
  try {
    const value = storage.getItem(key);
    const parsed = value ? JSON.parse(value) : null;
    return parsed && typeof parsed.token === "string" && typeof parsed.sessionId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function readStoredSession(localStore, sessionStore, key) {
  try {
    const persistent = parseStoredSession(localStore, key);
    if (persistent) return persistent;

    // Migrate sessions created by the earlier tab-only version.
    const legacy = parseStoredSession(sessionStore, key);
    if (!legacy) return null;
    localStore.setItem(key, JSON.stringify(legacy));
    sessionStore.removeItem(key);
    return legacy;
  } catch {
    // A disabled or read-only storage area should not prevent a fresh session from starting.
    return null;
  }
}

export function storeSession(localStore, sessionStore, key, session) {
  localStore.setItem(key, JSON.stringify(session));
  try {
    sessionStore.removeItem(key);
  } catch {
    // Keeping the old tab-scoped copy is harmless; the persistent session takes precedence.
  }
}

export function readLastReveal(localStore, sessionStore, key) {
  try {
    const value = localStore.getItem(key) || sessionStore.getItem(key);
    const reveal = value ? JSON.parse(value) : null;
    return reveal && reveal.serverSeed && reveal.commitment ? reveal : null;
  } catch {
    return null;
  }
}

export function storeLastReveal(localStore, sessionStore, key, reveal) {
  const value = JSON.stringify(reveal);
  try {
    localStore.setItem(key, value);
  } catch {
    try {
      sessionStore.setItem(key, value);
    } catch {
      // The server's fairness endpoint remains authoritative if browser storage is unavailable.
    }
  }
}
