const {
  createTokenBucketRateLimiter,
  defaultKeyGenerator,
} = require("../src/middleware/createTokenBucketRateLimiter");

function createMockRequest(overrides = {}) {
  const headers = Object.fromEntries(
    Object.entries(overrides.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    baseUrl: "",
    get(headerName) {
      return headers[headerName.toLowerCase()];
    },
    ip: "127.0.0.1",
    method: "GET",
    path: "/api/limited",
    ...overrides,
  };
}

function createMockResponse() {
  const headers = {};

  return {
    body: undefined,
    headers,
    locals: {},
    statusCode: 200,
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      headers[name] = String(value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
}

describe("defaultKeyGenerator", () => {
  test("uses the API key when available", () => {
    const request = createMockRequest({
      headers: {
        "x-api-key": "client-123",
      },
    });

    expect(defaultKeyGenerator(request)).toBe("client-123:GET:_api_limited");
  });
});

describe("createTokenBucketRateLimiter", () => {
  test("allows requests and writes rate-limit headers", async () => {
    const bucketService = {
      consume: jest.fn().mockResolvedValue({
        allowed: true,
        capacity: 10,
        remaining: 9,
        resetAfterMs: 200,
        retryAfterMs: 0,
      }),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: false,
      requestCost: 1,
    });

    const request = createMockRequest();
    const response = createMockResponse();
    const next = jest.fn();

    await middleware(request, response, next);

    expect(bucketService.consume).toHaveBeenCalledWith({
      key: "127_0_0_1:GET:_api_limited",
      cost: 1,
    });
    expect(response.headers["X-RateLimit-Algorithm"]).toBe("token-bucket");
    expect(response.headers["X-RateLimit-Limit"]).toBe("10");
    expect(response.headers["X-RateLimit-Remaining"]).toBe("9");
    expect(response.headers["X-RateLimit-Reset-After"]).toBe("1");
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  test("rejects requests with a 429 when the bucket is empty", async () => {
    const bucketService = {
      consume: jest.fn().mockResolvedValue({
        allowed: false,
        capacity: 10,
        remaining: 0,
        resetAfterMs: 1000,
        retryAfterMs: 600,
      }),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: false,
      requestCost: 1,
    });

    const request = createMockRequest();
    const response = createMockResponse();
    const next = jest.fn();

    await middleware(request, response, next);

    expect(response.statusCode).toBe(429);
    expect(response.headers["Retry-After"]).toBe("1");
    expect(response.body.error).toBe("rate_limit_exceeded");
    expect(next).not.toHaveBeenCalled();
  });

  test("fails open when configured so traffic is not blocked by Redis errors", async () => {
    const bucketService = {
      consume: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: true,
      requestCost: 1,
    });

    const request = createMockRequest();
    const response = createMockResponse();
    const next = jest.fn();

    await middleware(request, response, next);

    expect(response.headers["X-RateLimit-Degraded"]).toBe("true");
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  test("fails closed when configured so backend outages are surfaced", async () => {
    const bucketService = {
      consume: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: false,
      requestCost: 1,
    });

    const request = createMockRequest();
    const response = createMockResponse();
    const next = jest.fn();

    await middleware(request, response, next);

    expect(next.mock.calls[0][0]).toMatchObject({
      code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
