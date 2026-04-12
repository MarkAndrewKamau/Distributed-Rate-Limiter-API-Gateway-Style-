require("dotenv").config();

const { createApp } = require("./app");
const { config } = require("./config");
const { createRedisClient } = require("./lib/redis");
const { RateLimitPolicyService } = require("./rateLimiter/rateLimitPolicyService");
const { TokenBucketService } = require("./rateLimiter/tokenBucketService");

async function start() {
  const redis = createRedisClient(config.redisUrl);
  await redis.connect();

  const bucketService = new TokenBucketService({
    redis,
    keyPrefix: config.rateLimit.keyPrefix,
    capacity: config.rateLimit.capacity,
    refillRatePerSecond: config.rateLimit.refillRatePerSecond,
    defaultRequestCost: config.rateLimit.requestCost,
    ttlBufferMs: config.rateLimit.ttlBufferMs,
  });
  const policyService = new RateLimitPolicyService({
    redis,
    cacheTtlMs: config.rateLimit.policyCacheTtlMs,
    defaultPolicy: {
      capacity: config.rateLimit.capacity,
      refillRatePerSecond: config.rateLimit.refillRatePerSecond,
      requestCost: config.rateLimit.requestCost,
    },
    keyPrefix: config.rateLimit.policyKeyPrefix,
  });

  const app = createApp({
    config,
    bucketService,
    policyService,
  });

  const server = app.listen(config.port, () => {
    console.log(`Rate limiter listening on port ${config.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully.`);

    server.close(async (serverError) => {
      if (serverError) {
        console.error("Server shutdown error:", serverError);
      }

      try {
        await redis.quit();
      } catch (redisError) {
        console.error("Redis shutdown error:", redisError);
      } finally {
        process.exit(serverError ? 1 : 0);
      }
    });

    setTimeout(() => {
      console.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error("Failed to start rate limiter:", error);
  process.exit(1);
});
