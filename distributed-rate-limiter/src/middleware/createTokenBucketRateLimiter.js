function normalizeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function defaultKeyGenerator(req) {
  const apiKey = req.get("x-api-key");
  const userId = req.get("x-user-id");
  const identity = apiKey || userId || req.ip || "anonymous";
  const routeFingerprint = `${req.method}:${req.baseUrl || ""}${req.path || "/"}`;

  return `${normalizeSegment(identity)}:${normalizeSegment(routeFingerprint)}`;
}

function toSeconds(milliseconds) {
  return Math.max(0, Math.ceil(milliseconds / 1000));
}

function applyRateLimitHeaders(res, decision) {
  res.setHeader("X-RateLimit-Algorithm", "token-bucket");
  res.setHeader("X-RateLimit-Limit", String(decision.capacity));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  res.setHeader("X-RateLimit-Reset-After", String(toSeconds(decision.resetAfterMs)));
}

function createTokenBucketRateLimiter({
  bucketService,
  failOpen = true,
  keyGenerator = defaultKeyGenerator,
  requestCost,
}) {
  if (!bucketService) {
    throw new Error("bucketService is required.");
  }

  return async function tokenBucketRateLimiter(req, res, next) {
    const bucketKey = keyGenerator(req);

    try {
      const decision = await bucketService.consume({
        key: bucketKey,
        cost: requestCost,
      });

      res.locals.rateLimit = decision;
      applyRateLimitHeaders(res, decision);

      if (!decision.allowed) {
        res.setHeader("Retry-After", String(toSeconds(decision.retryAfterMs)));

        return res.status(429).json({
          error: "rate_limit_exceeded",
          message: "Token bucket exhausted. Retry after more tokens refill.",
          retryAfterMs: decision.retryAfterMs,
          rateLimit: {
            algorithm: "token-bucket",
            capacity: decision.capacity,
            remaining: decision.remaining,
            resetAfterMs: decision.resetAfterMs,
          },
        });
      }

      return next();
    } catch (error) {
      if (failOpen) {
        res.setHeader("X-RateLimit-Degraded", "true");
        res.locals.rateLimit = {
          degraded: true,
        };

        return next();
      }

      error.code = "RATE_LIMIT_BACKEND_UNAVAILABLE";
      error.statusCode = 503;
      return next(error);
    }
  };
}

module.exports = {
  applyRateLimitHeaders,
  createTokenBucketRateLimiter,
  defaultKeyGenerator,
  normalizeSegment,
  toSeconds,
};
