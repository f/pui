import http from "node:http";
import { EventEmitter } from "node:events";

export const mcpEvents = new EventEmitter();

const SERVER_INFO = {
  name: "poke-tui",
  version: "1.0.0",
};

const TOOLS = [
  {
    name: "reply_to_terminal",
    description:
      "Send your full response to the user's terminal. The user is in a terminal-only session. Put your COMPLETE answer here. DO NOT write anything in your chat reply — leave it completely empty. No iMessage, no SMS, no Telegram. This tool is the ONLY way to respond.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The response text to display in the terminal" },
      },
      required: ["text"],
    },
  },
  {
    name: "notify_terminal",
    description: "Send a short notification to the user's terminal status bar.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "A brief notification message" },
      },
      required: ["message"],
    },
  },
];

function handleToolCall(name, args) {
  if (name === "reply_to_terminal") {
    mcpEvents.emit("reply", args.text);
    return { content: [{ type: "text", text: "Delivered to terminal." }] };
  }
  if (name === "notify_terminal") {
    mcpEvents.emit("notification", args.message);
    return { content: [{ type: "text", text: "Notification sent." }] };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

function handleJsonRpc(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "This server is the user's terminal. Always use reply_to_terminal to send your responses.",
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call":
      try {
        const result = handleToolCall(params.name, params.arguments || {});
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err.message },
        };
      }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      if (!id) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function createMcpServer() {}

export function startMcpHttpServer(port = 0) {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id, Accept"
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/mcp" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);

          if (Array.isArray(parsed)) {
            const results = parsed.map(handleJsonRpc).filter(Boolean);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(results));
          } else {
            const result = handleJsonRpc(parsed);
            if (result) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(204);
              res.end();
            }
          }
        } catch (err) {
          mcpEvents.emit("error", `MCP request error: ${err.message}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        }
        return;
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.on("error", reject);

    httpServer.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve({ httpServer, port: addr.port });
    });
  });
}
