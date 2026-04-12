const {
  TOKEN_BUCKET_COMMAND,
  TokenBucketService,
} = require("../src/rateLimiter/tokenBucketService");

class FakeRedis {
  constructor(response) {
    this.commandResponse = response;
    this.defineCommand = jest.fn((name, options) => {
      this.definedCommand = {
        name,
        options,
      };

      this[name] = jest.fn(async (...args) => {
        this.commandArgs = args;
        return this.commandResponse;
      });
    });
    this.ping = jest.fn().mockResolvedValue("PONG");
  }
}

describe("TokenBucketService", () => {
  test("registers the Lua command and maps Redis responses", async () => {
    const redis = new FakeRedis(["1", "9", "10", "0", "200", "1712500000000", "9"]);
    const service = new TokenBucketService({
      redis,
      capacity: 10,
      refillRatePerSecond: 5,
      ttlBufferMs: 1000,
    });

    const result = await service.consume({
      capacity: 10,
      cost: 2,
      key: "tenant-1:user-1:GET:_api_limited",
      refillRatePerSecond: 5,
      ttlBufferMs: 1000,
    });

    expect(redis.defineCommand).toHaveBeenCalled();
    expect(redis.definedCommand.name).toBe(TOKEN_BUCKET_COMMAND);
    expect(redis.definedCommand.options.numberOfKeys).toBe(1);
    expect(redis[TOKEN_BUCKET_COMMAND]).toHaveBeenCalledWith(
      "token_bucket:tenant-1:user-1:GET:_api_limited",
      "10",
      "5",
      "2",
      "1000"
    );
    expect(result).toEqual({
      allowed: true,
      capacity: 10,
      nowMs: 1712500000000,
      remaining: 9,
      resetAfterMs: 200,
      retryAfterMs: 0,
      tokens: 9,
    });
  });

  test("rejects invalid request costs before calling Redis", async () => {
    const redis = new FakeRedis(["1", "9", "10", "0", "200", "1712500000000", "9"]);
    const service = new TokenBucketService({
      redis,
      capacity: 10,
      refillRatePerSecond: 5,
      ttlBufferMs: 1000,
    });

    await expect(
      service.consume({
        key: "tenant-1:user-1:GET:_api_limited",
        cost: 0,
      })
    ).rejects.toThrow("Request cost must be a positive number.");

    expect(redis[TOKEN_BUCKET_COMMAND]).not.toHaveBeenCalled();
  });

  test("uses Redis for readiness checks", async () => {
    const redis = new FakeRedis(["1", "9", "10", "0", "200", "1712500000000", "9"]);
    const service = new TokenBucketService({
      redis,
      capacity: 10,
      refillRatePerSecond: 5,
      ttlBufferMs: 1000,
    });

    await expect(service.ping()).resolves.toBe("PONG");
    expect(redis.ping).toHaveBeenCalled();
  });

  test("allows per-request policy overrides", async () => {
    const redis = new FakeRedis(["1", "3", "4", "0", "250", "1712500000100", "3"]);
    const service = new TokenBucketService({
      redis,
      capacity: 10,
      refillRatePerSecond: 5,
      ttlBufferMs: 1000,
    });

    await service.consume({
      key: "tenant-1:user-1:POST:_api_uploads",
      capacity: 4,
      refillRatePerSecond: 2,
      cost: 1,
      ttlBufferMs: 500,
    });

    expect(redis[TOKEN_BUCKET_COMMAND]).toHaveBeenCalledWith(
      "token_bucket:tenant-1:user-1:POST:_api_uploads",
      "4",
      "2",
      "1",
      "500"
    );
  });
});
