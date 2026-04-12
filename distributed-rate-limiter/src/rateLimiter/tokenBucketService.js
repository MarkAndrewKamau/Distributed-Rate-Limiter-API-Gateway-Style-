const TOKEN_BUCKET_COMMAND = "consumeTokenBucket";

const TOKEN_BUCKET_LUA = `
local bucket_key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local requested_tokens = tonumber(ARGV[3])
local ttl_buffer_ms = tonumber(ARGV[4])

local redis_time = redis.call("TIME")
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)

local bucket = redis.call("HMGET", bucket_key, "tokens", "last_refill_ms")
local tokens = tonumber(bucket[1])
local last_refill_ms = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
end

tokens = math.min(tokens, capacity)

if last_refill_ms == nil then
  last_refill_ms = now_ms
end

if now_ms < last_refill_ms then
  now_ms = last_refill_ms
end

local elapsed_ms = now_ms - last_refill_ms

if elapsed_ms > 0 then
  local replenished_tokens = (elapsed_ms / 1000) * refill_rate
  tokens = math.min(capacity, tokens + replenished_tokens)
end

local allowed = 0
local retry_after_ms = 0

if tokens >= requested_tokens then
  allowed = 1
  tokens = tokens - requested_tokens
else
  retry_after_ms = math.ceil(((requested_tokens - tokens) / refill_rate) * 1000)
end

if tokens < 0 then
  tokens = 0
end

local remaining_tokens = math.floor(tokens)
local reset_after_ms = math.ceil(((capacity - tokens) / refill_rate) * 1000)
local ttl_ms = math.max(reset_after_ms + ttl_buffer_ms, ttl_buffer_ms)

redis.call("HSET", bucket_key, "tokens", tostring(tokens), "last_refill_ms", tostring(now_ms))
redis.call("PEXPIRE", bucket_key, ttl_ms)

return {
  allowed,
  tostring(remaining_tokens),
  tostring(capacity),
  tostring(retry_after_ms),
  tostring(reset_after_ms),
  tostring(now_ms),
  tostring(tokens)
}
`;

function parseNumericField(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    throw new Error(`Unable to parse numeric Redis response value "${value}".`);
  }

  return numericValue;
}

function ensureTokenBucketCommand(redis) {
  if (typeof redis[TOKEN_BUCKET_COMMAND] === "function") {
    return;
  }

  redis.defineCommand(TOKEN_BUCKET_COMMAND, {
    numberOfKeys: 1,
    lua: TOKEN_BUCKET_LUA,
  });
}

class TokenBucketService {
  constructor({
    redis,
    keyPrefix = "token_bucket",
    capacity,
    refillRatePerSecond,
    defaultRequestCost = 1,
    ttlBufferMs = 1000,
  }) {
    if (!redis) {
      throw new Error("A Redis client is required for TokenBucketService.");
    }

    this.redis = redis;
    this.keyPrefix = keyPrefix;
    this.capacity = capacity;
    this.refillRatePerSecond = refillRatePerSecond;
    this.defaultRequestCost = defaultRequestCost;
    this.ttlBufferMs = ttlBufferMs;

    ensureTokenBucketCommand(this.redis);
  }

  buildKey(key) {
    return `${this.keyPrefix}:${key}`;
  }

  async consume({
    key,
    capacity = this.capacity,
    refillRatePerSecond = this.refillRatePerSecond,
    cost = this.defaultRequestCost,
    ttlBufferMs = this.ttlBufferMs,
  }) {
    if (!key) {
      throw new Error("A bucket key is required.");
    }

    const normalizedCapacity = Number(capacity);
    const normalizedRefillRatePerSecond = Number(refillRatePerSecond);
    const normalizedCost = Number(cost);
    const normalizedTtlBufferMs = Number(ttlBufferMs);

    if (!Number.isFinite(normalizedCapacity) || normalizedCapacity <= 0) {
      throw new Error(`Bucket capacity must be a positive number. Received "${capacity}".`);
    }

    if (
      !Number.isFinite(normalizedRefillRatePerSecond) ||
      normalizedRefillRatePerSecond <= 0
    ) {
      throw new Error(
        `Refill rate must be a positive number. Received "${refillRatePerSecond}".`
      );
    }

    if (!Number.isFinite(normalizedCost) || normalizedCost <= 0) {
      throw new Error(`Request cost must be a positive number. Received "${cost}".`);
    }

    if (!Number.isFinite(normalizedTtlBufferMs) || normalizedTtlBufferMs <= 0) {
      throw new Error(`TTL buffer must be a positive number. Received "${ttlBufferMs}".`);
    }

    const response = await this.redis[TOKEN_BUCKET_COMMAND](
      this.buildKey(key),
      String(normalizedCapacity),
      String(normalizedRefillRatePerSecond),
      String(normalizedCost),
      String(normalizedTtlBufferMs)
    );

    const [
      allowed,
      remaining,
      returnedCapacity,
      retryAfterMs,
      resetAfterMs,
      nowMs,
      tokens,
    ] = response;

    return {
      allowed: parseNumericField(allowed) === 1,
      remaining: parseNumericField(remaining),
      capacity: parseNumericField(returnedCapacity),
      retryAfterMs: parseNumericField(retryAfterMs),
      resetAfterMs: parseNumericField(resetAfterMs),
      nowMs: parseNumericField(nowMs),
      tokens: parseNumericField(tokens),
    };
  }

  async ping() {
    return this.redis.ping();
  }
}

module.exports = {
  TOKEN_BUCKET_COMMAND,
  TOKEN_BUCKET_LUA,
  TokenBucketService,
};
