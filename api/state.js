import { Redis } from "@upstash/redis";

const STATE_KEY = "passmate:state";

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: "KV not configured" });
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
