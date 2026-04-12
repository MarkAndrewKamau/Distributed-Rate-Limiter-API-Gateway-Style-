const crypto = require("node:crypto");

function extractBearerToken(headerValue) {
  if (!headerValue) {
    return null;
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token || null;
}

function extractAdminCredential(req) {
  const bearerToken = extractBearerToken(req.get("authorization"));

  if (bearerToken) {
    return {
      key: bearerToken,
      scheme: "bearer",
    };
  }

  const adminApiKey = req.get("x-admin-api-key");

  if (!adminApiKey) {
    return null;
  }

  const normalizedKey = adminApiKey.trim();

  if (!normalizedKey) {
    return null;
  }

  return {
    key: normalizedKey,
    scheme: "x-admin-api-key",
  };
}

function timingSafeKeyMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sendAdminAuthError(res, { code, message, realm, statusCode }) {
  res.setHeader("Cache-Control", "no-store");

  if (statusCode === 401) {
    res.setHeader("WWW-Authenticate", `Bearer realm="${realm}"`);
  }

  return res.status(statusCode).json({
    error: code,
    message,
  });
}

function createAdminAuthMiddleware({
  apiKeys = [],
  realm = "rate-limiter-admin",
}) {
  const normalizedApiKeys = apiKeys
    .map((apiKey) => String(apiKey).trim())
    .filter(Boolean);

  return function adminAuthMiddleware(req, res, next) {
    if (normalizedApiKeys.length === 0) {
      return sendAdminAuthError(res, {
        code: "ADMIN_AUTH_UNAVAILABLE",
        message: "Admin authentication is not configured.",
        realm,
        statusCode: 503,
      });
    }

    const credential = extractAdminCredential(req);

    if (
      !credential ||
      !normalizedApiKeys.some((apiKey) => timingSafeKeyMatch(credential.key, apiKey))
    ) {
      return sendAdminAuthError(res, {
        code: "UNAUTHORIZED",
        message: "Valid admin credentials are required for this route.",
        realm,
        statusCode: 401,
      });
    }

    res.locals.adminAuth = {
      authenticated: true,
      scheme: credential.scheme,
    };

    return next();
  };
}

module.exports = {
  createAdminAuthMiddleware,
  extractAdminCredential,
  extractBearerToken,
  timingSafeKeyMatch,
};
