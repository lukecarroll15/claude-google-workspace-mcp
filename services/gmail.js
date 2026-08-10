const { google } = require("googleapis");

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
  };
}


async function sendEmail(auth, { to, subject, body, cc, bcc }) {
  const gmail = getGmail(auth);

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ];

  const message = [
    ...headers,
    "",
    body,
  ].join("\r\n");

  const raw = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

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

module.exports = {
  searchEmails,
  getEmail,
  createDraft,
  sendEmail,
  listDrafts,
};

async function createDraft(auth, { to, subject, body, cc, bcc }) {
  const gmail = getGmail(auth);

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ];

  const message = [
    ...headers,
    "",
    body,
  ].join("\r\n");

  const raw = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

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
