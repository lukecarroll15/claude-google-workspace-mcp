const { google } = require("googleapis");

function encodeSubject(subject) {
  return /[^\\x00-\\x7F]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`
    : subject;
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
    `Subject: ${encodeSubject(subject)}`,
    "Content-Type: text/plain; charset=utf-8",
  ];

  const message = [
    ...headers,
    "",
    body,
  ].join("\r\n");

  const encodedMessage = Buffer.from(message, "utf8");

  const raw = encodedMessage
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
  { draftId, to, subject, body, cc, bcc }
) {
  const gmail = getGmail(auth);

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    "Content-Type: text/plain; charset=utf-8",
  ];

  const message = [
    ...headers,
    "",
    body,
  ].join("\r\n");

  const raw = Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

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

async function replyToEmail(auth, { messageId, body, cc, bcc }) {
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
    "Content-Type: text/plain; charset=utf-8",
  ];

  const message = [
    ...headersOut,
    "",
    body,
  ].join("\r\n");

  const raw = Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

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
};

async function createDraft(auth, { to, subject, body, cc, bcc }) {
  const gmail = getGmail(auth);

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    "Content-Type: text/plain; charset=utf-8",
  ];

  const message = [
    ...headers,
    "",
    body,
  ].join("\r\n");

  const raw = Buffer.from(message, "utf8")
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
