import { RedisStore } from "@hono-rate-limiter/redis";
import { Redis } from "@upstash/redis";
import { rateLimiter } from "hono-rate-limiter";

const getNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getAuthToken = (
  authHeader: string | null,
  tokenHeader: string | null
) => {
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  if (tokenHeader?.length) {
    return tokenHeader;
  }
  return null;
};

const getRateLimitKey = (headers: Headers) => {
  const token = getAuthToken(
    headers.get("authorization"),
    headers.get("x-forksd-token")
  );
  if (token) {
    return `token:${token}`;
  }
  const ip =
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for");
  if (ip) {
    return `ip:${ip}`;
  }
  return "unknown";
};

export const rateLimit = (() => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!(url && token)) {
    return async (_c: import("hono").Context, next: () => Promise<void>) => {
      await next();
    };
  }

  const windowMs = getNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
  const limit = getNumber(process.env.RATE_LIMIT_MAX, 100);
  const redis = Redis.fromEnv();
  const store = new RedisStore({ client: redis });

  return rateLimiter({
    windowMs,
    limit,
    standardHeaders: "draft-6",
    keyGenerator: (c) => getRateLimitKey(c.req.raw.headers),
    store,
  });
})();
