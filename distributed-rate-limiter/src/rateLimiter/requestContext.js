const WILDCARD_SCOPE = "*";

function normalizeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function normalizeScopeValue(value, fallback = WILDCARD_SCOPE) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (value === WILDCARD_SCOPE) {
    return WILDCARD_SCOPE;
  }

  return normalizeSegment(value);
}

function getRequestContext(req) {
  const subject = normalizeScopeValue(
    req.get("x-api-key") || req.get("x-user-id") || req.ip || "anonymous",
    "anonymous"
  );
  const method = normalizeScopeValue(req.method || "GET", "GET");
  const route = normalizeScopeValue(`${req.baseUrl || ""}${req.path || "/"}`, "/");

  return {
    bucketKey: `${subject}:${method}:${route}`,
    method,
    route,
    subject,
  };
}

module.exports = {
  WILDCARD_SCOPE,
  getRequestContext,
  normalizeScopeValue,
  normalizeSegment,
};
