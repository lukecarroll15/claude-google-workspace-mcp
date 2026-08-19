# Running this MCP server on Windows

This guide takes you from a blank Windows machine to Claude Code reading your
Gmail, Drive, Calendar and Docs through this server — using the same three
Google accounts (`personal`, `college`, `branch`) you use on the Mac.

Work through it top to bottom. Each part takes a few minutes.

---

## Part 0 — Fix the 7-day login expiry (do this FIRST)

**Why you keep having to re-authenticate every week:** your Google Cloud
project's OAuth consent screen is in **Testing** mode. Google deliberately
expires refresh tokens issued by a Testing app after **7 days**. Nothing in
this code can work around that — the fix is on Google's side.

Switch the app to **In production** and refresh tokens stop expiring. They then
last until one of these happens:

- you revoke access at https://myaccount.google.com/permissions
- the token goes 6 months completely unused
- you change that Google account's password
- you pile up more than 50 tokens for the same account (oldest get dropped)

For normal daily use, that means **you sign in once and never again**.

### Steps

1. Go to https://console.cloud.google.com/apis/credentials/consent
2. Make sure the project selected at the top is the one this server's
   `credentials.json` belongs to. (Its `project_id` is inside that file.)
3. Under **Publishing status** you'll see **Testing**. Click **PUBLISH APP**.
4. Confirm. Status becomes **In production**.

**About the scary warnings:** Google will note the app is unverified. That is
fine for personal use. Consequences: a one-time "Google hasn't verified this
app" screen when you sign in (click **Advanced** → **Go to *(app name)***),
and a cap of 100 users. You are 1 user. You do **not** need to submit anything
for verification.

> **Important:** publishing does not upgrade tokens you already have. The
> tokens currently in `tokens/` were issued under Testing, so they'll still
> die on schedule. You must sign in again *after* publishing to get permanent
> ones — that's Part 5 below.
>
> Do the same on the Mac afterwards (`node auth/login.js personal`, and again
> for `college` and `branch`) so it stops nagging you there too.

---

## Part 1 — Install the prerequisites on Windows

Open **PowerShell** (press Start, type `powershell`, hit Enter) and run:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close PowerShell and open a **new** one (so it picks up the new commands),
then check they worked:

```powershell
node -v
npm -v
git --version
```

`node -v` must print **v18 or higher** — this project's dependencies require
it. The LTS version is well past that.

Now install Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
```

---

## Part 2 — Get the code

The repo is **private**, so Windows has to prove who you are. The repo is owned
by the GitHub account **`lukecarroll15`** — sign in as that account, not the
other one.

Easiest route is the GitHub CLI:

```powershell
winget install GitHub.cli
```

Open a new PowerShell, then:

```powershell
gh auth login
```

Answer: **GitHub.com** → **HTTPS** → **Yes** (authenticate Git) → **Login with
a web browser**. Copy the one-time code it shows, press Enter, sign in as
`lukecarroll15` in the browser that opens.

Now clone it:

```powershell
mkdir "$HOME\Projects"
cd "$HOME\Projects"
git clone https://github.com/lukecarroll15/claude-google-workspace-mcp.git
cd claude-google-workspace-mcp
```

You now have the project at `C:\Users\<your-name>\Projects\claude-google-workspace-mcp`.
Note that path — you need it in Part 6.

---

## Part 3 — Install the dependencies

```powershell
npm install
```

This creates `node_modules\`. It is not in the repo on purpose — every machine
builds its own.

---

## Part 4 — Copy your Google app credentials across

`credentials.json` is deliberately **not** in the repo. It identifies your
Google Cloud app and contains a client secret, so it must never be committed.
You have to move it by hand.

On the **Mac**, it lives at:

```
/Users/ldc/Projects/claude-drive-mcp/credentials.json
```

Copy that one file to Windows using a USB stick, OneDrive, or a password
manager's secure note. **Don't email it to yourself and don't paste it into a
chat.** Delete it from the USB stick / cloud folder once it's across.

Put it in the root of the project on Windows:

```
C:\Users\<your-name>\Projects\claude-google-workspace-mcp\credentials.json
```

Check it arrived:

```powershell
Test-Path .\credentials.json
```

Should print `True`.

> If you'd rather not shuttle the file around, you can download a fresh copy:
> Google Cloud Console → **APIs & Services** → **Credentials** → your OAuth
> **Desktop app** client → download icon → rename the downloaded file to
> `credentials.json`.

---

## Part 5 — Sign in to your three Google accounts

Because you published the app in Part 0, these logins produce **permanent**
tokens. Run them one at a time:

```powershell
node auth\login.js personal
```

What happens:

1. It prints a long `https://accounts.google.com/...` URL. Copy it into your
   browser.
