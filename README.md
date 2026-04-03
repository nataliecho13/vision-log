# Vision Log

Slack app that opens a **global shortcut** modal to log strategic conversations. Each submission creates a row in a Notion database and appends a formatted block to a Notion page.

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

For local development, copy `.env.example` to `.env` and use [Vercel CLI](https://vercel.com/docs/cli) (`vercel env pull`) or paste values manually.

## Slack app setup (manual)

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) (from scratch is fine).
2. **Interactivity & Shortcuts**
   - Turn **Interactivity** on.
   - **Request URL:** `https://<your-deployment>.vercel.app/slack/actions` (must respond 200 to Slack’s URL verification challenge if you use Events; this app only uses interactivity payloads, so ensure the URL is reachable).
3. **Shortcuts**
   - Add a **Global** shortcut.
   - **Callback ID:** `log_vision` (must match exactly).
   - Name/description as you like (e.g. “Log vision”).
4. **OAuth & Permissions → Bot Token Scopes**  
   Add at least what you listed: `chat:write`, `chat:write.public`.  
   Opening modals from a global shortcut does not require extra scopes beyond a valid bot token and interactivity; add more scopes only if you extend the app (e.g. posting into channels).
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

- **Shortcut** `log_vision` → opens a modal with Title, Key excerpt or summary, and Tag (static select).
- **Captured automatically:** channel name when Slack sends it (otherwise treated as a private conversation), submitting user, date/time in **America/New_York**.
- **On submit:** Slack modal closes immediately (`response_action: clear`). The server then:
  1. Inserts a Notion database row (`Date`, `Title`, `Tag`, `Channel`, `Logged by`, `Summary`).
  2. Appends to the log page: a **divider**, then paragraphs for date/time/channel line, user/tag line, **bold** title, and summary.

If Notion calls fail, errors are logged and the modal still closes so Slack does not hang.

## Project layout

- `server.js` — Express app, `POST /slack/actions`, Slack signature verification, modal open + submit handling.
- `lib/slack-verify.js` — `X-Slack-Signature` verification.
- `lib/notion.js` — Notion client helpers for the database row and page append.
