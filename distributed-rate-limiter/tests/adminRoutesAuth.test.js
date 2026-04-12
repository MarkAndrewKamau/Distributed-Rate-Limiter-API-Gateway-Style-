const http = require("node:http");

const { createApp } = require("../src/app");

function createConfig(overrides = {}) {
  return {
    admin: {
      apiKeys: ["local-admin-key"],
      realm: "rate-limiter-admin",
      ...(overrides.admin || {}),
    },
    nodeEnv: "test",
    port: 0,
    rateLimit: {
      capacity: 10,
      failOpen: true,
      keyPrefix: "token_bucket",
      policyCacheTtlMs: 5000,
      policyKeyPrefix: "rate_limit_policy",
      refillRatePerSecond: 5,
      requestCost: 1,
      ttlBufferMs: 1000,
      ...(overrides.rateLimit || {}),
    },
    redisUrl: "redis://127.0.0.1:6379",
  };
}

function createServices(overrides = {}) {
  return {
    bucketService: {
      ping: jest.fn().mockResolvedValue("PONG"),
      ...(overrides.bucketService || {}),
    },
    policyService: {
      deletePolicy: jest.fn().mockResolvedValue({ deleted: true, scope: {} }),
      listPolicies: jest.fn().mockResolvedValue([]),
      resolvePolicy: jest.fn().mockResolvedValue({}),
      upsertPolicy: jest.fn().mockResolvedValue({}),
      ...(overrides.policyService || {}),
    },
  };
}

async function startServer({ configOverrides, serviceOverrides } = {}) {
  const config = createConfig(configOverrides);
  const services = createServices(serviceOverrides);
  const app = createApp({
    config,
    bucketService: services.bucketService,
    policyService: services.policyService,
  });

  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    config,
    port: server.address().port,
    server,
    services,
  };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function makeRequest(port, { body, headers = {}, method = "GET", path = "/" }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        headers,
        hostname: "127.0.0.1",
        method,
        path,
        port,
      },
      (response) => {
        let rawBody = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          rawBody += chunk;
        });
        response.on("end", () => {
          resolve({
            body: rawBody ? JSON.parse(rawBody) : null,
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      }
    );

    request.on("error", reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

describe("admin policy routes authentication", () => {
  test("rejects unauthenticated admin requests", async () => {
    const { port, server, services } = await startServer();

    try {
      const response = await makeRequest(port, {
        path: "/admin/policies",
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe('Bearer realm="rate-limiter-admin"');
      expect(response.body).toEqual({
        error: "UNAUTHORIZED",
        message: "Valid admin credentials are required for this route.",
      });
      expect(services.policyService.listPolicies).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  test("fails closed when admin authentication is not configured", async () => {
    const { port, server, services } = await startServer({
      configOverrides: {
        admin: {
          apiKeys: [],
        },
      },
    });

    try {
      const response = await makeRequest(port, {
        path: "/admin/policies",
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).toEqual({
        error: "ADMIN_AUTH_UNAVAILABLE",
        message: "Admin authentication is not configured.",
      });
      expect(services.policyService.listPolicies).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  test("accepts the x-admin-api-key header for admin reads", async () => {
    const { port, server, services } = await startServer({
      serviceOverrides: {
        policyService: {
          listPolicies: jest.fn().mockResolvedValue([
            {
              capacity: 20,
              method: "GET",
              refillRatePerSecond: 10,
              requestCost: 1,
              route: "_api_reports",
              source: "redis",
              subject: "client-premium",
            },
          ]),
        },
      },
    });

    try {
      const response = await makeRequest(port, {
        headers: {
          "x-admin-api-key": "local-admin-key",
        },
        path: "/admin/policies",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.count).toBe(1);
      expect(services.policyService.listPolicies).toHaveBeenCalledTimes(1);
    } finally {
      await stopServer(server);
    }
  });

  test("accepts bearer tokens for admin writes", async () => {
    const upsertPolicy = jest.fn().mockResolvedValue({
      capacity: 20,
      method: "GET",
      refillRatePerSecond: 10,
      requestCost: 1,
      route: "_api_reports",
      source: "redis",
      subject: "client-premium",
    });
    const { port, server, services } = await startServer({
      serviceOverrides: {
        policyService: {
          upsertPolicy,
        },
      },
    });

    try {
      const response = await makeRequest(port, {
        body: JSON.stringify({
          capacity: 20,
          method: "GET",
          refillRatePerSecond: 10,
          requestCost: 1,
          route: "/api/reports",
          subject: "client-premium",
        }),
        headers: {
          authorization: "Bearer local-admin-key",
          "content-type": "application/json",
        },
        method: "PUT",
        path: "/admin/policies",
      });

      expect(response.statusCode).toBe(201);
      expect(services.policyService.upsertPolicy).toHaveBeenCalledWith({
        apiKey: undefined,
        capacity: 20,
        method: "GET",
        refillRatePerSecond: 10,
        requestCost: 1,
        route: "/api/reports",
        subject: "client-premium",
      });
      expect(response.body.message).toBe("Policy upserted.");
    } finally {
      await stopServer(server);
    }
  });
});
