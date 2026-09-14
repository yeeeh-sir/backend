/* =========================================================
   RUBavu Today — PUBLIC RATE LIMITER (per-instance)

   Lightweight sliding-window limiter for read-heavy public
   endpoints. It prevents accidental abuse (crawlers, scrapers,
   a runaway client) without needing a dependency.

   Notes:
   - Counters live in process memory only. They are NOT
     authoritative shared state: rate limiting is best-effort and
     each instance keeps its own window, which is the correct
     behaviour for a load-balanced deployment.
   - Limits are deliberately generous so normal Rubavu Today
     visitors are never blocked.
   - Admin/auth endpoints are already protected by their own,
     stricter login rate limiter (see server.js).
========================================================== */

const DEFAULT_WINDOW_MS = 60 * 1000;

const DEFAULT_PUBLIC_MAX = Number(
  process.env.PUBLIC_RATE_LIMIT_MAX || 600
);

const PUBLIC_RATE_LIMIT_MAX =
  Number.isFinite(DEFAULT_PUBLIC_MAX) && DEFAULT_PUBLIC_MAX > 0
    ? DEFAULT_PUBLIC_MAX
    : 600;

const buckets = new Map();

function getClientIp(req) {
  const forwarded = String(
    req.headers['x-forwarded-for'] || ''
  ).split(',')[0].trim();

  return (
    forwarded ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown'
  );
}

function createPublicRateLimiter({
  max = PUBLIC_RATE_LIMIT_MAX,
  windowMs = DEFAULT_WINDOW_MS,
  message = 'Too many requests. Please try again later.',
} = {}) {
  return function publicRateLimiter(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    const ip = getClientIp(req);
    const key = ip;
    const now = Date.now();

    let entry = buckets.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, count: 0 };
      buckets.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));

      return res.status(429).json({ error: message });
    }

    return next();
  };
}

/* Prevent unbounded memory growth from unique IPs. */
setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of buckets) {
    if (now - entry.windowStart >= DEFAULT_WINDOW_MS) {
      buckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  createPublicRateLimiter,
  getClientIp,
};