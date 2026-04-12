const {
  RateLimitPolicyService,
} = require("../src/rateLimiter/rateLimitPolicyService");

class FakePipeline {
  constructor(store, redis) {
    this.commands = [];
    this.redis = redis;
    this.store = store;
  }

  hgetall(key) {
    this.commands.push(key);
    return this;
  }

  async exec() {
    this.redis.pipelineExecCount += 1;

    return this.commands.map((key) => [null, { ...(this.store.get(key) || {}) }]);
  }
}

class FakeRedis {
  constructor() {
    this.pipelineExecCount = 0;
    this.store = new Map();
  }

  pipeline() {
    return new FakePipeline(this.store, this);
  }

  async hset(key, ...entries) {
    const record = {};

    for (let index = 0; index < entries.length; index += 2) {
      record[entries[index]] = entries[index + 1];
    }

    this.store.set(key, record);
    return 1;
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  async scan(cursor, matchLabel, pattern) {
    const prefix = pattern.replace("*", "");
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix));

    return [cursor === "0" ? "0" : "0", keys];
  }
}

describe("RateLimitPolicyService", () => {
  test("falls back to the default policy when no Redis policy matches", async () => {
    const redis = new FakeRedis();
    const service = new RateLimitPolicyService({
      redis,
      cacheTtlMs: 5000,
      defaultPolicy: {
        capacity: 10,
        refillRatePerSecond: 5,
        requestCost: 1,
      },
    });

    const policy = await service.resolvePolicy({
      subject: "client-basic",
      method: "GET",
      route: "/api/limited",
    });

    expect(policy).toMatchObject({
      capacity: 10,
      refillRatePerSecond: 5,
      requestCost: 1,
      source: "default-config",
      subject: "*",
      method: "*",
      route: "*",
    });
  });

  test("prefers exact subject and route policies over broader wildcards", async () => {
    const redis = new FakeRedis();
    const service = new RateLimitPolicyService({
      redis,
      cacheTtlMs: 5000,
      defaultPolicy: {
        capacity: 10,
        refillRatePerSecond: 5,
        requestCost: 1,
      },
    });

    await service.upsertPolicy({
      subject: "client-premium",
      route: "*",
      method: "*",
      capacity: 50,
      refillRatePerSecond: 25,
      requestCost: 1,
    });
    await service.upsertPolicy({
      subject: "client-premium",
      route: "/api/reports",
      method: "GET",
      capacity: 5,
      refillRatePerSecond: 2,
      requestCost: 1,
    });

    const policy = await service.resolvePolicy({
      subject: "client-premium",
      method: "GET",
      route: "/api/reports",
    });

    expect(policy).toMatchObject({
      capacity: 5,
      refillRatePerSecond: 2,
      requestCost: 1,
      source: "redis",
      subject: "client-premium",
      method: "GET",
      route: "_api_reports",
    });
  });

  test("caches resolved policies and clears that cache after an upsert", async () => {
    const redis = new FakeRedis();
    const service = new RateLimitPolicyService({
      redis,
      cacheTtlMs: 5000,
      defaultPolicy: {
        capacity: 10,
        refillRatePerSecond: 5,
        requestCost: 1,
      },
    });

    await service.resolvePolicy({
      subject: "client-basic",
      method: "GET",
      route: "/api/limited",
    });
    await service.resolvePolicy({
      subject: "client-basic",
      method: "GET",
      route: "/api/limited",
    });

    expect(redis.pipelineExecCount).toBe(1);

    await service.upsertPolicy({
      subject: "client-basic",
      route: "/api/limited",
      method: "GET",
      capacity: 3,
      refillRatePerSecond: 1,
      requestCost: 1,
    });

    const policy = await service.resolvePolicy({
      subject: "client-basic",
      method: "GET",
      route: "/api/limited",
    });

    expect(redis.pipelineExecCount).toBe(2);
    expect(policy).toMatchObject({
      capacity: 3,
      refillRatePerSecond: 1,
      route: "_api_limited",
      source: "redis",
      subject: "client-basic",
    });
  });

  test("lists and deletes stored policies", async () => {
    const redis = new FakeRedis();
    const service = new RateLimitPolicyService({
      redis,
      cacheTtlMs: 5000,
      defaultPolicy: {
        capacity: 10,
        refillRatePerSecond: 5,
        requestCost: 1,
      },
    });

    await service.upsertPolicy({
      subject: "client-premium",
      route: "/api/reports",
      method: "GET",
      capacity: 8,
      refillRatePerSecond: 4,
      requestCost: 1,
    });

    const policies = await service.listPolicies();

    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      subject: "client-premium",
      method: "GET",
      route: "_api_reports",
    });

    const deletionResult = await service.deletePolicy({
      subject: "client-premium",
      route: "/api/reports",
      method: "GET",
    });

    expect(deletionResult.deleted).toBe(true);
    await expect(service.listPolicies()).resolves.toHaveLength(0);
  });
});
