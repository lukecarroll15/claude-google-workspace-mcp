const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

function encodeSubject(subject) {
  return /[^\\x00-\\x7F]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`
    : subject;
}

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

// Gmail's API caps a whole message at 35 MB; base64 inflates files by a third.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function wrapBase64(buffer) {
  return buffer.toString("base64").replace(/.{76}/g, "$&\r\n");
}

function encodeFilename(filename) {
  return /[^\x20-\x7E]|"/.test(filename)
    ? `filename*=UTF-8''${encodeURIComponent(filename)}`
    : `filename="${filename}"`;
}

// attachments: local file paths. With none, the message stays single-part plain text.
function buildRawMessage(headers, body, attachments = []) {
  let lines;

  if (!attachments.length) {
    lines = [...headers, "Content-Type: text/plain; charset=utf-8", "", body];
  } else {
    let total = 0;
    const files = attachments.map((filePath) => {
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Attachment not found: ${resolved}`);
      }
      const data = fs.readFileSync(resolved);
      total += data.length;
      return {
        filename: path.basename(resolved),
        mimeType:
          MIME_TYPES[path.extname(resolved).toLowerCase()] ||
          "application/octet-stream",
        data,
      };
    });

    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments total ${(total / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB. Share large files through Drive instead.`
      );
    }

    const boundary = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    lines = [
      ...headers,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(body, "utf8")),
      ...files.flatMap((file) => [
        `--${boundary}`,
        `Content-Type: ${file.mimeType}; name="${file.filename.replace(/"/g, "")}"`,
        `Content-Disposition: attachment; ${encodeFilename(file.filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(file.data),
      ]),
      `--${boundary}--`,
      "",
    ];
  }

  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getGmail(auth) {
  return google.gmail({
    version: "v1",
    auth,
  });
}

function decodeBase64Url(data) {
  if (!data) return "";

  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function listAttachments(payload, found = []) {
  if (!payload) return found;

  if (payload.filename && payload.body?.attachmentId) {
    found.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      size: payload.body.size,
      attachmentId: payload.body.attachmentId,
    });
  }

  for (const part of payload.parts || []) {
    listAttachments(part, found);
  }

  return found;
}

async function downloadAttachment(
  auth,
  messageId,
  attachmentId,
  destinationPath
) {
  const gmail = getGmail(auth);

  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  const buffer = Buffer.from(
    (response.data.data || "").replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );

  const directory = path.dirname(destinationPath);

  if (directory) fs.mkdirSync(directory, { recursive: true });

  fs.writeFileSync(destinationPath, buffer);

  return {
    path: destinationPath,
    bytes: buffer.length,
  };
}

function getHeader(headers, name) {
  const header = headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  );

  return header?.value || "";
}

function extractBody(payload) {
  if (!payload) return "";

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    const plainPart = payload.parts.find(
      (part) => part.mimeType === "text/plain"
    );

    if (plainPart) {
      return extractBody(plainPart);
    }

    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return "";
}

async function searchEmails(auth, query, maxResults = 20) {
  const gmail = getGmail(auth);

  const response = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = response.data.messages || [];

  const results = [];

  for (const message of messages) {
    const response = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
      format: "metadata",
      metadataHeaders: [
        "From",
        "To",
        "Cc",
        "Subject",
        "Date",
      ],
    });

    const data = response.data;
    const headers = data.payload?.headers || [];

    results.push({
      id: data.id,
      threadId: data.threadId,
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      cc: getHeader(headers, "Cc"),
      subject: getHeader(headers, "Subject"),
      date: getHeader(headers, "Date"),
      labelIds: data.labelIds || [],
      snippet: data.snippet || "",
    });
  }

  return results;
}

async function getEmail(auth, messageId) {
  const gmail = getGmail(auth);

  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const data = response.data;
  const headers = data.payload?.headers || [];

  return {
    id: data.id,
    threadId: data.threadId,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    bcc: getHeader(headers, "Bcc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    labelIds: data.labelIds || [],
    body: extractBody(data.payload),
    attachments: listAttachments(data.payload),
  };
}


async function sendEmail(auth, { to, subject, body, cc, bcc, attachments }) {
  const gmail = getGmail(auth);

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
  ];

  const raw = buildRawMessage(headers, body, attachments);

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
    },
  });

  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
  };
}


async function listDrafts(auth, maxResults = 20) {
  const gmail = getGmail(auth);

  const response = await gmail.users.drafts.list({
    userId: "me",
    maxResults,
  });

  const drafts = response.data.drafts || [];

  const results = [];

  for (const draft of drafts) {
    const message = await gmail.users.messages.get({
      userId: "me",
      id: draft.message.id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
    });

    const headers = message.data.payload?.headers || [];

    const getHeader = (name) =>
      headers.find(
        (header) =>
          header.name.toLowerCase() === name.toLowerCase()
      )?.value || "";

    results.push({
      draftId: draft.id,
      messageId: draft.message.id,
      threadId: draft.message.threadId,
      from: getHeader("From"),
      to: getHeader("To"),
      cc: getHeader("Cc"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
    });
  }

  return results;
}


async function deleteDraft(auth, draftId) {
  const gmail = getGmail(auth);

  await gmail.users.drafts.delete({
    userId: "me",
    id: draftId,
  });

  return {
    draftId,
    deleted: true,
  };
}


async function updateDraft(
  auth,
  { draftId, to, subject, body, cc, bcc, attachments }
) {
  const gmail = getGmail(auth);

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
  ];

  const raw = buildRawMessage(headers, body, attachments);

  const response = await gmail.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: {
      message: {
        raw,
      },
    },
  });

  return {
    draftId: response.data.id,
    messageId: response.data.message?.id,
    threadId: response.data.message?.threadId,
  };
}

async function replyToEmail(auth, { messageId, body, cc, bcc, attachments }) {
  const gmail = getGmail(auth);

  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID", "References"],
  });

  const headers = original.data.payload?.headers || [];

  const getHeader = (name) =>
    headers.find(
      (header) => header.name.toLowerCase() === name.toLowerCase()
    )?.value || "";

  const from = getHeader("From");
  const originalTo = getHeader("To");
  const originalCc = getHeader("Cc");
  const subject = getHeader("Subject");
  const messageIdHeader = getHeader("Message-ID");
  const references = getHeader("References");

  const replyTo = from.match(/<([^>]+)>/)?.[1] || from;

  const replySubject = /^re:/i.test(subject)
    ? subject
    : `Re: ${subject}`;

  const newReferences = references
    ? `${references} ${messageIdHeader}`.trim()
    : messageIdHeader;

  const headersOut = [
    `To: ${replyTo}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeSubject(replySubject)}`,
    ...(messageIdHeader ? [`In-Reply-To: ${messageIdHeader}`] : []),
    ...(newReferences ? [`References: ${newReferences}`] : []),
  ];

  const raw = buildRawMessage(headersOut, body, attachments);

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: original.data.threadId,
    },
  });

  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
    to: replyTo,
    subject: replySubject,
  };
}

module.exports = {
  searchEmails,
  getEmail,
  createDraft,
  sendEmail,
  listDrafts,
  deleteDraft,
  updateDraft,
  replyToEmail,
  downloadAttachment,
};

async function createDraft(auth, { to, subject, body, cc, bcc, attachments }) {
  const gmail = getGmail(auth);

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
  ];

  const raw = buildRawMessage(headers, body, attachments);

  const response = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
      },
    },
  });

  return {
    draftId: response.data.id,
    messageId: response.data.message?.id,
    threadId: response.data.message?.threadId,
  };
}
