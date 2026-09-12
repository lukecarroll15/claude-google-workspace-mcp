const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const { searchEmails, getEmail, createDraft, sendEmail, listDrafts, deleteDraft, updateDraft, replyToEmail, downloadAttachment } = require("./services/gmail");
const { listEvents, searchEvents, createEvent, updateEvent, deleteEvent } = require("./services/calendar");
const { createDocument, getDocument, updateDocument, appendToDocument } = require("./services/docs");
const {
  authenticate,
  listAccounts,
} = require("./auth/accounts");

async function getAuth(account) {
  if (!account) {
    throw new Error(
      `Account is required. Available accounts: ${listAccounts().join(", ")}`
    );
  }

  const accounts = listAccounts();

  if (!accounts.includes(account)) {
    throw new Error(
      `Unknown account "${account}". Available accounts: ${accounts.join(", ")}`
    );
  }

  return authenticate(account);
}

async function getDrive(account) {
  const auth = await getAuth(account);

  return google.drive({
    version: "v3",
    auth,
  });
}

function accountProperty() {
  const accounts = listAccounts();

  return {
    type: "string",
    description:
      `Google account to use. Available accounts: ${accounts.join(", ")}.`,
    enum: accounts,
  };
}

// Drive's own client library only ever does a single-shot multipart upload,
// which silently truncates past a few megabytes. These implement the resumable
// protocol by hand: open a session, PUT the file in chunks, and resume from
// whatever byte Drive says it actually kept.

const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const UPLOAD_MAX_RETRIES = 5;

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessMimeType(filePath) {
  return (
    MIME_TYPES[path.extname(filePath).toLowerCase()] ||
    "application/octet-stream"
  );
}

function headerValue(headers, key) {
  if (!headers) {
    return undefined;
  }

  // gaxios 7 returns a fetch Headers object, older versions a plain object.
  if (typeof headers.get === "function") {
    return headers.get(key);
  }

  return headers[key] ?? headers[key.toLowerCase()];
}

function parseRangeEnd(rangeHeader) {
  // Drive answers a partial upload with "bytes=0-262143".
  if (!rangeHeader) {
    return -1;
  }

  const match = /bytes=\d+-(\d+)/.exec(rangeHeader);

  return match ? Number(match[1]) : -1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startUploadSession(
  auth,
  metadata,
  mimeType,
  totalBytes
) {
  const response = await auth.request({
    url:
      "https://www.googleapis.com/upload/drive/v3/files" +
      "?uploadType=resumable" +
      "&supportsAllDrives=true" +
      "&fields=id,name,parents,size,mimeType,webViewLink",
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(totalBytes),
    },
    data: JSON.stringify(metadata),
  });

  const sessionUri = headerValue(response.headers, "location");

  if (!sessionUri) {
    throw new Error(
      "Drive did not return a resumable session URI."
    );
  }

  return sessionUri;
}

async function queryUploadedBytes(auth, sessionUri, totalBytes) {
  const response = await auth.request({
    url: sessionUri,
    method: "PUT",
    headers: {
      "Content-Range": `bytes */${totalBytes}`,
    },
    validateStatus: () => true,
    responseType: "json",
  });

  if (response.status === 200 || response.status === 201) {
    return { done: true, file: response.data };
  }

  if (response.status === 308) {
    return {
      done: false,
      offset:
        parseRangeEnd(headerValue(response.headers, "range")) + 1,
    };
  }

  throw new Error(
    `Upload session is no longer valid (HTTP ${response.status}).`
  );
}

