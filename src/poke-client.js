import { Poke, PokeTunnel, getToken } from "poke";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPLY_INSTRUCTION =
  "[TERMINAL SESSION — MANDATORY]\n" +
  "The user is in a TERMINAL-ONLY session. This is non-negotiable.\n" +
  "DO NOT reply via iMessage, SMS, Telegram, or any messaging app.\n" +
  "DO NOT write ANY text in your chat response — leave it completely empty.\n" +
  "Your ONLY action is to call the reply_to_terminal tool with your full answer.\n" +
  "ONLY call reply_to_terminal. NOTHING else.\n" +
  "[END TERMINAL SESSION]\n\n";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const STATE_PATH = join(CONFIG_DIR, "poke-tui", "state.json");
const BASE_URL = process.env.POKE_API ?? "https://poke.com/api/v1";

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")); } catch { return {}; }
}

function saveState(state) {
  mkdirSync(join(CONFIG_DIR, "poke-tui"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export class PokeClient {
  constructor({ apiKey, onEvent }) {
    this.apiKey = apiKey;
    this.onEvent = onEvent || (() => {});
    this.poke = null;
    this.tunnel = null;
    this.tunnelInfo = null;
    this.webhooks = [];
    this._syncTimeout = null;
  }

  async init(mcpPort) {
    this.poke = new Poke({ apiKey: this.apiKey });
    this.mcpUrl = `http://localhost:${mcpPort}/mcp`;
  }

  // Fire-and-forget cleanup — don't block startup on it
  _cleanupOldConnection() {
    const state = loadState();
    if (!state.connectionId) return;
    const token = getToken() || this.apiKey;
    fetch(`${BASE_URL}/mcp/connections/${state.connectionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  async startTunnel(mcpPort) {
    const token = getToken();
    if (!token && !this.apiKey) {
      this.onEvent("error", "Not logged in. Run `poke login` first or set POKE_API_KEY.");
      return;
    }

    // Non-blocking: clean up old connection in background
    this._cleanupOldConnection();

    this.tunnel = new PokeTunnel({
      url: this.mcpUrl,
      name: "Poke TUI Terminal",
      token: token || this.apiKey,
      cleanupOnStop: false,
      // Sync every 10 minutes instead of 5 — less overhead
      syncIntervalMs: 10 * 60 * 1000,
    });

    this.tunnel.on("connected", (info) => {
      this.tunnelInfo = info;
      saveState({ connectionId: info.connectionId });
      this.onEvent("tunnel-connected", info);
      // Single sync attempt shortly after connect
      this._scheduleSyncTools(800);
    });

    this.tunnel.on("disconnected", () => {
      this.tunnelInfo = null;
      this.onEvent("tunnel-disconnected");
    });

    this.tunnel.on("error", (err) => {
      this.onEvent("tunnel-error", err.message);
    });

    this.tunnel.on("toolsSynced", ({ toolCount }) => {
      this.onEvent("tools-synced", toolCount);
    });

    this.tunnel.on("oauthRequired", ({ authUrl }) => {
      this.onEvent("oauth-required", authUrl);
    });

    try {
      await this.tunnel.start();
    } catch (err) {
      this.onEvent("tunnel-error", err.message);
      throw err;
    }
  }

  _scheduleSyncTools(delayMs) {
    if (this._syncTimeout) clearTimeout(this._syncTimeout);
    this._syncTimeout = setTimeout(() => {
      this._syncTimeout = null;
      this.syncTools();
    }, delayMs);
  }

  async sendMessage(text) {
    if (!this.poke) throw new Error("SDK not initialized");
    // Trim the instruction to be shorter — less tokens = faster AI processing
    const fullText = REPLY_INSTRUCTION + text;
    const res = await this.poke.sendMessage(fullText);
    return res;
  }

  async createWebhook({ condition, action }) {
    if (!this.poke) throw new Error("SDK not initialized");
    const webhook = await this.poke.createWebhook({
      condition,
      action: action + " [TERMINAL SESSION: Use reply_to_terminal tool only. No chat message.]",
    });
    this.webhooks.push(webhook);
    return webhook;
  }

  async fireWebhook(index, data) {
    const webhook = this.webhooks[index];
    if (!webhook) throw new Error(`No webhook at index ${index}`);
    return this.poke.sendWebhook({
      webhookUrl: webhook.webhookUrl,
      webhookToken: webhook.webhookToken,
      data,
    });
  }

  async syncTools() {
    if (!this.tunnel) return;
    const connId = this.tunnelInfo?.connectionId ?? loadState().connectionId;
    if (!connId) return;

    const token = getToken() || this.apiKey;
    try {
      const res = await fetch(`${BASE_URL}/mcp/connections/${connId}/sync-tools`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        const toolCount = Array.isArray(data.tools) ? data.tools.length : 0;
        this.onEvent("tools-synced", toolCount);
      } else {
        // Retry once after 2s if sync fails
        this._scheduleSyncTools(2000);
      }
    } catch {
      this._scheduleSyncTools(2000);
    }
  }

  async stop() {
    if (this._syncTimeout) clearTimeout(this._syncTimeout);
    if (this.tunnel) {
      try { await this.tunnel.stop(); } catch {}
    }
  }

  // Called by /cleanup command — lists and deletes all connections
  // except the current one. Useful after force-kills or crashes.
  async cleanupStaleConnections() {
    const token = getToken() || this.apiKey;
    const currentId = this.tunnelInfo?.connectionId ?? loadState().connectionId;

    const res = await fetch(`${BASE_URL}/mcp/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      // API may not support listing — fall back to deleting only the saved stale ID
      const saved = loadState().connectionId;
      if (saved && saved !== currentId) {
        await fetch(`${BASE_URL}/mcp/connections/${saved}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      return;
    }

    const { connections } = await res.json();
    if (!Array.isArray(connections)) return;

    const stale = connections.filter((c) => c.id !== currentId);
    await Promise.allSettled(
      stale.map((c) =>
        fetch(`${BASE_URL}/mcp/connections/${c.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        })
      )
    );
  }
}
