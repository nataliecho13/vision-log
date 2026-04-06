# Vision Log

Slack app that opens a modal to log strategic conversations—from the **global shortcut** (anywhere) or a **message shortcut** (⋯ on a specific message, with that message pre-filled). Each submission creates a row in a Notion database and appends a formatted block to a Notion page.

- **Runtime:** Node.js 18+, Express (deployed as one Vercel serverless function)
- **Endpoint:** `POST /slack/actions` (full URL: `https://<your-deployment>.vercel.app/slack/actions`)

## Environment variables

Set these in the Vercel project (**Settings → Environment Variables**):

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** |
| `NOTION_TOKEN` | Notion integration secret |
| `NOTION_DATABASE_ID` | Target database ID (32-char hex, no dashes) |
| `NOTION_PAGE_ID` | Running log page ID (32-char hex, no dashes) |
| `ANTHROPIC_API_KEY` | Anthropic API key (`sk-ant-...`) — optional; if missing, title falls back to first line of message |

For local development, copy `.env.example` to `.env` and use [Vercel CLI](https://vercel.com/docs/cli) (`vercel env pull`) or paste values manually.

## Slack app setup (manual)

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) (from scratch is fine).
2. **Interactivity & Shortcuts**
   - Turn **Interactivity** on.
   - **Request URL:** `https://<your-deployment>.vercel.app/slack/actions` (must respond 200 to Slack’s URL verification challenge if you use Events; this app only uses interactivity payloads, so ensure the URL is reachable).
3. **Shortcuts** (add both if you want lightning-menu *and* log-from-a-message)
   - **Global** shortcut: **Callback ID** `log_vision` (exactly). Name e.g. “Log vision”.
   - **Message** shortcut: **Callback ID** `log_vision_message` (exactly). Name e.g. “Log this to Vision Log”.  
     This appears on the **⋯** menu on a message; the modal opens with **Title** and **Key excerpt** pre-filled from that message (and the message link when Slack sends a `permalink`).
4. **OAuth & Permissions → Bot Token Scopes**  
   Add these scopes:

   | Scope | Why |
   |-------|-----|
   | `commands` | Required for shortcuts |
   | `chat:write` | Post the confirmation thread reply |
   | `chat:write.public` | Post in public channels without the bot needing to join them |
   | `users:read` | Resolve the original message author's display name for the "Sent by" field |

   After changing scopes, click **Reinstall to Workspace** so they take effect.

   > **Private channels:** `chat:write.public` only covers public channels. For private channels, invite the bot first: `/invite @your-bot-name`.
5. **Install to Workspace** and copy the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`.

## Notion setup

1. Create a [Notion integration](https://www.notion.so/my-integrations) and copy the **Internal Integration Secret** → `NOTION_TOKEN`.
2. **Database (index)**  
   Create a database with these properties (names and types must match):

   | Property name | Type |
   |---------------|------|
   | `Date` | Date |
   | `Title` | Title |
   | `Tag` | Select — options exactly: `💡 New idea`, `🔁 Recurring theme`, `⏸️ Punted`, `✅ Became a thing` |
   | `Channel` | Text |
   | `Logged by` | Text |
   | `Summary` | Text |

   In the Notion UI, “Text” properties are stored as rich text; the API maps them as `rich_text`.

3. **Running document**  
   Create a full page (empty body is fine). The app **appends** divider + paragraphs to the bottom of this page.

4. **Share** both the database and the page with your integration (**Share → Invite** the integration).

5. Copy IDs from the URLs:
   - Database: `https://www.notion.so/<workspace>/<DATABASE_ID>?v=...`
   - Page: `https://www.notion.so/<workspace>/<PAGE_ID>`  
   Use the 32-character ID (with or without dashes; the client accepts both).

## Deploy to Vercel

1. Push this repo to GitHub/GitLab/Bitbucket and [import the project](https://vercel.com/new) in Vercel, or run `npx vercel` from the repo root.
2. Vercel detects **Express** via root `server.js` and deploys it as a single function.
3. Add all environment variables in the Vercel dashboard.
4. Redeploy after changing env vars.
5. Set the Slack **Interactivity** Request URL to your production URL + `/slack/actions`.

### Local development

```bash
npm install
npx vercel dev
```

Use the tunnel URL Vercel prints (e.g. `http://localhost:3000`) as the Slack Request URL while testing.

## Behavior summary

- **Global shortcut** `log_vision` → modal (empty fields except you fill them).
- **Message shortcut** `log_vision_message` → same modal, with **Title** / **Key excerpt** pre-filled from that message; the excerpt includes a **Slack permalink** (or a built URL from channel + timestamp) so you can jump back to the **full thread**. Notion gets a clickable **Open thread in Slack** link in the database **Summary** and on the running log page (even if you trim the excerpt in the modal).
- **Captured automatically:** channel name when Slack sends it (otherwise treated as a private conversation), date/time in **America/New_York**, and the author of the logged message (requires `users:read` scope; falls back to the submitter for global shortcuts or if the lookup fails).
- **On submit:** Slack modal closes immediately (`response_action: clear`). The server then:
  1. Inserts a Notion database row (`Date`, `Title`, `Tag`, `Channel`, `Logged by`, `Summary`).
  2. Appends to the log page: a **divider**, then paragraphs for date/time/channel line, user/tag line, **bold** title, and summary.

If Notion calls fail, errors are logged and the modal still closes so Slack does not hang.

## Project layout

- `server.js` — Express app, `POST /slack/actions`, Slack signature verification, modal open + submit handling.
- `lib/slack-verify.js` — `X-Slack-Signature` verification.
- `lib/notion.js` — Notion client helpers for the database row and page append.
