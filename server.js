import express from "express";
import { WebClient } from "@slack/web-api";
import { verifySlackRequest } from "./lib/slack-verify.js";
import {
  appendLogEntry,
  createDatabaseRow,
  writeRowPageBody,
  normalizeTag,
} from "./lib/notion.js";
import { generateTitleAndSummary } from "./lib/ai.js";

const TAG_OPTIONS = [
  "💡 New idea",
  "🔁 Recurring theme",
  "⏸️ Punted",
  "✅ Became a thing",
];

const MODAL_CALLBACK_ID = "vision_log_modal";
/** Global shortcut (lightning menu, no message context) */
const SHORTCUT_CALLBACK_ID = "log_vision";
/** Message shortcut (“⋯” on a message — pre-fills excerpt from that message) */
const MESSAGE_SHORTCUT_CALLBACK_ID = "log_vision_message";

const SLACK_MODAL_TEXT_MAX = 3000;
const SLACK_MODAL_TITLE_MAX = 200;

const app = express();

app.use(
  express.urlencoded({
    extended: false,
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {boolean}
 */
function assertSlackSignature(req, res) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const sig = req.headers["x-slack-signature"];
  const ts = req.headers["x-slack-request-timestamp"];
  const rawBody = req.rawBody || "";

  if (!verifySlackRequest(signingSecret, rawBody, String(sig), String(ts))) {
    res.status(401).send("Invalid signature");
    return false;
  }
  return true;
}

/**
 * Format a Date into ET display strings for Notion.
 * @param {Date} date
 * @returns {{ dateDisplay: string; timeDisplay: string; dateIso: string }}
 */
function formatEastern(date) {
  const dateDisplay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);

  const timeDisplay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);

  const dateIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  return { dateDisplay, timeDisplay, dateIso };
}

/**
 * Resolve the best timestamp to use:
 * - message.ts (Slack Unix timestamp) when available (message shortcut)
 * - current time as fallback (global shortcut)
 * @param {string | null | undefined} slackTs  e.g. "1743720491.123456"
 * @returns {{ dateDisplay: string; timeDisplay: string; dateIso: string }}
 */
function resolveTimestamp(slackTs) {
  if (slackTs && typeof slackTs === "string") {
    const ms = parseFloat(slackTs) * 1000;
    if (Number.isFinite(ms) && ms > 0) {
      return formatEastern(new Date(ms));
    }
  }
  return formatEastern(new Date());
}

/**
 * Slack permalink when available, else built from team domain + channel + message ts (for threads / block-only messages).
 * @param {object} payload Shortcut payload
 * @returns {string | null}
 */
function resolveSlackMessageUrl(payload) {
  const message = payload.message;
  if (!message || typeof message !== "object") return null;

  if (
    typeof message.permalink === "string" &&
    message.permalink.startsWith("http")
  ) {
    return message.permalink;
  }

  const channelId = payload.channel?.id;
  const ts = message.ts;
  if (!channelId || ts == null || ts === "") return null;

  const p = String(ts).replace(/\./g, "");
  const domain = payload.team?.domain;
  if (domain && typeof domain === "string") {
    return `https://${domain}.slack.com/archives/${channelId}/p${p}`;
  }
  return `https://slack.com/archives/${channelId}/p${p}`;
}

/**
 * @param {object} shortcutPayload Slack shortcut payload (global or message)
 * @param {{ title: string | null; summary: string | null }} [ai]
 * @param {string | null} [messageSenderName] Display name of the original message author
 */
