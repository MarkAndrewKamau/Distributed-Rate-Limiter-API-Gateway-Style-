function parsePositiveNumber(name, fallback) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive number. Received "${rawValue}".`);
  }

  return parsedValue;
}

function parsePort(name, fallback) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer. Received "${rawValue}".`);
  }

  return parsedValue;
}

function parseBoolean(name, fallback) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const normalizedValue = rawValue.toLowerCase();

  if (["true", "1", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${name} must be a boolean. Received "${rawValue}".`);
}

const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parsePort("PORT", 3000),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  rateLimit: {
    keyPrefix: process.env.RATE_LIMIT_KEY_PREFIX || "token_bucket",
    policyCacheTtlMs: parsePositiveNumber("RATE_LIMIT_POLICY_CACHE_TTL_MS", 5000),
    policyKeyPrefix: process.env.RATE_LIMIT_POLICY_KEY_PREFIX || "rate_limit_policy",
    capacity: parsePositiveNumber("RATE_LIMIT_CAPACITY", 10),
    refillRatePerSecond: parsePositiveNumber("RATE_LIMIT_REFILL_RATE_PER_SECOND", 5),
    requestCost: parsePositiveNumber("RATE_LIMIT_REQUEST_COST", 1),
    ttlBufferMs: parsePositiveNumber("RATE_LIMIT_TTL_BUFFER_MS", 1000),
    failOpen: parseBoolean("RATE_LIMIT_FAIL_OPEN", true),
  },
};

module.exports = {
  config,
};
