# Student Helper WhatsApp Bot

WhatsApp Business Cloud API chatbot that answers students' questions in any subject.
AI: Groq (primary) with automatic fallback to Nvidia.

## Files
- api/webhook.js   the whole bot (webhook verification, message handling, AI, replies)
- package.json     ES module setup
- vercel.json      gives the function 30s to respond
- .env.example     the environment variables you must set

## Deploy (Vercel)
1. Unzip, then push the folder to a GitHub repo (or run `npx vercel` inside it).
2. In Vercel > Settings > Environment Variables, add every variable from .env.example. Get META_APP_SECRET from Meta Developer App Settings > Basic. Keep both Meta secrets private.
3. Redeploy so the variables take effect.

## Connect to WhatsApp (Meta Developer dashboard)
1. WhatsApp > Configuration > Webhook > Edit.
2. Callback URL: https://YOUR-PROJECT.vercel.app/api/webhook
3. Verify token: same value as VERIFY_TOKEN.
4. Click Verify and Save.
5. Under Webhook fields, subscribe to "messages".
6. Message your WhatsApp number to test.

## Test the fallback
Set a wrong GROQ_API_KEY temporarily. Replies should still arrive via Nvidia,
and the Vercel logs will show "Groq failed, trying next".

## Notes
- Chat memory is in-process and resets on cold starts. Use Supabase for permanent history.
- Meta allows free-form replies only within 24 hours of the student's last message.
- Text messages only for now.
