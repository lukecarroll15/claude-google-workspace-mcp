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
const { authenticate } = require("./auth/accounts");

const DEFAULT_ACCOUNT = "personal";

async function main() {
  const auth = await authenticate(DEFAULT_ACCOUNT);

  const drive = google.drive({
    version: "v3",
    auth,
  });

  const server = new Server(
    {
      name: "claude-google-drive-full-access",
      version: "2.0.0",
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
            "Search Google Drive files and folders using a Google Drive query.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Google Drive query. Example: name contains 'invoice'",
              },
            },
            required: ["query"],
          },
        },

        {
          name: "get_file",
          description:
            "Get metadata for a Google Drive file or folder.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
              },
            },
            required: ["fileId"],
          },
        },

        {
          name: "list_folder",
          description:
            "List all files and folders inside a Google Drive folder.",
          inputSchema: {
            type: "object",
            properties: {
              folderId: {
                type: "string",
              },
            },
            required: ["folderId"],
          },
        },

        {
          name: "read_file",
          description:
            "Read the contents of a Google Drive file. Supports Google Docs, Google Sheets, Google Slides and text-based files.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
              },
            },
            required: ["fileId"],
          },
        },

        {
          name: "download_file",
          description:
            "Download a Google Drive file to the local computer.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
              },
              destinationPath: {
                type: "string",
              },
            },
            required: ["fileId", "destinationPath"],
          },
        },

        {
          name: "rename_file",
          description:
            "Rename a Google Drive file or folder.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
              },
              newName: {
                type: "string",
              },
            },
            required: ["fileId", "newName"],
          },
        },

        {
          name: "move_file",
          description:
            "Move a Google Drive file or folder to another folder.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
              },
              destinationFolderId: {
                type: "string",
              },
            },
            required: ["fileId", "destinationFolderId"],
          },
        },

        {
          name: "create_folder",
          description:
            "Create a new folder in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
              },
              parentFolderId: {
                type: "string",
              },
            },
            required: ["name"],
          },
        },

        {
          name: "copy_file",
          description:
            "Copy a Google Drive file. Google Drive does not support copying folders directly.",
          inputSchema: {
            type: "object",
            properties: {
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
            required: ["fileId"],
          },
        },

        {
          name: "trash_file",
          description:
            "Move a Google Drive file or folder to the trash. This is reversible.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
              },
            },
            required: ["fileId"],
          },
        },
      ],
    })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params;

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
            "id,name,mimeType,parents,modifiedTime,size,webViewLink",
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

        // Google Docs
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

        // Google Sheets
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

        // Google Slides
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

        // Plain text files
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

      // DOWNLOAD FILE
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

      // COPY FILE
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