function buildModalView(shortcutPayload, ai = { title: null, summary: null }, messageSenderName = null) {
  const channel = shortcutPayload.channel;
  const channelName =
    channel && typeof channel.name === "string" && channel.name.length > 0
      ? channel.name
      : null;
  const channelId = channel?.id ?? null;

  const slackMessageUrl = resolveSlackMessageUrl(shortcutPayload);
  const messageTs = shortcutPayload.message?.ts ?? null;

  // Slack private_metadata is capped at 3000 characters. Keep aiSummary short.
  const aiSummaryForMeta = ai.summary ? ai.summary.slice(0, 400) : null;

  const meta = JSON.stringify({
    channelId,
    channelName,
    slackMessageUrl: slackMessageUrl || null,
    messageTs: messageTs || null,
    aiSummary: aiSummaryForMeta,
  });

  const message = shortcutPayload.message;
  let initialTitle = undefined;
  let initialSummary = undefined;

  if (message && typeof message === "object") {
    const raw =
      typeof message.text === "string" ? message.text.trim() : "";
    const linkLine = slackMessageUrl
      ? `Slack message (open full thread):\n${slackMessageUrl}`
      : "";

    if (raw.length > 0) {
      if (ai.title) {
        initialTitle = ai.title.slice(0, SLACK_MODAL_TITLE_MAX);
      } else {
        const firstLine =
          raw.split(/\n/).find((l) => l.trim().length > 0)?.trim() || "";
        if (firstLine.length > 0) {
          initialTitle = firstLine.slice(0, SLACK_MODAL_TITLE_MAX);
        }
      }
      let body = raw;
      if (linkLine) {
        body = `${raw}\n\n${linkLine}`;
      }
      initialSummary = body.slice(0, SLACK_MODAL_TEXT_MAX);
    } else if (linkLine) {
      initialSummary = linkLine.slice(0, SLACK_MODAL_TEXT_MAX);
      initialTitle = "Slack thread";
    }
  }

  const titleInput = {
    type: "plain_text_input",
    action_id: "title",
    placeholder: {
      type: "plain_text",
      text: "e.g. Pace of shipping vs. roadmap depth",
    },
  };
  if (initialTitle !== undefined) {
    titleInput.initial_value = initialTitle;
  }

  const summaryInput = {
    type: "plain_text_input",
    action_id: "summary",
    multiline: true,
    placeholder: {
      type: "plain_text",
      text: "Paste the conversation or summarize it",
    },
  };
  if (initialSummary !== undefined) {
    summaryInput.initial_value = initialSummary;
  }

  return {
    type: "modal",
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: meta,
    title: { type: "plain_text", text: "Vision Log" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "title_block",
        optional: false,
        label: { type: "plain_text", text: "Title" },
        element: titleInput,
      },
      {
        type: "input",
        block_id: "summary_block",
        optional: false,
        label: { type: "plain_text", text: "Key excerpt or summary" },
        element: summaryInput,
      },
      {
        type: "input",
        block_id: "tag_block",
        optional: false,
        label: { type: "plain_text", text: "Tag" },
        element: {
          type: "static_select",
          action_id: "tag",
          placeholder: { type: "plain_text", text: "Select a tag" },
          options: TAG_OPTIONS.map((text) => ({
            text: { type: "plain_text", text },
            value: text,
          })),
        },
      },
      {
        type: "input",
        block_id: "sent_by_block",
        optional: true,
        label: { type: "plain_text", text: "Sent by" },
        hint: { type: "plain_text", text: "Who sent the original message?" },
        element: {
          type: "plain_text_input",
          action_id: "sent_by",
          placeholder: { type: "plain_text", text: "e.g. Jane Smith" },
          ...(messageSenderName ? { initial_value: messageSenderName } : {}),
        },
      },
    ],
  };
}

/**
 * @param {() => Promise<void>} work
 */
async function runNotionSafely(work) {
  try {
    await work();
  } catch (err) {
    console.error("[vision-log] Notion error:", err);
  }
}

app.head("/slack/actions", (_req, res) => res.status(200).end());

