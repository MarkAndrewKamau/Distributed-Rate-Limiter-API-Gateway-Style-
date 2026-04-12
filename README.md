# Distributed Rate Limiter API Gateway

A hands-on system design project that implements a distributed, Redis-backed token bucket rate limiter behind an API gateway.

This project is built to practice the thought process behind designing real backend systems:

- breaking the system into components
- choosing Redis, gateway, and policy storage sensibly
- understanding request flow and failure modes
- making tradeoffs instead of chasing a "perfect" design

The current implementation includes:

- an `NGINX` edge proxy
- a `Node.js + Express` rate-limiter service
- a `Redis` shared state store
- an atomic Redis `Lua` token bucket
- dynamic per-tenant and per-route policies
- secured admin policy management endpoints

## Architecture

```text
Client
  |
  v
NGINX (edge proxy, port 8080 in Docker)
  |
  v
Express rate limiter service (port 3000)
  |
  v
Redis
  - token bucket state
  - dynamic rate-limit policies
```

## Why This Design

### Why Redis

Rate limiting lives on the hot path, so we want:

- very low latency
- atomic read-modify-write behavior
- simple shared state across multiple gateway instances

Redis fits that well. It is a better first choice than a relational database for token bucket state because counters and refill logic need to be fast and concurrency-safe.

### Why Lua

In distributed systems, race conditions happen when multiple gateway instances try to update the same bucket at the same time.

This project avoids that by running the token bucket logic inside Redis with a Lua script. That gives us:

- one round trip for refill + consume
- atomic execution
- consistent server-side time using Redis `TIME`

### Why Dynamic Policies

A real API gateway rarely has one global limit for everyone. Different tenants and routes usually need different limits, refill rates, and costs.

This project supports:

- per-subject policies
- per-method policies
- per-route policies
- wildcard fallback when no exact match exists

## Core Features

### 1. Token Bucket Rate Limiting

The gateway uses a token bucket algorithm:

- each client/route combination gets a bucket
- a bucket has a `capacity`
- tokens refill over time at `refillRatePerSecond`
- each request consumes `requestCost` tokens
- when not enough tokens remain, the service returns `429`

### 2. Dynamic Policy Resolution

Policies are stored in Redis and resolved per request.

Matching precedence is:

1. exact `subject + method + route`
2. subject-specific wildcard combinations
3. global wildcard combinations
4. default config fallback

That means you can support examples like:

- premium clients getting higher limits
- expensive `POST` routes costing more than `GET`
- one route having stricter limits than the rest of the API

### 3. Secured Admin Routes

All `/admin` routes are protected.

Supported auth mechanisms:

- `Authorization: Bearer <admin-key>`
- `x-admin-api-key: <admin-key>`

Important behavior:

- if no admin key is configured, admin routes fail closed with `503`
- invalid or missing credentials return `401`
- timing-safe comparison is used for key matching

### 4. Local Policy Cache

Resolved policies are cached in-memory per application instance for a short TTL.

This reduces Redis lookups for hot keys while still allowing policy changes to take effect after cache invalidation or TTL expiry.

## Request Flow

### Limited Request Flow

1. A client sends a request to the gateway.
2. NGINX forwards the request to the Express service.
3. The service builds a request identity from headers, method, and route.
4. The policy service resolves the correct policy for that request.
5. The token bucket service calls a Redis Lua script atomically.
6. Redis decides whether the request is allowed or rejected.
7. If allowed, the service responds normally with rate-limit headers.
8. If rejected, the service returns `429` with `Retry-After`.

### Admin Policy Update Flow

1. An authenticated admin calls `/admin/policies`.
2. The request passes through admin auth middleware.
3. The policy payload is normalized and validated.
4. The policy is written to Redis.
5. The local policy cache is cleared.
6. Future requests begin resolving against the updated policy.

## Public Endpoints

### Health and Readiness

- `GET /health`
- `GET /ready`

### Demo Routes

- `GET /api/unlimited`
- `GET /api/limited`
- `GET /api/reports`
- `POST /api/uploads`

These routes demonstrate how the token bucket applies to different request patterns.

## Admin Endpoints

All admin routes require an admin API key.

- `GET /admin/policies`
- `GET /admin/policies/resolve`
- `PUT /admin/policies`
- `DELETE /admin/policies`
- `GET /admin/policies/examples`

## Environment Variables

The app loads environment variables from either:

- `distributed-rate-limiter/.env`
- repo root `.env`

Useful variables:

```env
ADMIN_API_KEYS=local-dev-admin-key
ADMIN_AUTH_REALM=rate-limiter-admin
PORT=3000
REDIS_URL=redis://127.0.0.1:6379

RATE_LIMIT_KEY_PREFIX=token_bucket
RATE_LIMIT_POLICY_KEY_PREFIX=rate_limit_policy
RATE_LIMIT_POLICY_CACHE_TTL_MS=5000

RATE_LIMIT_CAPACITY=10
RATE_LIMIT_REFILL_RATE_PER_SECOND=5
RATE_LIMIT_REQUEST_COST=1
RATE_LIMIT_TTL_BUFFER_MS=1000
RATE_LIMIT_FAIL_OPEN=true
```

