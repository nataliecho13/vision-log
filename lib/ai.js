import Anthropic from "@anthropic-ai/sdk";

const AI_TIMEOUT_MS = 2400;
const MAX_INPUT_CHARS = 1500;

/**
 * Strip Slack mrkdwn formatting so Claude sees clean text.
 * @param {string} text
 * @returns {string}
 */
export function cleanSlackText(text) {
  return text
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")   // <@UXXX|name> → @name
    .replace(/<@[A-Z0-9]+>/g, "@user")            // <@UXXX> → @user
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")    // <#CXXX|channel> → #channel
    .replace(/<#[A-Z0-9]+>/g, "#channel")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")        // <url|label> → label
    .replace(/<(https?:[^>]+)>/g, "$1")            // bare URLs
    .replace(/\*([^*]+)\*/g, "$1")                 // *bold*
    .replace(/_([^_]+)_/g, "$1")                   // _italic_
    .replace(/`{3}[^`]*`{3}/g, "[code block]")    // ```code```
    .replace(/`([^`]+)`/g, "$1")                   // `inline code`
    .replace(/~([^~]+)~/g, "$1")                   // ~strikethrough~
    .replace(/^&gt;\s?/gm, "")                     // blockquote >
    .trim();
}

/**
 * Ask Claude for a title and 1–2 sentence summary in a single API call.
 * Returns null for both if the API key is missing, times out, or errors.
 *
 * @param {string} rawMessageText
 * @returns {Promise<{ title: string | null; summary: string | null }>}
 */
export async function generateTitleAndSummary(rawMessageText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { title: null, summary: null };

  const cleaned = cleanSlackText(rawMessageText).slice(0, MAX_INPUT_CHARS);
  if (!cleaned) return { title: null, summary: null };

  const client = new Anthropic({ apiKey });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI timeout")), AI_TIMEOUT_MS)
  );

  const aiPromise = client.messages.create({
    model: "claude-3-haiku-20240307",
    max_tokens: 120,
    system:
      "You generate metadata for strategic conversation logs. " +
      "Return your response as exactly two lines — no labels, no extra text:\n" +
      "Line 1: A short punchy title, 4–9 words, no quotes, no period. Capture the core strategic tension or decision.\n" +
      "Line 2: A 1–2 sentence summary of what was discussed and why it matters strategically.",
    messages: [
      {
        role: "user",
        content: `Generate a title and summary for this conversation:\n\n${cleaned}`,
      },
    ],
  });

  try {
    const response = await Promise.race([aiPromise, timeoutPromise]);
    const raw = response.content?.[0]?.text?.trim() || "";
    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

    const title = lines[0] || null;
    const summary = lines.slice(1).join(" ").trim() || null;

    return { title, summary };
  } catch (err) {
    console.error("[vision-log] generateTitleAndSummary error:", err.message || err);
    return { title: null, summary: null };
  }
}
