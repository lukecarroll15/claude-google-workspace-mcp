# Setting up this MCP server for yourself

This server gives Claude Code access to your Gmail, Google Drive, Calendar and
Docs. You run it on your own machine, with your own Google Cloud project, so
your data and logins stay yours. Nothing passes through anyone else's account.

Allow about 20 minutes. Most of that is the Google Cloud part, which you only
do once.

---

## 1. Prerequisites

- **Node.js 18 or higher.** Check with `node -v`.
  - Mac: `brew install node`
  - Windows: `winget install OpenJS.NodeJS.LTS`
- **Claude Code.** `npm install -g @anthropic-ai/claude-code`
- **Git**, plus access to this repo on GitHub.

---

## 2. Get the code

```bash
git clone https://github.com/lukecarroll15/claude-google-workspace-mcp.git
cd claude-google-workspace-mcp
npm install
```

Note the full path to this folder. You need it in step 6.

---

## 3. Create your Google Cloud project

1. Go to https://console.cloud.google.com and sign in with any Google account.
   This account owns the project. It does not have to be the account whose
   Gmail you want to use.
2. Click the project picker at the top, then **New Project**. Name it anything,
   for example `claude-workspace`. Make sure it is selected once created.
3. Enable the four APIs. Open each link, check your project is selected, and
   click **Enable**:
   - https://console.cloud.google.com/apis/library/drive.googleapis.com
   - https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   - https://console.cloud.google.com/apis/library/docs.googleapis.com

---

## 4. Create the OAuth client

1. Go to https://console.cloud.google.com/auth/overview and click
   **Get started**.
   - **App name:** anything, for example `Claude Workspace`.
   - **User support email** and **contact email:** your own.
   - **Audience:** **External**.
   - Agree to the policy and click **Create**.
2. Go to **Audience** in the left menu and click **Publish app**, then
   **Confirm**. The status should read **In production**.

   Do not skip this. While the app is in **Testing**, Google expires your
   login after 7 days and you have to sign in again every week. Publishing
   does not submit anything to Google for review. It just means you will see
   a "Google hasn't verified this app" warning when you sign in, which is
   expected for a personal app.
3. Go to **Clients** in the left menu and click **Create client**.
   - **Application type:** **Desktop app**.
   - **Name:** anything.
   - Click **Create**.
4. Download the JSON file for the client you just made, rename it to exactly
   `credentials.json`, and put it in the root of this project folder (next to
   `server.js`).

`credentials.json` is gitignored. Never commit it or share it.

---

## 5. Sign in to your Google account(s)

From the project folder:

```bash
node auth/login.js personal
```

`personal` is just a label. Use whatever you like, and run the command once per
Google account you want to connect, for example:

```bash
node auth/login.js personal
node auth/login.js work
```

Each time:

1. The terminal prints a long `https://accounts.google.com/...` URL. Open it in
   your browser.
2. Pick the Google account.
3. On the "Google hasn't verified this app" screen, click **Advanced**, then
   **Go to (your app name)**. This is your own app, so this is safe.
4. Approve the permissions.
5. The browser says "Authentication successful" and the terminal confirms the
   token was saved to `tokens/<label>.json`.

The labels you choose become the account names Claude uses, so keep them short.

On Windows, a firewall prompt may appear because the login listens on port
3000 for Google's reply. Allow it on private networks. Nothing is exposed to
the internet.

### Read-only option

If you only want Claude to be able to search and read, not send emails or edit
files, add `--readonly`:

```bash
node auth/login.js personal --readonly
```

Without it, Claude gets full read and write access to Drive, Gmail and
Calendar on that account. It will act on what you ask it to, so choose
accordingly.

### Work and university accounts

Google accounts run by a company or university often have an admin policy that
blocks unverified apps. If sign-in fails with an "access blocked" or "admin
policy" message, that account cannot be connected without the admin's
approval. Personal Gmail accounts always work.

`tokens/` is gitignored. These files grant access to your accounts, so keep
them private.

---

## 6. Connect it to Claude Code

Register the server at user scope so it is available in every project. Use the
full path to `server.js`:

Mac / Linux:

```bash
claude mcp add google-workspace -s user -- node /full/path/to/claude-google-workspace-mcp/server.js
```

Windows (PowerShell):

```powershell
claude mcp add google-workspace -s user -- node "C:\full\path\to\claude-google-workspace-mcp\server.js"
```

Check it connected:

```bash
claude mcp list
```

You should see `google-workspace: ... - ✔ Connected`.

---

## 7. Test it

Start `claude` anywhere and ask, naming your account label:

> List the folders in my Drive using the personal account.

> Search my personal Gmail for emails from the last week.

> What's on my personal calendar tomorrow?

---

## Updating

```bash
cd claude-google-workspace-mcp
git pull
npm install
```

Then restart Claude Code.

---

## Troubleshooting

| What you see | Fix |
|---|---|
| `Missing .../credentials.json` | The file must be named exactly `credentials.json` and sit in the project root |
| `No authentication found for account "x"` | Run `node auth/login.js x` |
| Claude says the account is not valid | Account names come from the files in `tokens/`. List that folder to see them |
| `claude mcp list` shows Failed | Run `node server.js` directly. It should sit silently (that is correct). Any error text tells you what is wrong. Ctrl+C to exit |
| `EADDRINUSE` or the login never redirects | Something else is using port 3000. Close it and retry |
| API "has not been used in project" error | That API is not enabled. Redo step 3 for it |
| You have to sign in again every week | The app is still in Testing. Publish it (step 4.2), then rerun the logins |
| "Access blocked" for a work or college account | That organisation blocks unverified apps. See step 5 |
