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

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing ${CREDENTIALS_PATH}`);
  }

  const credentials = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  return credentials.installed || credentials.web;
}

function tokenPath(account) {
  return path.join(TOKENS_DIR, `${account}.json`);
}

function createOAuthClient() {
  const config = loadCredentials();

  return new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    "http://localhost:3000"
  );
}

function listAccounts() {
  if (!fs.existsSync(TOKENS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(TOKENS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"));
}

async function authenticate(account) {
  const file = tokenPath(account);

  if (!fs.existsSync(file)) {
    throw new Error(
      `No authentication found for account "${account}". ` +
      `Run the login flow first.`
    );
  }

  const oauth2Client = createOAuthClient();

  const tokens = JSON.parse(
    fs.readFileSync(file, "utf8")
  );

  oauth2Client.setCredentials(tokens);

  return oauth2Client;
}

module.exports = {
  listAccounts,
  authenticate,
};
