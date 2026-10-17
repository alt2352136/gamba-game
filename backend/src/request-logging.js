// Keep operational logs useful without logging request bodies, tokens or seed values.
function redactSensitiveText(value) {
  return value
    .replace(/authorization([\s:=]+)(?:bearer[\s]+)?[^\s,;}]+/gi, "authorization=[redacted]")
    .replace(/\bbearer[\s:=]+[^\s,;}]+/gi, "Bearer [redacted]")
    .replace(/(session[_ -]?secret|seed[_ -]?encryption[_ -]?key|server[_ -]?seed|token)([\s:=]+)[^\s,;}]+/gi, "$1$2[redacted]")
    .slice(0, 1200);
}

function safeErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : "Unexpected error";
  return redactSensitiveText(message).slice(0, 240);
}

function safeErrorStack(error) {
  if (typeof error?.stack !== "string") return undefined;
  return redactSensitiveText(error.stack.split("\n").slice(0, 10).join("\n"));
}

function errorFields(error) {
  const fields = {
    errorName: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error",
    errorMessage: safeErrorMessage(error)
  };
  const stack = safeErrorStack(error);
  if (stack) fields.errorStack = stack;
  return fields;
}

export function logUnexpectedRequestError({ requestId, method, path, error }) {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event: "unhandled_request_error",
    requestId,
    method,
    path,
    ...errorFields(error)
  }));
}

export function logOperationalError(event, details = {}, error = null) {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event,
    ...details,
    ...(error ? errorFields(error) : {})
  }));
}
