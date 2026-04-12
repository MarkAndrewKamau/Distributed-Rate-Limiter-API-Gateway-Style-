const {
  WILDCARD_SCOPE,
  normalizeScopeValue,
} = require("./requestContext");

function createPolicyValidationError(message) {
  const error = new Error(message);
  error.code = "INVALID_RATE_LIMIT_POLICY";
  error.statusCode = 400;
  return error;
}

function parsePositivePolicyNumber(name, value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw createPolicyValidationError(`${name} must be a positive number. Received "${value}".`);
  }

  return numericValue;
}

function normalizePolicyScope(input = {}) {
  return {
    subject: normalizeScopeValue(input.subject ?? input.apiKey, WILDCARD_SCOPE),
    method: normalizeScopeValue(input.method, WILDCARD_SCOPE),
    route: normalizeScopeValue(input.route, WILDCARD_SCOPE),
  };
}

function sortPolicies(left, right) {
  return `${left.subject}:${left.method}:${left.route}`.localeCompare(
    `${right.subject}:${right.method}:${right.route}`
  );
}

class RateLimitPolicyService {
  constructor({
    redis,
    keyPrefix = "rate_limit_policy",
    cacheTtlMs = 5000,
    defaultPolicy,
  }) {
    if (!redis) {
      throw new Error("A Redis client is required for RateLimitPolicyService.");
    }

    this.redis = redis;
    this.keyPrefix = keyPrefix;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
    this.defaultPolicy = this.normalizePolicyNumbers(defaultPolicy || {});
  }

  normalizePolicyNumbers(policy) {
    return {
      capacity: parsePositivePolicyNumber("capacity", policy.capacity),
      refillRatePerSecond: parsePositivePolicyNumber(
        "refillRatePerSecond",
        policy.refillRatePerSecond
      ),
      requestCost: parsePositivePolicyNumber("requestCost", policy.requestCost),
    };
  }

  buildRedisKey(scope) {
    return `${this.keyPrefix}:${scope.subject}:${scope.method}:${scope.route}`;
  }

  buildLookupChain(scope) {
    const candidates = [
      { subject: scope.subject, method: scope.method, route: scope.route },
      { subject: scope.subject, method: WILDCARD_SCOPE, route: scope.route },
      { subject: scope.subject, method: scope.method, route: WILDCARD_SCOPE },
      { subject: scope.subject, method: WILDCARD_SCOPE, route: WILDCARD_SCOPE },
      { subject: WILDCARD_SCOPE, method: scope.method, route: scope.route },
      { subject: WILDCARD_SCOPE, method: WILDCARD_SCOPE, route: scope.route },
      { subject: WILDCARD_SCOPE, method: scope.method, route: WILDCARD_SCOPE },
      { subject: WILDCARD_SCOPE, method: WILDCARD_SCOPE, route: WILDCARD_SCOPE },
    ];

    const deduplicated = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const candidateKey = `${candidate.subject}:${candidate.method}:${candidate.route}`;

      if (!seen.has(candidateKey)) {
        seen.add(candidateKey);
        deduplicated.push(candidate);
      }
    }

    return deduplicated;
  }

  buildCacheKey(scope) {
    return `${scope.subject}:${scope.method}:${scope.route}`;
  }

  getCachedPolicy(cacheKey) {
    if (this.cacheTtlMs <= 0) {
      return null;
    }

    const cachedEntry = this.cache.get(cacheKey);

    if (!cachedEntry) {
      return null;
    }

    if (cachedEntry.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }

    return {
      ...cachedEntry.policy,
      cacheHit: true,
    };
  }

  setCachedPolicy(cacheKey, policy) {
    if (this.cacheTtlMs <= 0) {
      return;
    }

    this.cache.set(cacheKey, {
      expiresAt: Date.now() + this.cacheTtlMs,
      policy: {
        ...policy,
        cacheHit: false,
      },
    });
  }

  clearCache() {
    this.cache.clear();
  }

  deserializePolicy(hash, scope, source) {
    if (!hash || Object.keys(hash).length === 0) {
      return null;
    }

    return {
      ...scope,
      ...this.normalizePolicyNumbers(hash),
      cacheHit: false,
      source,
    };
  }

  async resolvePolicy(scopeInput) {
    const requestedScope = normalizePolicyScope(scopeInput);
    const cacheKey = this.buildCacheKey(requestedScope);
    const cachedPolicy = this.getCachedPolicy(cacheKey);

    if (cachedPolicy) {
      return cachedPolicy;
    }

    const lookupChain = this.buildLookupChain(requestedScope);
    const pipeline = this.redis.pipeline();

    for (const scope of lookupChain) {
      pipeline.hgetall(this.buildRedisKey(scope));
    }

    const results = await pipeline.exec();

    for (let index = 0; index < results.length; index += 1) {
      const [error, hash] = results[index];

      if (error) {
        throw error;
      }

      const matchedScope = lookupChain[index];
      const policy = this.deserializePolicy(hash, matchedScope, "redis");

      if (policy) {
        this.setCachedPolicy(cacheKey, policy);
        return policy;
      }
    }

    const defaultPolicy = {
      subject: WILDCARD_SCOPE,
      method: WILDCARD_SCOPE,
      route: WILDCARD_SCOPE,
      ...this.defaultPolicy,
      cacheHit: false,
      source: "default-config",
    };

    this.setCachedPolicy(cacheKey, defaultPolicy);
    return defaultPolicy;
  }

  async upsertPolicy(input) {
    const scope = normalizePolicyScope(input);
    const policyNumbers = this.normalizePolicyNumbers(input);
    const redisKey = this.buildRedisKey(scope);
    const record = {
      ...scope,
      capacity: String(policyNumbers.capacity),
      refillRatePerSecond: String(policyNumbers.refillRatePerSecond),
      requestCost: String(policyNumbers.requestCost),
    };

    await this.redis.hset(redisKey, ...Object.entries(record).flat());
    this.clearCache();

    return {
      ...scope,
      ...policyNumbers,
      cacheHit: false,
      source: "redis",
    };
  }

  async deletePolicy(scopeInput) {
    const scope = normalizePolicyScope(scopeInput);
    const deletedCount = await this.redis.del(this.buildRedisKey(scope));

    this.clearCache();

    return {
      deleted: deletedCount > 0,
      scope,
    };
  }

  async listPolicies() {
    const policies = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${this.keyPrefix}:*`,
        "COUNT",
        100
      );

      cursor = nextCursor;

      if (keys.length === 0) {
        continue;
      }

      const pipeline = this.redis.pipeline();

      for (const key of keys) {
        pipeline.hgetall(key);
      }

      const results = await pipeline.exec();

      for (const [error, hash] of results) {
        if (error) {
          throw error;
        }

        const policy = this.deserializePolicy(
          hash,
          {
            method: hash.method,
            route: hash.route,
            subject: hash.subject,
          },
          "redis"
        );

        if (policy) {
          policies.push(policy);
        }
      }
    } while (cursor !== "0");

    return policies.sort(sortPolicies);
  }
}

module.exports = {
  RateLimitPolicyService,
  createPolicyValidationError,
  normalizePolicyScope,
};
