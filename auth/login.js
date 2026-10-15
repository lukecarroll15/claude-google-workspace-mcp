const fs = require("fs");
const path = require("path");
const http = require("http");
const { google } = require("googleapis");

const BASE_DIR = path.join(__dirname, "..");
const CREDENTIALS_PATH = path.join(BASE_DIR, "credentials.json");
const TOKENS_DIR = path.join(BASE_DIR, "tokens");

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/tasks",
];

// Read-only scopes for an account that should only ever be searched, never
// written to: `node auth/login.js <account> --readonly`.
const READONLY_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

async function login(account, readonly) {
  if (!account) {
    throw new Error(
      'Usage: node auth/login.js <account>\nExample: node auth/login.js personal'
    );
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing ${CREDENTIALS_PATH}`);
  }

  fs.mkdirSync(TOKENS_DIR, { recursive: true });

  const credentials = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  const config = credentials.installed || credentials.web;

  const oauth2Client = new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    "http://localhost:3000"
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: readonly ? READONLY_SCOPES : SCOPES,
    prompt: "consent",
  });

  console.error("\nOpen this URL in your browser:\n");
  console.error(authUrl);
  console.error("\nWaiting for Google authentication...\n");

  const tokens = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(
          req.url,
          "http://localhost:3000"
        );

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.end("Authentication failed.");
          server.close();
          reject(new Error(`Google OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.end("Waiting for authentication...");
          return;
        }

        const result = await oauth2Client.getToken(code);

        res.end(
          "Authentication successful. You can close this tab."
        );

        server.close();
        resolve(result.tokens);
      } catch (error) {
        res.end("Authentication failed.");
        server.close();
        reject(error);
      }
    });

    server.listen(3000, "127.0.0.1", () => {
      console.error(
        "OAuth callback listening on http://localhost:3000"
      );
    });

    server.on("error", reject);
  });

  const tokenFile = path.join(
    TOKENS_DIR,
    `${account}.json`
  );

  fs.writeFileSync(
    tokenFile,
    JSON.stringify(tokens, null, 2)
  );

  console.error(
    `\nSuccessfully authenticated account "${account}".`
  );
  console.error(`Token saved to: ${tokenFile}`);
}

login(process.argv[2], process.argv.includes("--readonly")).catch((error) => {
  console.error("\nAuthentication failed:");
  console.error(error.message);
  process.exit(1);
});
