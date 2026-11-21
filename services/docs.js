const { google } = require("googleapis");

function getDocs(auth) {
  return google.docs({
    version: "v1",
    auth,
  });
}

async function createDocument(auth, { title }) {
  const docs = getDocs(auth);

  const response = await docs.documents.create({
    requestBody: {
      title,
    },
  });

  return {
    documentId: response.data.documentId,
    title: response.data.title,
    revisionId: response.data.revisionId || null,
  };
}

async function getDocument(auth, { documentId }) {
  const docs = getDocs(auth);

  const response = await docs.documents.get({
    documentId,
  });

  return {
    documentId: response.data.documentId,
    title: response.data.title,
    revisionId: response.data.revisionId || null,
    body: response.data.body || null,
  };
}

async function updateDocument(auth, { documentId, requests }) {
  const docs = getDocs(auth);

  const response = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests,
    },
  });

  return {
    documentId: response.data.documentId,
    replies: response.data.replies || [],
    writeControl: response.data.writeControl || null,
  };
}

async function replaceDocumentText(auth, { documentId, text }) {
  const docs = getDocs(auth);
  const document = await docs.documents.get({ documentId });
  const content = document.data.body?.content || [];
  const endIndex = content.reduce((max, el) => Math.max(max, el.endIndex || 1), 1);

  const requests = [];
  if (endIndex - 1 > 1) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  if (text) {
    requests.push({ insertText: { location: { index: 1 }, text } });
  }
  if (requests.length === 0) {
    return { documentId, replies: [], writeControl: null };
  }
  return updateDocument(auth, { documentId, requests });
}

async function appendToDocument(auth, { documentId, text }) {
  const docs = getDocs(auth);

  const document = await docs.documents.get({
    documentId,
  });

  const content = document.data.body?.content || [];

  let endIndex = 1;

  for (const element of content) {
    if (element.endIndex && element.endIndex > endIndex) {
      endIndex = element.endIndex;
    }
  }

  const insertIndex = Math.max(1, endIndex - 1);

  const response = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: {
              index: insertIndex,
            },
            text,
          },
        },
      ],
    },
  });

  return {
    documentId,
    replies: response.data.replies || [],
    writeControl: response.data.writeControl || null,
  };
}

module.exports = {
  createDocument,
  getDocument,
  updateDocument,
  replaceDocumentText,
  appendToDocument,
};
