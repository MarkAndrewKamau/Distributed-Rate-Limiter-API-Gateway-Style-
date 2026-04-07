const express = require("express");

const {
  createTokenBucketRateLimiter,
} = require("./middleware/createTokenBucketRateLimiter");

function createApp({ config, bucketService }) {
  if (!config) {
    throw new Error("config is required.");
  }

  if (!bucketService) {
    throw new Error("bucketService is required.");
  }

  const app = express();
  const rateLimitMiddleware = createTokenBucketRateLimiter({
    bucketService,
    failOpen: config.rateLimit.failOpen,
    requestCost: config.rateLimit.requestCost,
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
    const decision = res.locals.rateLimit || {};

    res.json({
      message: "Request accepted by the token bucket.",
      rateLimit: {
        algorithm: "token-bucket",
        capacity: decision.capacity,
        remaining: decision.remaining,
        resetAfterMs: decision.resetAfterMs,
      },
    });
  });

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
        statusCode === 503
          ? "Rate limiter dependency is temporarily unavailable."
          : "Unexpected server error.",
    });
  });

  return app;
}

module.exports = {
  createApp,
};
