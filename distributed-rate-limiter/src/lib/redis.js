const Redis = require("ioredis");

function createRedisClient(redisUrl) {
  const redis = new Redis(redisUrl, {
    connectTimeout: 5000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy(attempt) {
      return Math.min(attempt * 50, 500);
    },
  });

  redis.on("error", (error) => {
    console.error("Redis connection error:", error.message);
  });

  return redis;
}

module.exports = {
  createRedisClient,
};