2. Windows may pop up a **Firewall** prompt because Node is listening on port
   3000 for Google's reply. Tick **Private networks** and click **Allow
   access**. (Nothing is exposed to the internet — the callback is local only.)
3. Pick the Google account. On the "Google hasn't verified this app" screen,
   click **Advanced** → **Go to *(app name)***.
4. Approve the permissions (Drive, Gmail, Calendar, Docs, Sheets, Contacts,
   Tasks).
5. The browser says "Authentication successful. You can close this tab." and
   the terminal confirms the token was saved.

Repeat for the other two:

```powershell
node auth\login.js college
node auth\login.js branch
```

Confirm all three landed:

```powershell
dir .\tokens
```

You should see `personal.json`, `college.json`, `branch.json`. The server reads
this folder to decide which accounts exist, so the filenames *are* the account
names you'll use in Claude.

> These token files grant full access to your Google accounts. They're
> gitignored — keep it that way, and don't copy them anywhere public.

---

## Part 6 — Connect the server to Claude Code

Register it once, at **user scope**, so it's available in every project on the
machine — not just this folder:

```powershell
claude mcp add claude-drive-full-access -s user -- node "$HOME\Projects\claude-google-workspace-mcp\server.js"
```

Check it connected:

```powershell
claude mcp list
```

You want to see:

```
claude-drive-full-access: node C:\Users\...\server.js - ✔ Connected
```

---

## Part 7 — Test it

Start Claude Code anywhere:

```powershell
claude
```

Then ask it something that exercises the server, naming the account:

> List the folders in my Drive using the personal account.

Then try a couple more:

> Search my personal Gmail for emails from the last week.
>
> What's on my college calendar tomorrow?

If those work, you're done. You have all **29 tools** available: Drive
(search, read, move, copy, rename, trash), Gmail (search, read, drafts, send,
reply, download attachments), Calendar (list, search, create, update, delete),
and Docs (create, read, update, append).

**One Windows-specific note:** `download_attachment` needs a full Windows path,
e.g. `C:\Users\<your-name>\Downloads\invoice.pdf` — not a Mac-style
`/Users/...` path.

---

## Part 8 — Keeping the Mac and Windows in sync

Both machines now share the same GitHub repo. The code syncs; the secrets
don't (by design).

**After changing code on the Mac:**

```bash
git add -A
git commit -m "Describe what changed"
git push
```

**To pick that up on Windows:**

```powershell
cd "$HOME\Projects\claude-google-workspace-mcp"
git pull
npm install          # only needed if package.json changed
```

Then restart Claude Code so it reloads the server.

The same works in reverse — commit and push from Windows, pull on the Mac.

`credentials.json` and `tokens/` are gitignored and will never travel through
git. That's intentional: a new machine always means copying the credentials
once and running the logins once.

---

## Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| `Missing ...\credentials.json` | Part 4 didn't happen or the file is misnamed | Confirm it's exactly `credentials.json` in the project root |
| `No authentication found for account "personal"` | No `tokens\personal.json` | Re-run `node auth\login.js personal` |
| Claude says the account isn't valid | The server lists accounts from `tokens\` | `dir .\tokens` — the filenames are the account names |
| `claude mcp list` shows ✘ Failed | Server crashed on start | Run `node server.js` directly. It should sit there silently with no output — that's correct for this kind of server. Press Ctrl+C. Any error text is your clue |
| Login hangs, browser never redirects | Port 3000 is taken or the firewall blocked it | Close other dev servers, allow Node through the firewall, retry |
| `Error: listen EADDRINUSE :::3000` | Something else is on port 3000 | Close it, or reboot, then retry the login |
| Re-authentication comes back weekly | The app slipped back to Testing, or that account's token was revoked | Recheck Part 0, then re-run the logins |
| `git clone` asks endlessly for a password | Signed into the wrong GitHub account | `gh auth login` again as `lukecarroll15` |

---

## What each piece does

| Path | Purpose |
|---|---|
| `server.js` | The MCP server. Declares the 29 tools and routes calls |
| `auth/login.js` | One-off browser sign-in; writes `tokens/<account>.json` |
| `auth/accounts.js` | Loads saved tokens; discovers which accounts exist |
| `services/gmail.js` | Gmail: search, read, drafts, send, reply, attachments |
| `services/calendar.js` | Calendar: list, search, create, update, delete |
| `services/docs.js` | Google Docs: create, read, update, append |
| `credentials.json` | Your Google Cloud app identity — **secret, never committed** |
| `tokens/` | Per-account access grants — **secret, never committed** |