async function resumableUpload({
  auth,
  localPath,
  name,
  parentFolderId,
  mimeType,
}) {
  const source = path.resolve(localPath);

  if (!fs.existsSync(source)) {
    throw new Error(`No such file: ${source}`);
  }

  const stats = fs.statSync(source);

  if (stats.isDirectory()) {
    throw new Error(
      `${source} is a directory. Upload files one at a time.`
    );
  }

  const totalBytes = stats.size;
  const metadata = { name: name || path.basename(source) };

  if (parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  // No mimeType on the metadata, so Drive stores the file as-is instead of
  // converting a PDF or .docx into a Google Doc.
  const sessionUri = await startUploadSession(
    auth,
    metadata,
    mimeType || guessMimeType(source),
    totalBytes
  );

  // An empty file still needs one request to close the session.
  if (totalBytes === 0) {
    const response = await auth.request({
      url: sessionUri,
      method: "PUT",
      headers: { "Content-Range": "bytes */0" },
      responseType: "json",
    });

    return response.data;
  }

  const handle = fs.openSync(source, "r");

  try {
    let offset = 0;
    let attempts = 0;

    while (offset < totalBytes) {
      const length = Math.min(
        UPLOAD_CHUNK_SIZE,
        totalBytes - offset
      );
      const chunk = Buffer.allocUnsafe(length);

      fs.readSync(handle, chunk, 0, length, offset);

      const response = await auth.request({
        url: sessionUri,
        method: "PUT",
        headers: {
          "Content-Range":
            `bytes ${offset}-${offset + length - 1}/${totalBytes}`,
        },
        data: chunk,
        validateStatus: () => true,
        responseType: "json",
      });

      if (response.status === 200 || response.status === 201) {
        return response.data;
      }

      if (response.status === 308) {
        const next =
          parseRangeEnd(headerValue(response.headers, "range")) + 1;

        if (next > offset) {
          offset = next;
          attempts = 0;
          continue;
        }

        // Drive kept nothing from that chunk. Resend it, but do not spin
        // forever if it keeps rejecting the same bytes.
        attempts += 1;

        if (attempts > UPLOAD_MAX_RETRIES) {
          throw new Error(
            `Upload stalled at byte ${offset} after ` +
            `${UPLOAD_MAX_RETRIES} retries.`
          );
        }

        await sleep(1000 * 2 ** (attempts - 1));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        attempts += 1;

        if (attempts > UPLOAD_MAX_RETRIES) {
          throw new Error(
            `Upload failed after ${UPLOAD_MAX_RETRIES} retries ` +
            `(HTTP ${response.status}).`
          );
        }

        await sleep(1000 * 2 ** (attempts - 1));

        const status = await queryUploadedBytes(
          auth,
          sessionUri,
          totalBytes
        );

        if (status.done) {
          return status.file;
        }

        offset = status.offset;
        continue;
      }

      throw new Error(
        `Upload failed (HTTP ${response.status}): ` +
        JSON.stringify(response.data)
      );
    }

    // Only reached if Drive acknowledged every byte without ever returning
    // the finished file metadata.
    const status = await queryUploadedBytes(
      auth,
      sessionUri,
      totalBytes
    );

    if (status.done) {
      return status.file;
    }

    throw new Error(
      "Drive accepted every chunk but never returned the file."
    );
  } finally {
    fs.closeSync(handle);
  }
}

async function main() {
  const accounts = listAccounts();

  if (accounts.length === 0) {
    throw new Error(
      "No Google accounts are authenticated. Run node auth/login.js <account> first."
    );
  }

  console.error(
    `Google Workspace MCP starting. Authenticated accounts: ${accounts.join(", ")}`
  );

  const server = new Server(
    {
      name: "claude-google-workspace-mcp",
      version: "2.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: [
        {
          name: "search_files",
          description:
            "Search files and folders in a specified Google Drive account.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              query: {
                type: "string",
                description:
                  "Google Drive query. Example: name contains 'invoice'",
              },
            },
            required: ["account", "query"],
          },
        },

        {
          name: "get_file",
          description:
            "Get metadata for a Google Drive file or folder.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
            },
            required: ["account", "fileId"],
          },
        },

        {
          name: "list_folder",
          description:
            "List all files and folders inside a Google Drive folder.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              folderId: {
                type: "string",
              },
            },
            required: ["account", "folderId"],
          },
        },

        {
          name: "read_file",
          description:
            "Read the contents of a Google Drive file. Supports Google Docs, Google Sheets, Google Slides and text-based files.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
            },
            required: ["account", "fileId"],
          },
        },

        {
          name: "download_file",
          description:
            "Download a Google Drive file to the local computer.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
              destinationPath: {
                type: "string",
              },
            },
            required: ["account", "fileId", "destinationPath"],
          },
        },

        {
          name: "upload_file",
          description:
            "Upload a local file to Google Drive. Keeps the original file " +
            "format (a PDF stays a PDF, it is not converted to a Google Doc). " +
            "Uses a resumable upload, so large files are safe.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              localPath: {
                type: "string",
                description:
                  "Absolute path to the file on this computer.",
              },
              parentFolderId: {
                type: "string",
                description:
                  "Destination folder ID. Defaults to My Drive root.",
              },
              name: {
                type: "string",
                description:
                  "Name to give the file in Drive. Defaults to the " +
                  "local filename.",
              },
              mimeType: {
                type: "string",
                description:
                  "Override the MIME type. Normally guessed from the " +
                  "file extension.",
              },
            },
            required: ["account", "localPath"],
          },
        },

        {
          name: "rename_file",
          description:
            "Rename a Google Drive file or folder.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
              newName: {
                type: "string",
              },
            },
            required: ["account", "fileId", "newName"],
          },
        },

        {
          name: "move_file",
          description:
            "Move a Google Drive file or folder to another folder.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
              destinationFolderId: {
                type: "string",
              },
            },
            required: ["account", "fileId", "destinationFolderId"],
          },
        },

        {
          name: "create_folder",
          description:
            "Create a new folder in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              name: {
                type: "string",
              },
              parentFolderId: {
                type: "string",
              },
            },
            required: ["account", "name"],
          },
        },

        {
          name: "copy_file",
          description:
            "Copy a Google Drive file. Google Drive does not support copying folders directly.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
              newName: {
                type: "string",
              },
              destinationFolderId: {
                type: "string",
              },
            },
            required: ["account", "fileId"],
          },
        },

        {
          name: "trash_file",
          description:
            "Move a Google Drive file or folder to the trash. This is reversible.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
            },
            required: ["account", "fileId"],
          },
        },

        {
      name: "create_document",
      description: "Create a new Google Doc.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountProperty(),
          title: {
            type: "string",
            description: "Title of the new Google Doc.",
          },
        },
        required: ["account", "title"],
      },
    },

    {
      name: "get_document",
      description: "Read a Google Doc.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountProperty(),
          documentId: {
            type: "string",
            description: "Google Docs document ID.",
          },
        },
        required: ["account", "documentId"],
      },
    },

    {
      name: "update_document",
      description: "Replace the content of a Google Doc.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountProperty(),
          documentId: {
            type: "string",
            description: "Google Docs document ID.",
          },
          text: {
            type: "string",
            description: "New document text.",
          },
        },
        required: ["account", "documentId", "text"],
      },
    },

    {
      name: "append_to_document",
      description: "Append text to the end of a Google Doc.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountProperty(),
          documentId: {
            type: "string",
            description: "Google Docs document ID.",
          },
          text: {
            type: "string",
            description: "Text to append.",
          },
        },
        required: ["account", "documentId", "text"],
      },
    },

    {
          name: "delete_event",
        description:
          "Delete an existing Google Calendar event.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            calendarId: {
              type: "string",
              description: "Calendar ID. Defaults to primary.",
            },
            eventId: {
              type: "string",
              description: "ID of the event to delete.",
            },
          },
          required: ["account", "eventId"],
        },
      },

      {
        name: "update_event",
        description:
          "Update an existing Google Calendar event. Only supplied fields are changed.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            calendarId: {
              type: "string",
              description: "Calendar ID. Defaults to primary.",
            },
            eventId: {
              type: "string",
              description: "ID of the event to update.",
            },
            summary: {
              type: "string",
              description: "New event title.",
            },
            description: {
              type: "string",
              description: "New event description.",
            },
            location: {
              type: "string",
              description: "New event location.",
            },
            start: {
              type: "string",
              description:
                "New event start in RFC3339 format, or a plain " +
                "YYYY-MM-DD date for an all-day event.",
            },
            end: {
              type: "string",
              description:
                "New event end in RFC3339 format, or a plain " +
                "YYYY-MM-DD date for an all-day event. All-day end " +
                "dates are exclusive.",
            },
            timeZone: {
              type: "string",
              description: "Optional IANA time zone, e.g. Europe/Dublin.",
            },
            attendees: {
              type: "array",
              items: {
                type: "string",
              },
              description: "New attendee email addresses.",
            },
            colorId: {
              type: "string",
              description:
                "Optional Google Calendar colour id, \"1\"-\"11\" " +
                "(3=Grape, 6=Tangerine, 8=Graphite, 10=Basil, 11=Tomato).",
            },
            availability: {
              type: "string",
              enum: ["busy", "free"],
              description:
                "Whether the event blocks time when others check your " +
                "availability. \"busy\" is the Google default, \"free\" " +
                "leaves the slot bookable. Separate from event visibility.",
            },
            recurrence: {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "Optional RFC5545 recurrence lines, e.g. " +
                "[\"RRULE:FREQ=WEEKLY;UNTIL=20261204T235900Z\", " +
                "\"EXDATE;TZID=Europe/Dublin:20261026T090000\"].",
            },
          },
          required: ["account", "eventId"],
        },
      },

      {
        name: "create_event",
        description:
          "Create a Google Calendar event on the selected account's calendar.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            calendarId: {
              type: "string",
              description: "Calendar ID. Defaults to primary.",
            },
            summary: {
              type: "string",
              description: "Event title.",
            },
            description: {
              type: "string",
              description: "Optional event description.",
            },
            location: {
              type: "string",
              description: "Optional event location.",
            },
            start: {
              type: "string",
              description:
                "Event start in RFC3339 format, or a plain " +
                "YYYY-MM-DD date for an all-day event.",
            },
            end: {
              type: "string",
              description:
                "Event end in RFC3339 format, or a plain " +
                "YYYY-MM-DD date for an all-day event. All-day end " +
                "dates are exclusive.",
            },
            timeZone: {
              type: "string",
              description: "Optional IANA time zone, e.g. Europe/Dublin.",
            },
            attendees: {
              type: "array",
              items: {
                type: "string",
              },
              description: "Optional list of attendee email addresses.",
            },
            colorId: {
              type: "string",
              description:
                "Optional Google Calendar colour id, \"1\"-\"11\" " +
                "(3=Grape, 6=Tangerine, 8=Graphite, 10=Basil, 11=Tomato).",
            },
            availability: {
              type: "string",
              enum: ["busy", "free"],
              description:
                "Whether the event blocks time when others check your " +
                "availability. Defaults to \"free\" for all-day events and " +
                "\"busy\" for timed ones, matching the Google Calendar web " +
                "UI. Separate from event visibility.",
            },
            recurrence: {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "Optional RFC5545 recurrence lines, e.g. " +
                "[\"RRULE:FREQ=WEEKLY;UNTIL=20261204T235900Z\", " +
                "\"EXDATE;TZID=Europe/Dublin:20261026T090000\"].",
            },
          },
          required: ["account", "summary", "start", "end"],
        },
      },

      {
        name: "search_events",
        description:
          "Search Google Calendar events by text. Searches event title, description, location, and other event fields supported by Google Calendar.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            query: {
              type: "string",
              description: "Text to search for in calendar events.",
            },
            calendarId: {
              type: "string",
              description: "Calendar ID. Defaults to primary.",
            },
            timeMin: {
              type: "string",
              description:
                "Start of the time range in RFC3339 format. Defaults to now.",
            },
            timeMax: {
              type: "string",
              description:
                "End of the time range in RFC3339 format.",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results. Defaults to 20.",
            },
          },
          required: ["account", "query"],
        },
      },

      {
        name: "list_events",
        description:
          "List Google Calendar events for an account. Defaults to the primary calendar.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            calendarId: {
              type: "string",
              description: "Calendar ID. Defaults to primary.",
            },
            timeMin: {
              type: "string",
              description:
                "Start of the time range in RFC3339 format. Defaults to now.",
            },
            timeMax: {
              type: "string",
              description:
                "End of the time range in RFC3339 format.",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of events to return. Defaults to 20.",
            },
          },
          required: ["account"],
        },
      },

      {
        name: "reply_to_email",
        description:
          "Reply to an existing Gmail message while preserving its conversation thread.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            messageId: {
              type: "string",
              description: "The Gmail message ID to reply to.",
            },
            body: {
              type: "string",
              description: "Reply body.",
            },
            cc: {
              type: "string",
              description: "Optional CC recipients.",
            },
            bcc: {
              type: "string",
              description: "Optional BCC recipients.",
            },
          },
          required: ["account", "messageId", "body"],
        },
      },

      {
        name: "update_draft",
        description:
          "Update the contents of an existing Gmail draft without sending it.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            draftId: {
              type: "string",
              description: "The Gmail draft ID to update.",
            },
            to: {
              type: "string",
              description: "Recipient email address.",
            },
            subject: {
              type: "string",
              description: "Email subject.",
            },
            body: {
              type: "string",
              description: "Email body.",
            },
            cc: {
              type: "string",
              description: "Optional CC recipients.",
            },
            bcc: {
              type: "string",
              description: "Optional BCC recipients.",
            },
          },
          required: ["account", "draftId", "to", "subject", "body"],
        },
      },

      {
        name: "delete_draft",
        description:
          "Permanently delete a Gmail draft from the selected account.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            draftId: {
              type: "string",
              description: "The Gmail draft ID to delete.",
            },
          },
          required: ["account", "draftId"],
        },
      },

      {
        name: "list_drafts",
        description:
          "List Gmail drafts in the selected account.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            maxResults: {
              type: "number",
              description: "Maximum number of drafts to return. Defaults to 20.",
            },
          },
          required: ["account"],
        },
      },

      {
        name: "send_email",
        description:
          "Send an email immediately from the selected Gmail account.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            to: {
              type: "string",
              description: "Recipient email address.",
            },
            subject: {
              type: "string",
              description: "Email subject.",
            },
            body: {
              type: "string",
              description: "Plain-text email body.",
            },
            cc: {
              type: "string",
              description: "Optional CC recipients.",
            },
            bcc: {
              type: "string",
              description: "Optional BCC recipients.",
            },
          },
          required: ["account", "to", "subject", "body"],
        },
      },

      {
        name: "create_draft",
        description:
          "Create a Gmail draft without sending it.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            to: {
              type: "string",
              description: "Recipient email address.",
            },
            subject: {
              type: "string",
              description: "Email subject.",
            },
            body: {
              type: "string",
              description: "Plain-text email body.",
            },
            cc: {
              type: "string",
              description: "Optional CC recipients.",
            },
            bcc: {
              type: "string",
              description: "Optional BCC recipients.",
            },
          },
          required: ["account", "to", "subject", "body"],
        },
      },

      {
        name: "search_emails",
        description:
          "Search Gmail messages using Gmail search syntax.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            query: {
              type: "string",
              description:
                "Gmail search query using standard Gmail syntax. Normal searches exclude Trash and Spam. Use in:anywhere when you also want to search Trash and Spam. Examples: from:someone@example.com, subject:invoice, newer_than:7d, in:anywhere",
            },
            maxResults: {
              type: "number",
              description:
                "Maximum number of emails to return. Default 20.",
            },
          },
          required: ["account", "query"],
        },
      },

      {
        name: "get_email",
        description:
          "Read the contents and metadata of a Gmail message. The attachments array lists each attachment's attachmentId for use with download_attachment.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            messageId: {
              type: "string",
              description: "Gmail message ID.",
            },
          },
          required: ["account", "messageId"],
        },
      },

      {
        name: "download_attachment",
        description:
          "Download an attachment from a Gmail message to the local computer. Call get_email first to read the attachmentId from its attachments array.",
        inputSchema: {
          type: "object",
          properties: {
            account: accountProperty(),
            messageId: {
              type: "string",
              description: "Gmail message ID.",
            },
            attachmentId: {
              type: "string",
              description:
                "Attachment ID, from the attachments array returned by get_email.",
            },
            destinationPath: {
              type: "string",
              description:
                "Absolute path to write the file to. Parent directories are created if missing.",
            },
          },
          required: [
            "account",
            "messageId",
            "attachmentId",
            "destinationPath",
          ],
        },
      },

      {
        name: "untrash_file",
          description:
            "Restore a Google Drive file or folder from the trash.",
          inputSchema: {
            type: "object",
            properties: {
              account: accountProperty(),
              fileId: {
                type: "string",
              },
            },
            required: ["account", "fileId"],
          },
        },
      ],
    })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params;

      const drive = await getDrive(args.account);

      // SEARCH
      if (name === "search_files") {
        const response = await drive.files.list({
          q: args.query,
          fields:
            "files(id,name,mimeType,parents,modifiedTime,size,webViewLink)",
          pageSize: 100,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                response.data.files,
                null,
                2
              ),
            },
          ],
        };
      }

      // GET METADATA
      if (name === "get_file") {
        const response = await drive.files.get({
          fileId: args.fileId,
          fields:
            "id,name,mimeType,parents,modifiedTime,size,webViewLink,trashed",
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                response.data,
                null,
                2
              ),
            },
          ],
        };
      }

      // LIST FOLDER
      if (name === "list_folder") {
        const response = await drive.files.list({
          q: `'${args.folderId}' in parents and trashed = false`,
          fields:
            "files(id,name,mimeType,parents,modifiedTime,size,webViewLink)",
          orderBy: "folder,name",
          pageSize: 1000,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                response.data.files,
                null,
                2
              ),
            },
          ],
        };
      }

      // READ FILE
      if (name === "read_file") {
        const metadata = await drive.files.get({
          fileId: args.fileId,
          fields: "id,name,mimeType,size",
        });

        const file = metadata.data;

        if (
          file.mimeType ===
          "application/vnd.google-apps.document"
        ) {
          const response = await drive.files.export({
            fileId: args.fileId,
            mimeType: "text/plain",
          });

          return {
            content: [
              {
                type: "text",
                text: response.data,
              },
            ],
          };
        }

        if (
          file.mimeType ===
          "application/vnd.google-apps.spreadsheet"
        ) {
          const response = await drive.files.export({
            fileId: args.fileId,
            mimeType: "text/csv",
          });

          return {
            content: [
              {
                type: "text",
                text: response.data,
              },
            ],
          };
        }

        if (
          file.mimeType ===
          "application/vnd.google-apps.presentation"
        ) {
          const response = await drive.files.export({
            fileId: args.fileId,
            mimeType: "text/plain",
          });

          return {
            content: [
              {
                type: "text",
                text: response.data,
              },
            ],
          };
        }

        if (file.mimeType?.startsWith("text/")) {
          const response = await drive.files.get(
            {
              fileId: args.fileId,
              alt: "media",
            },
            {
              responseType: "text",
            }
          );

          return {
            content: [
              {
                type: "text",
                text: response.data,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Cannot directly read ${file.name} ` +
                `(${file.mimeType}). ` +
                `Use download_file to download it first.`,
            },
          ],
        };
      }

      // DOWNLOAD
      if (name === "download_file") {
        const metadata = await drive.files.get({
          fileId: args.fileId,
          fields: "id,name,mimeType",
        });

        const destination = path.resolve(
          args.destinationPath
        );

        const response = await drive.files.get(
          {
            fileId: args.fileId,
            alt: "media",
          },
          {
            responseType: "stream",
          }
        );

        await new Promise((resolve, reject) => {
          const writer =
            fs.createWriteStream(destination);

          response.data
            .pipe(writer)
            .on("finish", resolve)
            .on("error", reject);
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Downloaded ${metadata.data.name} ` +
                `to ${destination}`,
            },
          ],
        };
      }

      // UPLOAD
      if (name === "upload_file") {
        const auth = await getAuth(args.account);

        const file = await resumableUpload({
          auth,
          localPath: args.localPath,
          name: args.name,
          parentFolderId: args.parentFolderId,
          mimeType: args.mimeType,
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Uploaded: ` + JSON.stringify(file),
            },
          ],
        };
      }

      // RENAME
      if (name === "rename_file") {
        const response = await drive.files.update({
          fileId: args.fileId,
          requestBody: {
            name: args.newName,
          },
          fields: "id,name",
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Renamed successfully: ` +
                JSON.stringify(response.data),
            },
          ],
        };
      }

      // MOVE
      if (name === "move_file") {
        const current = await drive.files.get({
          fileId: args.fileId,
          fields: "parents",
        });

        const previousParents =
          current.data.parents?.join(",") || "";

        const response = await drive.files.update({
          fileId: args.fileId,
          addParents: args.destinationFolderId,
          removeParents: previousParents,
          fields: "id,name,parents",
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Moved successfully: ` +
                JSON.stringify(response.data),
            },
          ],
        };
      }

      // CREATE FOLDER
      if (name === "create_folder") {
        const requestBody = {
          name: args.name,
          mimeType:
            "application/vnd.google-apps.folder",
        };

        if (args.parentFolderId) {
          requestBody.parents = [
            args.parentFolderId,
          ];
        }

        const response = await drive.files.create({
          requestBody,
          fields: "id,name,parents",
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Folder created: ` +
                JSON.stringify(response.data),
            },
          ],
        };
      }

      // COPY
      if (name === "copy_file") {
        const requestBody = {};

        if (args.newName) {
          requestBody.name = args.newName;
        }

        if (args.destinationFolderId) {
          requestBody.parents = [
            args.destinationFolderId,
          ];
        }

        const response = await drive.files.copy({
          fileId: args.fileId,
          requestBody,
          fields: "id,name,parents",
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Copied successfully: ` +
                JSON.stringify(response.data),
            },
          ],
        };
      }

      // TRASH
      if (name === "trash_file") {
        const response = await drive.files.update({
          fileId: args.fileId,
          requestBody: {
            trashed: true,
          },
          fields: "id,name,trashed",
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Moved to trash: ` +
                JSON.stringify(response.data),
            },
          ],
        };
      }

      // UNTRASH
      if (name === "untrash_file") {
        const response = await drive.files.update({
          fileId: args.fileId,
          requestBody: {
            trashed: false,
          },
          fields: "id,name,trashed,parents",
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Restored successfully: ` +
                JSON.stringify(response.data) +
                `\n\nNote: Google Drive may restore an item to My Drive root ` +
                `if its original parent folder was also trashed.`,
            },
          ],
        };
      }

      // GMAIL LIST DRAFTS
      if (name === "create_document") {
        const document = await createDocument(
          await authenticate(args.account),
          {
            title: args.title,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(document, null, 2),
            },
          ],
        };
      }

      if (name === "get_document") {
        const document = await getDocument(
          await authenticate(args.account),
          {
            documentId: args.documentId,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(document, null, 2),
            },
          ],
        };
      }

      if (name === "update_document") {
        const document = await updateDocument(
          await authenticate(args.account),
          {
            documentId: args.documentId,
            text: args.text,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(document, null, 2),
            },
          ],
        };
      }

      if (name === "append_to_document") {
        const document = await appendToDocument(
          await authenticate(args.account),
          {
            documentId: args.documentId,
            text: args.text,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(document, null, 2),
            },
          ],
        };
      }

      if (name === "delete_event") {
        const result = await deleteEvent(
          await authenticate(args.account),
          {
            calendarId: args.calendarId || "primary",
            eventId: args.eventId,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (name === "update_event") {
        const event = await updateEvent(
          await authenticate(args.account),
          {
            calendarId: args.calendarId || "primary",
            eventId: args.eventId,
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: args.start,
            end: args.end,
            timeZone: args.timeZone,
            attendees: args.attendees,
            recurrence: args.recurrence,
            colorId: args.colorId,
            availability: args.availability,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(event, null, 2),
            },
          ],
        };
      }

      if (name === "create_event") {
        const event = await createEvent(
          await authenticate(args.account),
          {
            calendarId: args.calendarId || "primary",
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: args.start,
            end: args.end,
            timeZone: args.timeZone,
            attendees: args.attendees,
            recurrence: args.recurrence,
            colorId: args.colorId,
            availability: args.availability,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(event, null, 2),
            },
          ],
        };
      }

      if (name === "search_events") {
        const events = await searchEvents(
          await authenticate(args.account),
          {
            calendarId: args.calendarId || "primary",
            query: args.query,
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            maxResults: args.maxResults || 20,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(events, null, 2),
            },
          ],
        };
      }

      if (name === "list_events") {
        const events = await listEvents(
          await authenticate(args.account),
          {
            calendarId: args.calendarId || "primary",
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            maxResults: args.maxResults || 20,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(events, null, 2),
            },
          ],
        };
      }

      if (name === "reply_to_email") {
        const result = await replyToEmail(
          await authenticate(args.account),
          {
            messageId: args.messageId,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (name === "update_draft") {
        const result = await updateDraft(
          await authenticate(args.account),
          {
            draftId: args.draftId,
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (name === "delete_draft") {
        const result = await deleteDraft(
          await authenticate(args.account),
          args.draftId
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (name === "list_drafts") {
        const drafts = await listDrafts(
          await authenticate(args.account),
          args.maxResults || 20
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(drafts, null, 2),
            },
          ],
        };
      }

      // GMAIL SEND EMAIL
      if (name === "send_email") {
        const result = await sendEmail(
          await authenticate(args.account),
          {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // GMAIL CREATE DRAFT
      if (name === "create_draft") {
        const draft = await createDraft(
          await authenticate(args.account),
          {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(draft, null, 2),
            },
          ],
        };
      }

      // GMAIL SEARCH
      if (name === "search_emails") {
        const results = await searchEmails(
          await authenticate(args.account),
          args.query,
          args.maxResults || 20
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      // GMAIL READ
      if (name === "get_email") {
        const email = await getEmail(
          await authenticate(args.account),
          args.messageId
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(email, null, 2),
            },
          ],
        };
      }

      if (name === "download_attachment") {
        const result = await downloadAttachment(
          await authenticate(args.account),
          args.messageId,
          args.attachmentId,
          args.destinationPath
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    }
  );

  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
