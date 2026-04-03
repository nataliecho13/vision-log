import Anthropic from "@anthropic-ai/sdk";

const TITLE_TIMEOUT_MS = 2400;
const MAX_INPUT_CHARS = 1500;

/**
 * Strip Slack mrkdwn formatting so Claude sees clean text.
 * @param {string} text
 * @returns {string}
 */
function cleanSlackText(text) {
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
 * Ask Claude for a short strategic title for the conversation.
 * Returns null if the API key is missing, times out, or errors.
 *
 * @param {string} rawMessageText
 * @returns {Promise<string | null>}
 */
export async function generateTitle(rawMessageText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const cleaned = cleanSlackText(rawMessageText).slice(0, MAX_INPUT_CHARS);
  if (!cleaned) return null;

  const client = new Anthropic({ apiKey });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI title timeout")), TITLE_TIMEOUT_MS)
  );

  const aiPromise = client.messages.create({
    model: "claude-3-haiku-20240307",
    max_tokens: 40,
    system:
      "You generate short, punchy titles for strategic conversation logs — similar to how Linear names issues. " +
      "Return only the title text: 4–9 words, no quotes, no period at the end. " +
      "Capture the core strategic tension or decision, not just the topic.",
    messages: [
      {
        role: "user",
        content: `Write a title for this conversation:\n\n${cleaned}`,
      },
    ],
  });

  try {
    const response = await Promise.race([aiPromise, timeoutPromise]);
    const title = response.content?.[0]?.text?.trim();
    return title && title.length > 0 ? title : null;
  } catch (err) {
    console.error("[vision-log] generateTitle error:", err.message || err);
    return null;
  }
}
