import express from "express";
import { WebClient } from "@slack/web-api";
import { verifySlackRequest } from "./lib/slack-verify.js";
import {
  appendLogEntry,
  createDatabaseRow,
  normalizeTag,
} from "./lib/notion.js";

const TAG_OPTIONS = [
  "💡 New idea",
  "🔁 Recurring theme",
  "⏸️ Punted",
  "✅ Became a thing",
];

const MODAL_CALLBACK_ID = "vision_log_modal";
const SHORTCUT_CALLBACK_ID = "log_vision";

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
 * @returns {{ dateDisplay: string; timeDisplay: string; dateIso: string }}
 */
function easternNow() {
  const now = new Date();
  const dateDisplay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(now);

  const timeDisplay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  const dateIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  return { dateDisplay, timeDisplay, dateIso };
}

/**
 * @param {object} shortcutPayload
 */
function buildModalView(shortcutPayload) {
  const channel = shortcutPayload.channel;
  const channelName =
    channel && typeof channel.name === "string" && channel.name.length > 0
      ? channel.name
      : null;
  const channelId = channel?.id ?? null;

  const meta = JSON.stringify({
    channelId,
    channelName,
  });

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
        element: {
          type: "plain_text_input",
          action_id: "title",
          placeholder: {
            type: "plain_text",
            text: "e.g. Pace of shipping vs. roadmap depth",
          },
        },
      },
      {
        type: "input",
        block_id: "summary_block",
        optional: false,
        label: { type: "plain_text", text: "Key excerpt or summary" },
        element: {
          type: "plain_text_input",
          action_id: "summary",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Paste the conversation or summarize it",
          },
        },
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

  if (payload.type === "shortcut" && payload.callback_id === SHORTCUT_CALLBACK_ID) {
    const triggerId = payload.trigger_id;
    if (!triggerId) {
      res.status(400).send("Missing trigger_id");
      return;
    }

    try {
      await slack.views.open({
        trigger_id: triggerId,
        view: buildModalView(payload),
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
    const summary = values?.summary_block?.summary?.value?.trim() || "";
    const tagRaw =
      values?.tag_block?.tag?.selected_option?.value || TAG_OPTIONS[0];
    const tag = normalizeTag(tagRaw);

    let meta = { channelId: null, channelName: null };
    try {
      if (payload.view.private_metadata) {
        meta = JSON.parse(payload.view.private_metadata);
      }
    } catch {
      /* keep defaults */
    }

    const channelLabel =
      meta.channelName && String(meta.channelName).length > 0
        ? `#${meta.channelName}`
        : "private conversation";

    const channelForDb = channelLabel;

    const user = payload.user || {};
    const username =
      (typeof user.username === "string" && user.username) ||
      (typeof user.name === "string" && user.name) ||
      user.id ||
      "unknown";
    const userLine = `@${username}`;
    const loggedByForDb = userLine;

    const { dateDisplay, timeDisplay, dateIso } = easternNow();

    res.status(200).json({ response_action: "clear" });

    await runNotionSafely(async () => {
      if (!notionToken || !databaseId || !pageId) {
        console.error(
          "[vision-log] Missing NOTION_TOKEN, NOTION_DATABASE_ID, or NOTION_PAGE_ID"
        );
        return;
      }

      await createDatabaseRow({
        notionToken,
        databaseId,
        row: {
          dateIso,
          title,
          tag,
          channel: channelForDb,
          loggedBy: loggedByForDb,
          summary,
        },
      });

      await appendLogEntry({
        notionToken,
        pageId,
        entry: {
          dateStr: dateDisplay,
          timeStr: timeDisplay,
          channelLine: channelLabel,
          userLine,
          title,
          summary,
          tag,
        },
      });
    });

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