## Running Locally

### 1. Install dependencies

```bash
cd distributed-rate-limiter
npm install
```

### 2. Create an env file

You can create either:

- `distributed-rate-limiter/.env`
- `.env` at the repo root

Example:

```env
ADMIN_API_KEYS=local-dev-admin-key
REDIS_URL=redis://127.0.0.1:6379
RATE_LIMIT_CAPACITY=10
RATE_LIMIT_REFILL_RATE_PER_SECOND=5
RATE_LIMIT_REQUEST_COST=1
RATE_LIMIT_POLICY_CACHE_TTL_MS=5000
RATE_LIMIT_FAIL_OPEN=true
```

### 3. Start Redis

If you already have Redis installed locally:

```bash
redis-server
```

### 4. Start the app

```bash
cd distributed-rate-limiter
npm start
```

The service will start on `http://localhost:3000`.

## Running with Docker Compose

From the `distributed-rate-limiter` directory:

```bash
docker compose up --build
```

Services:

- NGINX: `http://localhost:8080`
- app: `http://localhost:3000`
- Redis: `localhost:6379`

## Example Requests

### Public Route

```bash
curl http://localhost:3000/api/limited
```

### Create a Policy

```bash
curl -X PUT http://localhost:3000/admin/policies \
  -H 'Authorization: Bearer local-dev-admin-key' \
  -H 'Content-Type: application/json' \
  -d '{"subject":"client-premium","method":"GET","route":"/api/reports","capacity":20,"refillRatePerSecond":10,"requestCost":1}'
```

### Resolve a Policy

```bash
curl -H 'x-admin-api-key: local-dev-admin-key' \
  "http://localhost:3000/admin/policies/resolve?subject=client-premium&method=GET&route=/api/reports"
```

### Call a Protected Route with a Client Identity

```bash
curl http://localhost:3000/api/reports \
  -H 'x-api-key: client-premium'
```

### List Policies

```bash
curl -H 'x-admin-api-key: local-dev-admin-key' \
  http://localhost:3000/admin/policies
```

## Internal Key Normalization

You may notice route values such as `_api_reports` in Redis-backed responses.

That is expected. Internally, request scope values are normalized into safe key segments before being used as Redis keys. The external route is still `/api/reports`; the normalized form is only for internal storage and matching.

## Testing

Run the test suite from `distributed-rate-limiter`:

```bash
npm test
```

Current test coverage focuses on:

- token bucket behavior
- middleware integration
- policy resolution and cache invalidation
- admin route authentication

## Tradeoffs and Design Notes

### Chosen Tradeoffs

- Redis is on the hot path because speed matters more than durable relational semantics here.
- Policy lookup uses Redis plus a small local cache because it keeps the system simple and fast enough for this stage.
- Admin auth uses static API keys because they are easy to reason about while learning system design.
- Rate limiting can be configured to fail open if the backend is unavailable, which favors availability over strict enforcement.

### Current Limitations

- policy changes are not yet audit logged
- admin auth is static-key based, not IAM or OAuth based
- there is no multi-region replication strategy yet
- local caches are per instance, so policy propagation is eventually consistent across nodes
- policies are stored in Redis rather than a separate durable configuration database

## Possible Next Steps

- add audit logging for admin policy mutations
- persist policy changes in a relational database and use Redis as a cache
- add admin key rotation support
- add metrics for allowed, rejected, degraded, and cache-hit requests
- simulate multiple gateway instances under load with `autocannon`
- extend policy matching to support tenant plans and route groups

## Project Layout

```text
.
├── README.md
└── distributed-rate-limiter
    ├── docker-compose.yml
    ├── nginx.conf
    ├── src
    │   ├── app.js
    │   ├── config.js
    │   ├── index.js
    │   ├── lib
    │   │   └── redis.js
    │   ├── middleware
    │   │   ├── createAdminAuthMiddleware.js
    │   │   └── createTokenBucketRateLimiter.js
    │   └── rateLimiter
    │       ├── rateLimitPolicyService.js
    │       ├── requestContext.js
    │       └── tokenBucketService.js
    └── tests
        ├── adminRoutesAuth.test.js
        ├── rateLimitPolicyService.test.js
        ├── tokenBucketRateLimiter.test.js
        └── tokenBucketService.test.js
```

## Summary

This repo is not just a rate limiter demo. It is a small, evolving API gateway project designed to practice real system design tradeoffs:

- correctness under concurrency
- distributed coordination through Redis
- dynamic policy management
- secure administrative control
- explainable architecture decisions

If you are studying system design step by step, this is a strong base to iterate on.
