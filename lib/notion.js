import { Client } from "@notionhq/client";

const TAG_OPTIONS = [
  "💡 New idea",
  "🔁 Recurring theme",
  "⏸️ Punted",
  "✅ Became a thing",
];

/**
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTag(tag) {
  const t = (tag || "").trim();
  if (TAG_OPTIONS.includes(t)) return t;
  return TAG_OPTIONS[0];
}

/**
 * Split into Notion-safe text segments (max ~2000 chars per text content object).
 * @param {string} str
 * @param {number} [maxLen]
 * @returns {string[]}
 */
export function chunkText(str, maxLen = 1900) {
  if (!str) return [""];
  const parts = [];
  let i = 0;
  while (i < str.length) {
    parts.push(str.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}

/**
 * @param {string[]} parts
 * @param {{ bold?: boolean }} [annotations]
 */
export function partsToRichText(parts, annotations = {}) {
  return parts.map((content) => {
    const item = {
      type: "text",
      text: { content },
    };
    if (annotations.bold) {
      item.annotations = { bold: true };
    }
    return item;
  });
}

/**
 * @param {string} summaryText
 * @param {string | null | undefined} slackMessageUrl
 */
function buildSummaryRichText(summaryText, slackMessageUrl) {
  const text = (summaryText || "").trim();
  const parts =
    text.length > 0 ? [...partsToRichText(chunkText(summaryText || ""))] : [];

  if (slackMessageUrl && typeof slackMessageUrl === "string") {
    if (parts.length > 0) {
      parts.push(...partsToRichText(chunkText("\n\n")));
    }
    parts.push({
      type: "text",
      text: {
        content: "Open thread in Slack",
        link: { url: slackMessageUrl },
      },
    });
  }

  if (parts.length === 0) {
    return partsToRichText([""]);
  }
  return parts;
}

/**
 * @param {object} params
 * @param {string} params.notionToken
 * @param {string} params.databaseId
 * @param {{ dateIso: string, title: string, tag: string, channel: string, loggedBy: string, summary: string, slackMessageUrl?: string | null }} params.row
 */
export async function createDatabaseRow({ notionToken, databaseId, row }) {
  const notion = new Client({ auth: notionToken });
  const tag = normalizeTag(row.tag);

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      Date: { date: { start: row.dateIso } },
      Title: {
        title: partsToRichText(chunkText(row.title)),
      },
      Tag: { select: { name: tag } },
      Channel: {
        rich_text: partsToRichText(chunkText(row.channel)),
      },
      "Logged by": {
        rich_text: partsToRichText(chunkText(row.loggedBy)),
      },
      Summary: {
        rich_text: buildSummaryRichText(row.summary, row.slackMessageUrl),
      },
    },
  });
}

/**
 * @param {object} params
 * @param {string} params.notionToken
 * @param {string} params.pageId
 * @param {{ dateStr: string, timeStr: string, channelLine: string, userLine: string, title: string, summary: string, tag: string, slackMessageUrl?: string | null }} params.entry
 */
export async function appendLogEntry({ notionToken, pageId, entry }) {
  const notion = new Client({ auth: notionToken });
  const tag = normalizeTag(entry.tag);

  const titleChunks = chunkText(entry.title);
  const summaryChunks = chunkText(entry.summary);
  const slackUrl =
    entry.slackMessageUrl && typeof entry.slackMessageUrl === "string"
      ? entry.slackMessageUrl
      : null;

  const children = [
    { object: "block", type: "divider", divider: {} },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: partsToRichText([`📅 ${entry.dateStr} | ${entry.timeStr} ET | ${entry.channelLine}`]),
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: partsToRichText([`👤 ${entry.userLine} | 🏷️ ${tag}`]),
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: partsToRichText(titleChunks, { bold: true }),
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: partsToRichText(summaryChunks.length ? summaryChunks : [""]),
      },
    },
  ];

  if (slackUrl) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "🔗 " } },
          {
            type: "text",
            text: {
              content: "Open thread in Slack",
              link: { url: slackUrl },
            },
          },
        ],
      },
    });
  }

  await notion.blocks.children.append({
    block_id: pageId,
    children,
  });
}
