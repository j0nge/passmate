import { Redis } from "@upstash/redis";

const STATE_KEY = "passmate:state";

function getRedis() {
  // Try a sequence of well-known env var names. Vercel's Upstash/KV
  // integration historically uses KV_REST_API_*, the standalone Upstash
  // integration uses UPSTASH_REDIS_REST_*, and some newer flows let the
  // user pick a custom prefix (e.g. STORAGE_KV_REST_API_URL).
  const candidates = [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["STORAGE_KV_REST_API_URL", "STORAGE_KV_REST_API_TOKEN"],
  ];
  for (const [urlKey, tokenKey] of candidates) {
    if (process.env[urlKey] && process.env[tokenKey]) {
      return new Redis({ url: process.env[urlKey], token: process.env[tokenKey] });
    }
  }
  // Last resort: scan env for any *_KV_REST_API_URL / *_KV_REST_API_TOKEN pair
  const keys = Object.keys(process.env);
  const urlKey = keys.find((k) => /KV_REST_API_URL$/.test(k));
  if (urlKey) {
    const tokenKey = urlKey.replace(/_URL$/, "_TOKEN");
    if (process.env[urlKey] && process.env[tokenKey]) {
      return new Redis({ url: process.env[urlKey], token: process.env[tokenKey] });
    }
  }
  return null;
}

function listKvLikeEnv() {
  return Object.keys(process.env)
    .filter((k) => /KV|UPSTASH|REDIS/.test(k))
    .sort();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({
      error: "KV not configured",
      hint: "Connect an Upstash for Redis (Vercel KV) database to this project and redeploy.",
      detected: listKvLikeEnv(),
    });
  }

  try {
    if (req.method === "GET") {
      const state = await redis.get(STATE_KEY);
      return res.status(200).json({ state: state || null, ts: Date.now() });
    }
    if (req.method === "POST" || req.method === "PUT") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) {
          return res.status(400).json({ error: "Invalid JSON body" });
        }
      }
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Body must be a JSON object" });
      }
      await redis.set(STATE_KEY, body);
      return res.status(200).json({ ok: true, ts: Date.now() });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("api/state error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
