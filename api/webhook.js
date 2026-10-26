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

const MAX_WORDS = 200;

const SYSTEM_PROMPT = `You are Sensei, a friendly study helper for students on WhatsApp.
- Help with any school or university subject.
- Explain step by step so the student understands the method, not just the answer.
- Every reply must be ${MAX_WORDS} words or fewer. Use simple words.
- Use plain text only. Never use asterisks, markdown, bold, headers, tables or code blocks. For lists, put each item on its own line starting with a number like 1. or a dash.
- If the question is clear enough to answer, answer it straight away with steps. Ask a clarifying question only if you truly cannot answer without it, and never more than one at a time.
- If a student only names a subject or topic, give a short overview and 2 example problems they can pick from.
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

// Marks the message as read AND shows the "typing..." indicator to the student.
// WhatsApp keeps it visible until the reply is sent (max about 25 seconds).
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
      typing_indicator: { type: "text" },
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

// Greetings are answered instantly (no AI call) with the student's WhatsApp name.
const GREETING_RE =
  /^(hi+|hey+|hello+|hola|howdy|yo|sup|greetings|good\s*(morning|afternoon|evening|day))(\s+(there|sensei|everyone|all))?[\s!.,?]*$/i;

function greetingReply(name) {
  const first = (name || "").trim().split(/\s+/)[0] || "there";
  return `Hi ${first}! 👋 I'm Sensei, your study helper.

Here's what I can do:
1. Help with any school or university subject, from maths and science to history and languages
2. Explain things step by step so you understand the method, not just the answer
3. Guide you through practice questions and revision

Just type your question to get started.`;
}

// Safety net: strip markdown symbols and enforce the word limit,
// even if the AI ignores the instructions.
function cleanReply(text) {
  let t = String(text)
    .replace(/(\d|\))\s*\*\s*(\d|\()/g, "$1 × $2") // keep maths like 3*4
    .replace(/^\s*[*•]\s+/gm, "- ")                    // bullets
    .replace(/\*/g, "")                                  // remaining asterisks
    .replace(/^#{1,6}\s*/gm, "")                         // headers
    .replace(/`{1,3}/g, "")                               // code ticks
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Cut to MAX_WORDS, ending on a full sentence where possible
  const re = /\S+/g;
  let m, count = 0, end = t.length;
  while ((m = re.exec(t))) {
    if (++count === MAX_WORDS) { end = m.index + m[0].length; break; }
  }
  if (end < t.length) {
    t = t.slice(0, end);
    const stop = t.search(/[.!?](?=[^.!?]*$)/);
    if (stop > t.length * 0.6) t = t.slice(0, stop + 1);
  }
  return t;
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
      const reply = cleanReply(await callProvider(p, messages));
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

      const text = msg.text.body.trim();
      if (GREETING_RE.test(text)) {
        const name = payload?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;
        await sendWhatsApp(from, greetingReply(name));
        return res.status(200).send("ok");
      }

      const reply = await askAI(from, text);
      await sendWhatsApp(from, reply);
    } catch (err) {
      console.error(err);
    }
    // Always 200 so Meta doesn't keep retrying
    return res.status(200).send("ok");
  }

  return res.status(405).send("Method not allowed");
}