app.post("/slack/actions", async (req, res) => {
  // Slack interactivity endpoint SSL verification (no signed payload)
  if (req.body?.ssl_check === "1") {
    res.status(200).send("");
    return;
  }

  if (!assertSlackSignature(req, res)) return;

  const payloadRaw = req.body?.payload;
  if (typeof payloadRaw !== "string") {
    res.status(400).send("Missing payload");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    res.status(400).send("Invalid payload JSON");
    return;
  }

  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.error("[vision-log] SLACK_BOT_TOKEN is not set");
    res.status(500).send("Server misconfiguration");
    return;
  }

  const slack = new WebClient(botToken);

  // Global shortcuts: type === "shortcut"
  // Message shortcuts: type === "message_action"
  const isVisionShortcut =
    (payload.type === "shortcut" && payload.callback_id === SHORTCUT_CALLBACK_ID) ||
    (payload.type === "message_action" && payload.callback_id === MESSAGE_SHORTCUT_CALLBACK_ID);

  if (isVisionShortcut) {
    const triggerId = payload.trigger_id;
    if (!triggerId) {
      res.status(400).send("Missing trigger_id");
      return;
    }

    // For message shortcuts, generate title + summary with Claude and resolve
    // the original message sender in parallel.
    let ai = { title: null, summary: null };
    let messageSenderName = null;
    if (payload.type === "message_action") {
      const rawText = payload.message?.text;
      const messageUserId = payload.message?.user;

      const [aiResult, userInfoResult] = await Promise.all([
        rawText && typeof rawText === "string" && rawText.trim().length > 0
          ? generateTitleAndSummary(rawText)
          : Promise.resolve({ title: null, summary: null }),
        messageUserId
          ? slack.users.info({ user: messageUserId }).catch((err) => {
              console.error("[vision-log] users.info failed:", err);
              return null;
            })
          : Promise.resolve(null),
      ]);

      ai = aiResult;
      if (userInfoResult?.user) {
        const profile = userInfoResult.user.profile;
        messageSenderName =
          (profile?.display_name && profile.display_name.trim()) ||
          (profile?.real_name && profile.real_name.trim()) ||
          userInfoResult.user.name ||
          null;
        console.log(
          `[vision-log] message sender resolved: userId=${messageUserId} display_name="${profile?.display_name}" real_name="${profile?.real_name}" name="${userInfoResult.user.name}" -> "${messageSenderName}"`
        );
      } else {
        console.log(
          `[vision-log] message sender NOT resolved: userId=${messageUserId} userInfoResult=${JSON.stringify(userInfoResult)}`
        );
      }
    }

    try {
      await slack.views.open({
        trigger_id: triggerId,
        view: buildModalView(payload, ai, messageSenderName),
      });
    } catch (err) {
      console.error("[vision-log] views.open failed:", err);
      res.status(500).send("Could not open modal");
      return;
    }

    res.status(200).send("");
    return;
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === MODAL_CALLBACK_ID) {
    const notionToken = process.env.NOTION_TOKEN;
    const databaseId = process.env.NOTION_DATABASE_ID;
    const pageId = process.env.NOTION_PAGE_ID;

    const values = payload.view.state.values;
    const title = values?.title_block?.title?.value?.trim() || "";
    const summaryRaw = values?.summary_block?.summary?.value?.trim() || "";
    const tagRaw =
      values?.tag_block?.tag?.selected_option?.value || TAG_OPTIONS[0];
    const tag = normalizeTag(tagRaw);

    let meta = { channelId: null, channelName: null, slackMessageUrl: null, messageTs: null, aiSummary: null };
    try {
      if (payload.view.private_metadata) {
        meta = {
          channelId: null,
          channelName: null,
          slackMessageUrl: null,
          messageTs: null,
          aiSummary: null,
          ...JSON.parse(payload.view.private_metadata),
        };
      }
    } catch {
      /* keep defaults */
    }

    const aiSummary =
      typeof meta.aiSummary === "string" && meta.aiSummary.trim().length > 0
        ? meta.aiSummary.trim()
        : null;

    const slackMessageUrl =
      typeof meta.slackMessageUrl === "string" &&
      meta.slackMessageUrl.startsWith("http")
        ? meta.slackMessageUrl
        : null;

    // Strip the "Slack message (open full thread):\n<url>" line that was
    // pre-filled into the modal — the 🔗 link block in Notion covers this.
    const summary = slackMessageUrl
      ? summaryRaw
          .replace(
            new RegExp(
              `\\s*Slack message \\(open full thread\\):\\n${slackMessageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`
            ),
            ""
          )
          .trim()
      : summaryRaw;

    const channelLabel =
      meta.channelName && String(meta.channelName).length > 0
        ? `#${meta.channelName}`
        : "private conversation";

    const channelForDb = channelLabel;

    const sentBy = values?.sent_by_block?.sent_by?.value?.trim() || "";

    const user = payload.user || {};
    const loggedByUsername =
      (typeof user.username === "string" && user.username) ||
      (typeof user.name === "string" && user.name) ||
      user.id ||
      "unknown";
    const loggedByLine = `@${loggedByUsername}`;
    const loggedByForDb = sentBy ? `@${sentBy}` : loggedByLine;

    const { dateDisplay, timeDisplay, dateIso } = resolveTimestamp(meta.messageTs);

    // Run Notion calls BEFORE responding so Vercel doesn't kill the function
    // early. Slack allows up to 3 seconds for view_submission responses;
    // Notion API calls are typically 200–600ms so this is safe.
    if (!notionToken || !databaseId || !pageId) {
      console.error(
        "[vision-log] Missing NOTION_TOKEN, NOTION_DATABASE_ID, or NOTION_PAGE_ID"
      );
    } else {
      await runNotionSafely(async () => {
        // 1. Create database row (Summary property = AI summary or fallback)
        const rowPageId = await createDatabaseRow({
          notionToken,
          databaseId,
          row: {
            dateIso,
            title,
            tag,
            channel: channelForDb,
            loggedBy: loggedByForDb,
            aiSummary,
            fullText: summary,
            slackMessageUrl,
          },
        });

        // 2. Write full message text into the row's own page body
        await writeRowPageBody({
          notionToken,
          rowPageId,
          fullText: summary,
          slackMessageUrl,
        });

        // 3. Append formatted entry to the running log page
        await appendLogEntry({
          notionToken,
          pageId,
          entry: {
            dateStr: dateDisplay,
            timeStr: timeDisplay,
            channelLine: channelLabel,
            sentBy,
            loggedByLine,
            title,
            aiSummary,
            fullText: summary,
            tag,
            slackMessageUrl,
          },
        });

        // 4. Confirm: thread reply if possible, DM fallback for private channels
        const notionDbUrl = `https://www.notion.so/${databaseId.replace(/-/g, "")}`;
        const confirmText = slackMessageUrl
          ? `✅ Logged to Vision Log — <${notionDbUrl}|${title || "view entry"}> · <${slackMessageUrl}|jump to message>`
          : `✅ Logged to Vision Log — <${notionDbUrl}|${title || "view entry"}>`;

        if (meta.channelId && meta.messageTs) {
          try {
            await slack.chat.postMessage({
              channel: meta.channelId,
              thread_ts: meta.messageTs,
              text: confirmText,
            });
          } catch {
            // Channel not accessible (e.g. private) — fall back to DM
            await slack.chat.postMessage({
              channel: payload.user.id,
              text: confirmText,
            }).catch((err) => {
              console.error("[vision-log] confirmation failed:", err);
            });
          }
        } else {
          // Global shortcut — no thread, just DM
          await slack.chat.postMessage({
            channel: payload.user.id,
            text: confirmText,
          }).catch((err) => {
            console.error("[vision-log] confirmation failed:", err);
          });
        }
      });
    }

    res.status(200).json({ response_action: "clear" });
    return;
  }

  res.status(200).send("");
});

export default app;

const isDirectRun =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("server.js");

if (process.env.VERCEL !== "1" && isDirectRun) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Vision Log listening on http://localhost:${port}/slack/actions`);
  });
}
