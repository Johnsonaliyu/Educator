// WhatsApp Cloud API student-helper bot — Vercel serverless function
// Env vars (set in Vercel > Settings > Environment Variables):
//   VERIFY_TOKEN     any secret string; must match what you enter in Meta
//   META_APP_SECRET  App Secret from Meta; used to verify webhook signatures
//   WHATSAPP_TOKEN   your permanent access token
//   PHONE_NUMBER_ID  your WhatsApp phone number ID
//   GROQ_API_KEY     primary AI (console.groq.com)
//   NVIDIA_API_KEY   fallback AI (build.nvidia.com)
//   GROQ_MODEL       optional, defaults to openai/gpt-oss-120b
//   NVIDIA_MODEL     optional, defaults to meta/llama-3.3-70b-instruct

import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH = "https://graph.facebook.com/v21.0";

// Vercel must leave the request body untouched so its original bytes can be
// checked against Meta's x-hub-signature-256 header.
export const config = { api: { bodyParser: false } };

const SYSTEM_PROMPT = `You are a friendly study helper for students on WhatsApp.
- Help with any school or university subject.
- Explain step by step so the student understands the method, not just the answer.
- Keep replies short and clear (WhatsApp, under 1500 characters). Use simple words.
- Use plain text only: no markdown tables or headers. Use *bold* sparingly.
- If a question is unclear, ask one short clarifying question.
- Don't just do graded work for the student; guide them to the answer.`;

// Simple in-memory history (resets on cold start). Use Supabase for permanent history.
const history = new Map();
const MAX_TURNS = 10;

async function sendWhatsApp(to, text) {
  const res = await fetch(`${GRAPH}/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(4000),
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text.slice(0, 4000) },
    }),
  });
  if (!res.ok) console.error("Send failed:", res.status, await res.text());
}

async function markRead(messageId) {
  await fetch(`${GRAPH}/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(3000),
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  }).catch(() => {});
}

// Both Groq and Nvidia use the OpenAI-compatible chat completions format.
const PROVIDERS = [
  {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: () => process.env.GROQ_API_KEY,
    model: () => process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  },
  {
    name: "Nvidia",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    key: () => process.env.NVIDIA_API_KEY,
    model: () => process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct",
  },
];

async function callProvider(p, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // Leave time for fallback and WhatsApp delivery within Vercel's 30s limit
  try {
    const res = await fetch(p.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${p.key()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: p.model(),
        messages,
        max_tokens: 700,
        temperature: 0.4,
      }),
    });
    if (!res.ok) throw new Error(`${p.name} ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`${p.name} returned empty reply`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function hasValidMetaSignature(signature, rawBody) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || typeof signature !== "string") return false;

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const receivedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length
    && timingSafeEqual(receivedBytes, expectedBytes);
}

async function askAI(from, userText) {
  const turns = history.get(from) || [];
  turns.push({ role: "user", content: userText });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...turns.slice(-MAX_TURNS),
  ];

  // Try Groq first; if it fails (rate limit, outage, timeout), fall back to Nvidia
  for (const p of PROVIDERS) {
    if (!p.key()) continue; // skip providers with no key set
    try {
      const reply = await callProvider(p, messages);
      turns.push({ role: "assistant", content: reply });
      history.set(from, turns.slice(-MAX_TURNS));
      return reply;
    } catch (err) {
      console.error(`${p.name} failed, trying next:`, err.message);
    }
  }

  turns.pop(); // don't keep the unanswered question in history
  return "Sorry, I'm having trouble right now. Please try again in a moment.";
}

export default async function handler(req, res) {
  // 1) Webhook verification (Meta calls this once when you save the webhook)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // 2) Incoming messages
  if (req.method === "POST") {
    let payload;
    try {
      const rawBody = await readRawBody(req);
      if (!hasValidMetaSignature(req.headers["x-hub-signature-256"], rawBody)) {
        return res.status(401).send("Invalid webhook signature");
      }
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      console.error("Invalid webhook request:", err.message);
      return res.status(400).send("Invalid request body");
    }

    try {
      const msg = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).send("ok"); // status updates etc.

      const from = msg.from;
      await markRead(msg.id);

      if (msg.type !== "text") {
        await sendWhatsApp(from, "Please send your question as a text message for now. 📚");
        return res.status(200).send("ok");
      }

      const reply = await askAI(from, msg.text.body);
      await sendWhatsApp(from, reply);
    } catch (err) {
      console.error(err);
    }
    // Always 200 so Meta doesn't keep retrying
    return res.status(200).send("ok");
  }

  return res.status(405).send("Method not allowed");
}
