// Admin API for the Sensei dashboard (password protected).
// Env vars: ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
import { createHash, timingSafeEqual } from "node:crypto";

const sha = (s) => createHash("sha256").update(String(s)).digest();

function authorized(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false;
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return timingSafeEqual(sha(given), sha(pw)); // constant-time compare
}

async function sb(path, opts = {}) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...opts,
    signal: AbortSignal.timeout(8000),
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Set ADMIN_PASSWORD, SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel" });
  }
  if (!authorized(req)) {
    await new Promise((r) => setTimeout(r, 600)); // slows down password guessing
    return res.status(401).json({ error: "Wrong password" });
  }

  try {
    const { view = "overview", phone, q } = req.query;

    if (view === "overview") {
      const [stats, recent] = await Promise.all([
        sb("rpc/dashboard_stats", { method: "POST", body: "{}" }),
        sb("messages?select=phone,role,body,provider,created_at,users(name)&order=created_at.desc&limit=30"),
      ]);
      return res.status(200).json({ stats, recent });
    }

    if (view === "users") {
      let path = "users?select=phone,name,first_seen,last_seen,message_count&order=last_seen.desc&limit=100";
      if (q) {
        const safe = String(q).replace(/[^\w\s.-]/g, "").trim().slice(0, 40);
        if (safe) path += `&or=(name.ilike.*${safe}*,phone.ilike.*${safe}*)`;
      }
      return res.status(200).json({ users: await sb(path) });
    }

    if (view === "chat" && phone) {
      const digits = String(phone).replace(/\D/g, "");
      const rows = await sb(
        `messages?phone=eq.${digits}&select=role,body,provider,created_at&order=created_at.desc&limit=200`
      );
      return res.status(200).json({ messages: rows.reverse() });
    }

    return res.status(400).json({ error: "Unknown view" });
  } catch (err) {
    console.error("Admin error:", err.message);
    return res.status(500).json({ error: "Could not load data" });
  }
  }
  
