const { getRequestContext } = require("../rateLimiter/requestContext");

function defaultKeyGenerator(req) {
  return getRequestContext(req).bucketKey;
}

function toSeconds(milliseconds) {
  return Math.max(0, Math.ceil(milliseconds / 1000));
}

function applyRateLimitHeaders(res, decision, policy) {
  res.setHeader("X-RateLimit-Algorithm", "token-bucket");
  res.setHeader("X-RateLimit-Limit", String(decision.capacity));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  res.setHeader("X-RateLimit-Reset-After", String(toSeconds(decision.resetAfterMs)));
  res.setHeader(
    "X-RateLimit-Policy-Scope",
    `${policy.subject}:${policy.method}:${policy.route}`
  );
  res.setHeader("X-RateLimit-Policy-Source", policy.source);
  res.setHeader("X-RateLimit-Request-Cost", String(policy.requestCost));
}

function createTokenBucketRateLimiter({
  bucketService,
  policyService,
  failOpen = true,
  keyGenerator = defaultKeyGenerator,
}) {
  if (!bucketService) {
    throw new Error("bucketService is required.");
  }

  if (!policyService) {
    throw new Error("policyService is required.");
  }

  return async function tokenBucketRateLimiter(req, res, next) {
    const requestContext = getRequestContext(req);
    const bucketKey = keyGenerator(req, requestContext);

    try {
      const policy = await policyService.resolvePolicy(requestContext);
      const decision = await bucketService.consume({
        key: bucketKey,
        capacity: policy.capacity,
        refillRatePerSecond: policy.refillRatePerSecond,
        cost: policy.requestCost,
      });

      res.locals.rateLimit = {
        ...decision,
        policy,
      };
      applyRateLimitHeaders(res, decision, policy);

      if (!decision.allowed) {
        res.setHeader("Retry-After", String(toSeconds(decision.retryAfterMs)));

        return res.status(429).json({
          error: "rate_limit_exceeded",
          message: "Token bucket exhausted. Retry after more tokens refill.",
          retryAfterMs: decision.retryAfterMs,
          rateLimit: {
            algorithm: "token-bucket",
            capacity: decision.capacity,
            policy,
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
  toSeconds,
};
