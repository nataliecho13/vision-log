import { Client } from "@notionhq/client";

const TAG_OPTIONS = [
  "🗺️ Strategy",
  "🔧 Feature",
  "👥 Team / process",
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
 * @param {{
 *   dateIso: string,
 *   title: string,
 *   tag: string,
 *   channel: string,
 *   loggedBy: string,
 *   aiSummary: string | null,
 *   fullText: string,
 *   slackMessageUrl?: string | null
 * }} params.row
 * @returns {Promise<string>} the new page ID (for writing full text to page body)
 */
export async function createDatabaseRow({ notionToken, databaseId, row }) {
  const notion = new Client({ auth: notionToken });
  const tag = normalizeTag(row.tag);

  // Summary property: AI-generated 1–2 sentence summary when available,
  // otherwise first 300 chars of the full text as a plain fallback.
  const summaryText =
    row.aiSummary && row.aiSummary.trim().length > 0
      ? row.aiSummary.trim()
      : (row.fullText || "").slice(0, 300);

  const page = await notion.pages.create({
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
        rich_text: buildSummaryRichText(summaryText, row.slackMessageUrl),
      },
    },
  });

  return page.id;
}

/**
 * Write the full conversation text into the body of a database row's page.
 * @param {object} params
 * @param {string} params.notionToken
 * @param {string} params.rowPageId  returned by createDatabaseRow
 * @param {string} params.fullText   raw message text (user-edited)
 * @param {string | null} [params.slackMessageUrl]
 */
export async function writeRowPageBody({ notionToken, rowPageId, fullText, slackMessageUrl }) {
  const notion = new Client({ auth: notionToken });
  const textChunks = chunkText(fullText);

  const children = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: partsToRichText(textChunks),
      },
    },
  ];

  if (slackMessageUrl) {
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
              link: { url: slackMessageUrl },
            },
          },
        ],
      },
    });
  }

  await notion.blocks.children.append({
    block_id: rowPageId,
    children,
  });
}

/**
 * @param {object} params
 * @param {string} params.notionToken
 * @param {string} params.pageId
 * @param {{
 *   dateStr: string,
 *   timeStr: string,
 *   channelLine: string,
 *   sentBy: string,
 *   loggedByLine: string,
 *   title: string,
 *   aiSummary: string | null,
 *   fullText: string,
 *   tag: string,
 *   slackMessageUrl?: string | null
 * }} params.entry
 */
export async function appendLogEntry({ notionToken, pageId, entry }) {
  const notion = new Client({ auth: notionToken });
  const tag = normalizeTag(entry.tag);

  const titleChunks = chunkText(entry.title);
  const hasAiSummary =
    entry.aiSummary && entry.aiSummary.trim().length > 0;
  const aiSummaryChunks = hasAiSummary ? chunkText(entry.aiSummary.trim()) : [];
  const fullTextChunks = chunkText(entry.fullText || "");
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
        rich_text: partsToRichText([
          entry.sentBy
            ? `👤 ${entry.sentBy} | logged by ${entry.loggedByLine} | 🏷️ ${tag}`
            : `👤 ${entry.loggedByLine} | 🏷️ ${tag}`,
        ]),
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: partsToRichText(titleChunks, { bold: true }),
      },
    },
  ];

  // AI summary paragraph (italic label + summary text)
  if (hasAiSummary) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: partsToRichText(aiSummaryChunks),
      },
    });
  }

  // Full message text
  if (fullTextChunks.length > 0 && (fullTextChunks[0] || "").trim().length > 0) {
    children.push({
      object: "block",
      type: "quote",
      quote: {
        rich_text: partsToRichText(fullTextChunks),
      },
    });
  }

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
