import { createMcpServer, startMcpHttpServer, mcpEvents } from "./mcp-server.js";
import { PokeClient } from "./poke-client.js";
import { startTUI, tuiEvents } from "./tui.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveToken() {
  if (process.env.POKE_API_KEY) return process.env.POKE_API_KEY;

  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  try {
    const cfg = JSON.parse(readFileSync(join(configDir, "poke-tui", "config.json"), "utf-8"));
    if (cfg.apiKey) return cfg.apiKey;
  } catch {}

  try {
    const creds = JSON.parse(readFileSync(join(configDir, "poke", "credentials.json"), "utf-8"));
    if (creds.token) return creds.token;
  } catch {}

  return null;
}

const POKE_API_KEY = resolveToken();

if (!POKE_API_KEY) {
  console.error("No credentials found. Run: npx poke-tui");
  process.exit(1);
}

const inkInstance = startTUI();

const client = new PokeClient({
  apiKey: POKE_API_KEY,
  onEvent: (type, data) => {
    switch (type) {
      case "tunnel-connected":
        tuiEvents.emit("connected", true);
        break;
      case "tunnel-disconnected":
        tuiEvents.emit("connected", false);
        tuiEvents.emit("system", "Connection lost. Reconnecting…");
        break;
      case "tunnel-error":
        tuiEvents.emit("error", `Connection error: ${data}`);
        break;
      case "error":
        tuiEvents.emit("error", data);
        break;
    }
  },
});

// Graceful shutdown on Ctrl+C or SIGTERM (e.g. kill, launchctl stop)
// This ensures the connection is properly deleted from Poke's servers
// rather than leaving an orphan that blocks future connections.
async function gracefulShutdown(signal) {
  tuiEvents.emit("system", `Shutting down (${signal})…`);
  try { await client.stop(); } catch {}
  process.exit(0);
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

mcpEvents.on("reply", (text) => {
  tuiEvents.emit("message", "poke", text);
});

mcpEvents.on("notification", (message) => {
  tuiEvents.emit("system", message);
});

tuiEvents.on("user-input", async (text) => {
  if (text.startsWith("/")) {
    await handleCommand(text);
    return;
  }

  tuiEvents.emit("message", "you", text);

  try {
    const res = await client.sendMessage(text);
    if (res.success === false) {
      tuiEvents.emit("error", res.message || "Failed to send message.");
    }
  } catch (err) {
    tuiEvents.emit("error", err.message);
  }
});

tuiEvents.on("user-quit", async () => {
  try { await client.stop(); } catch {}
  process.exit(0);
});

async function handleCommand(text) {
  const parts = text.slice(1).split(" ");
  const cmd = parts[0]?.toLowerCase();

  if (cmd === "help") {
    tuiEvents.emit("system", "Commands:");
    tuiEvents.emit("system", "  /status           — connection info");
    tuiEvents.emit("system", "  /cleanup          — delete stale connections");
    tuiEvents.emit("system", "  /webhook create <when> | <do what>");
    tuiEvents.emit("system", '  /webhook fire <#> {"data":"here"}');
    tuiEvents.emit("system", "  /webhooks         — list active webhooks");
    return;
  }

  if (cmd === "status") {
    tuiEvents.emit("system", client.tunnelInfo ? "Connected and ready." : "Connecting…");
    if (client.tunnelInfo?.connectionId) {
      tuiEvents.emit("system", `Connection: ${client.tunnelInfo.connectionId}`);
    }
    tuiEvents.emit("system", `Webhooks: ${client.webhooks.length}`);
    return;
  }

  // Manual cleanup: useful when poke-tui was force-killed previously
  // and stale connections are blocking new ones
  if (cmd === "cleanup") {
    tuiEvents.emit("system", "Cleaning up stale connections…");
    try {
      await client.cleanupStaleConnections();
      tuiEvents.emit("system", "Done.");
    } catch (err) {
      tuiEvents.emit("error", `Cleanup failed: ${err.message}`);
    }
    return;
  }

  if (cmd === "webhooks") {
    if (client.webhooks.length === 0) {
      tuiEvents.emit("system", "No webhooks yet. Create one with /webhook create");
      return;
    }
    client.webhooks.forEach((wh, i) => {
      tuiEvents.emit("system", `  #${i}  ${wh.triggerId}`);
    });
    return;
  }

  if (cmd === "webhook") {
    const sub = parts[1]?.toLowerCase();

    if (sub === "create") {
      const rest = parts.slice(2).join(" ");
      const pipeIdx = rest.indexOf("|");
      if (pipeIdx === -1) {
        tuiEvents.emit("error", "Usage: /webhook create <when> | <do what>");
        return;
      }
      const condition = rest.slice(0, pipeIdx).trim();
      const action = rest.slice(pipeIdx + 1).trim();
      try {
        await client.createWebhook({ condition, action });
        tuiEvents.emit("system", `Webhook #${client.webhooks.length - 1} created.`);
      } catch (err) {
        tuiEvents.emit("error", err.message);
      }
      return;
    }

    if (sub === "fire") {
      const index = parseInt(parts[2], 10);
      const jsonStr = parts.slice(3).join(" ");
      if (isNaN(index) || !jsonStr) {
        tuiEvents.emit("error", 'Usage: /webhook fire <#> {"data":"here"}');
        return;
      }
      let data;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        tuiEvents.emit("error", "Invalid JSON.");
        return;
      }
      try {
        await client.fireWebhook(index, data);
        tuiEvents.emit("system", "Webhook fired.");
      } catch (err) {
        tuiEvents.emit("error", err.message);
      }
      return;
    }

    tuiEvents.emit("error", "Try: /webhook create or /webhook fire");
    return;
  }

  tuiEvents.emit("error", "Unknown command. Type /help");
}

async function fetchUserName() {
  const base = process.env.POKE_API ?? "https://poke.com/api/v1";
  const { getToken } = await import("poke");
  const tokens = [getToken(), POKE_API_KEY].filter(Boolean);

  for (const token of tokens) {
    try {
      const res = await fetch(`${base}/user/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const full = data.name || data.email || data.id || null;
        if (!full) return null;
        return full.split(/[\s@]/)[0];
      }
    } catch {}
  }
  return null;
}

async function main() {
  fetchUserName().then((name) => {
    if (name) tuiEvents.emit("user-name", name);
  });

  try {
    createMcpServer();
    const { port } = await startMcpHttpServer();
    await client.init(port);
    await client.startTunnel(port);
  } catch (err) {
    tuiEvents.emit("error", err.message);
    tuiEvents.emit("system", "Replies will arrive on your phone instead.");
  }
}

main();
