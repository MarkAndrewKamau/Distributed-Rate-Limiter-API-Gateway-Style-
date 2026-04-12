const express = require("express");

const {
  createAdminAuthMiddleware,
} = require("./middleware/createAdminAuthMiddleware");
const {
  createTokenBucketRateLimiter,
} = require("./middleware/createTokenBucketRateLimiter");
const {
  createPolicyValidationError,
} = require("./rateLimiter/rateLimitPolicyService");

function createBadRequestError(message) {
  const error = createPolicyValidationError(message);
  error.code = "BAD_REQUEST";
  return error;
}

function buildPolicyResponse(rateLimitState) {
  const appliedPolicy = rateLimitState.policy || {};

  return {
    algorithm: "token-bucket",
    capacity: rateLimitState.capacity,
    remaining: rateLimitState.remaining,
    resetAfterMs: rateLimitState.resetAfterMs,
    policy: {
      capacity: appliedPolicy.capacity,
      method: appliedPolicy.method,
      refillRatePerSecond: appliedPolicy.refillRatePerSecond,
      requestCost: appliedPolicy.requestCost,
      route: appliedPolicy.route,
      source: appliedPolicy.source,
      subject: appliedPolicy.subject,
    },
  };
}

function getPolicyPayload(source) {
  return {
    apiKey: source.apiKey,
    capacity: source.capacity,
    method: source.method,
    refillRatePerSecond: source.refillRatePerSecond,
    requestCost: source.requestCost,
    route: source.route,
    subject: source.subject,
  };
}

function createApp({ config, bucketService, policyService }) {
  if (!config) {
    throw new Error("config is required.");
  }

  if (!bucketService) {
    throw new Error("bucketService is required.");
  }

  if (!policyService) {
    throw new Error("policyService is required.");
  }

  const app = express();
  const adminRouter = express.Router();
  const adminAuthMiddleware = createAdminAuthMiddleware({
    apiKeys: config.admin.apiKeys,
    realm: config.admin.realm,
  });
  const rateLimitMiddleware = createTokenBucketRateLimiter({
    bucketService,
    failOpen: config.rateLimit.failOpen,
    policyService,
  });

  app.set("trust proxy", true);
  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json({
      service: "distributed-rate-limiter",
      status: "ok",
    });
  });

  app.get("/ready", async (req, res, next) => {
    try {
      await bucketService.ping();
      res.json({
        redis: "reachable",
        status: "ready",
      });
    } catch (error) {
      error.code = "REDIS_UNAVAILABLE";
      error.statusCode = 503;
      next(error);
    }
  });

  app.get("/api/unlimited", (req, res) => {
    res.json({
      message: "Unlimited route reached.",
    });
  });

  app.get("/api/limited", rateLimitMiddleware, (req, res) => {
    const rateLimitState = res.locals.rateLimit || {};

    res.json({
      message: "Request accepted by the token bucket.",
      rateLimit: buildPolicyResponse(rateLimitState),
    });
  });

  app.get("/api/reports", rateLimitMiddleware, (req, res) => {
    const rateLimitState = res.locals.rateLimit || {};

    res.json({
      message: "Reports route accepted by the token bucket.",
      rateLimit: buildPolicyResponse(rateLimitState),
    });
  });

  app.post("/api/uploads", rateLimitMiddleware, (req, res) => {
    const rateLimitState = res.locals.rateLimit || {};

    res.json({
      message: "Upload route accepted by the token bucket.",
      rateLimit: buildPolicyResponse(rateLimitState),
    });
  });

  adminRouter.use(adminAuthMiddleware);

  adminRouter.get("/policies", async (req, res, next) => {
    try {
      const policies = await policyService.listPolicies();
      res.json({
        count: policies.length,
        defaultPolicy: config.rateLimit,
        policies,
      });
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get("/policies/resolve", async (req, res, next) => {
    try {
      if (!req.query.route) {
        throw createBadRequestError('The "route" query parameter is required.');
      }

      const resolvedPolicy = await policyService.resolvePolicy({
        apiKey: req.query.apiKey,
        method: req.query.method || "GET",
        route: req.query.route,
        subject: req.query.subject,
      });

      res.json({
        resolvedPolicy,
      });
    } catch (error) {
      next(error);
    }
  });

  adminRouter.put("/policies", async (req, res, next) => {
    try {
      const payload = getPolicyPayload(req.body || {});
      const policy = await policyService.upsertPolicy(payload);

      res.status(201).json({
        message: "Policy upserted.",
        policy,
      });
    } catch (error) {
      next(error);
    }
  });

  adminRouter.delete("/policies", async (req, res, next) => {
    try {
      const source = {
        ...req.query,
        ...(req.body || {}),
      };

      if (!source.route) {
        throw createBadRequestError('The "route" field is required for policy deletion.');
      }

      const deletionResult = await policyService.deletePolicy(getPolicyPayload(source));

      res.json({
        ...deletionResult,
      });
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get("/policies/examples", (req, res) => {
    res.json({
      examples: [
        {
          capacity: 20,
          method: "GET",
          refillRatePerSecond: 10,
          requestCost: 1,
          route: "/api/reports",
          subject: "client-premium",
        },
        {
          capacity: 5,
          method: "POST",
          refillRatePerSecond: 1,
          requestCost: 3,
          route: "/api/uploads",
          subject: "client-standard",
        },
      ],
    });
  });

  app.use("/admin", adminRouter);

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    const statusCode = error.statusCode || 500;

    if (statusCode >= 500) {
      console.error("Request handling error:", error);
    }

    return res.status(statusCode).json({
      error: error.code || "INTERNAL_SERVER_ERROR",
      message:
        statusCode === 400
          ? error.message
          : statusCode === 503
          ? "Rate limiter dependency is temporarily unavailable."
          : "Unexpected server error.",
    });
  });

  return app;
}

module.exports = {
  createApp,
};
