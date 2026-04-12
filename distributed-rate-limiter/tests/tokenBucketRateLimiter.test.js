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
  test("allows requests and writes rate-limit headers from the resolved policy", async () => {
    const bucketService = {
      consume: jest.fn().mockResolvedValue({
        allowed: true,
        capacity: 25,
        remaining: 23,
        resetAfterMs: 200,
        retryAfterMs: 0,
      }),
    };
    const policyService = {
      resolvePolicy: jest.fn().mockResolvedValue({
        capacity: 25,
        method: "GET",
        refillRatePerSecond: 10,
        requestCost: 2,
        route: "_api_limited",
        source: "redis",
        subject: "client-123",
      }),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: false,
      policyService,
    });

    const request = createMockRequest({
      headers: {
        "x-api-key": "client-123",
      },
    });
    const response = createMockResponse();
    const next = jest.fn();

    await middleware(request, response, next);

    expect(policyService.resolvePolicy).toHaveBeenCalledWith({
      bucketKey: "client-123:GET:_api_limited",
      method: "GET",
      route: "_api_limited",
      subject: "client-123",
    });
    expect(bucketService.consume).toHaveBeenCalledWith({
      capacity: 25,
      cost: 2,
      key: "client-123:GET:_api_limited",
      refillRatePerSecond: 10,
    });
    expect(response.headers["X-RateLimit-Algorithm"]).toBe("token-bucket");
    expect(response.headers["X-RateLimit-Limit"]).toBe("25");
    expect(response.headers["X-RateLimit-Remaining"]).toBe("23");
    expect(response.headers["X-RateLimit-Policy-Scope"]).toBe("client-123:GET:_api_limited");
    expect(response.headers["X-RateLimit-Policy-Source"]).toBe("redis");
    expect(response.headers["X-RateLimit-Request-Cost"]).toBe("2");
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
    const policyService = {
      resolvePolicy: jest.fn().mockResolvedValue({
        capacity: 10,
        method: "GET",
        refillRatePerSecond: 5,
        requestCost: 1,
        route: "_api_limited",
        source: "default-config",
        subject: "*",
      }),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: false,
      policyService,
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
      consume: jest.fn(),
    };
    const policyService = {
      resolvePolicy: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: true,
      policyService,
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
    const policyService = {
      resolvePolicy: jest.fn().mockResolvedValue({
        capacity: 10,
        method: "GET",
        refillRatePerSecond: 5,
        requestCost: 1,
        route: "_api_limited",
        source: "default-config",
        subject: "*",
      }),
    };

    const middleware = createTokenBucketRateLimiter({
      bucketService,
      failOpen: false,
      policyService,
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
