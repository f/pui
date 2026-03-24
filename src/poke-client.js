import { Poke, PokeTunnel, login, isLoggedIn, getToken } from "poke";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPLY_INSTRUCTION =
  "[TERMINAL SESSION — MANDATORY]\n" +
  "The user is in a TERMINAL-ONLY session. This is non-negotiable.\n" +
  "DO NOT reply via iMessage. DO NOT reply via SMS. DO NOT reply via Telegram.\n" +
  "DO NOT write ANY text in your chat response. Leave it completely empty.\n" +
  "Your ONLY action is to call the reply_to_terminal tool with your full answer.\n" +
  "If you write anything in the chat message, the user will receive a duplicate and be confused.\n" +
  "ONLY call reply_to_terminal. NOTHING else. No chat message. Zero words in chat.\n" +
  "[END TERMINAL SESSION]\n\n";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const STATE_PATH = join(CONFIG_DIR, "poke-tui", "state.json");

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
  }

  async init(mcpPort) {
    this.poke = new Poke({ apiKey: this.apiKey });
    this.mcpUrl = `http://localhost:${mcpPort}/mcp`;
    this.onEvent("status", "SDK initialized");
  }

  async cleanupOldConnection() {
    const state = loadState();
    if (!state.connectionId) return;
    const token = getToken() || this.apiKey;
    const base = process.env.POKE_API ?? "https://poke.com/api/v1";
    try {
      await fetch(`${base}/mcp/connections/${state.connectionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }

  async startTunnel(mcpPort) {
    const token = getToken();
    if (!token && !this.apiKey) {
      this.onEvent("error", "Not logged in. Run `poke login` first or set POKE_API_KEY.");
      return;
    }

    await this.cleanupOldConnection();

    this.tunnel = new PokeTunnel({
      url: this.mcpUrl,
      name: "Poke TUI Terminal",
      token: token || this.apiKey,
      cleanupOnStop: false,
    });

    this.tunnel.on("connected", (info) => {
      this.tunnelInfo = info;
      saveState({ connectionId: info.connectionId });
      this.onEvent("tunnel-connected", info);
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
      const info = await this.tunnel.start();
      // Explicitly sync tools right after tunnel connects —
      // activateTunnel() syncs server-side but doesn't emit the event
      setTimeout(() => this.syncTools(), 2000);
      return info;
    } catch (err) {
      this.onEvent("tunnel-error", err.message);
      throw err;
    }
  }

  async sendMessage(text) {
    if (!this.poke) throw new Error("SDK not initialized");
    const fullText = REPLY_INSTRUCTION + text;
    const res = await this.poke.sendMessage(fullText);
    return res;
  }

  async createWebhook({ condition, action }) {
    if (!this.poke) throw new Error("SDK not initialized");
    const webhook = await this.poke.createWebhook({
      condition,
      action:
        action +
        " [TERMINAL SESSION: Call reply_to_terminal with your full answer. DO NOT write any chat message. Leave chat reply empty. ONLY use the tool.]",
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
    try {
      // Access the tunnel's internal syncTools via the same API call
      const { PokeTunnel } = await import("poke");
      const fetchWithAuth = (await import("poke")).PokeAuthError; // just to trigger import
      const token = (await import("poke")).getToken();
      const baseUrl = process.env.POKE_API ?? "https://poke.com/api/v1";
      const connId = this.tunnel.info?.connectionId;
      if (!connId) return;

      const res = await fetch(`${baseUrl}/mcp/connections/${connId}/sync-tools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token || this.apiKey}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        const toolCount = Array.isArray(data.tools) ? data.tools.length : 0;
        this.onEvent("tools-synced", toolCount);
      } else {
        this.onEvent("error", `Sync tools failed: HTTP ${res.status}`);
      }
    } catch (err) {
      this.onEvent("error", `Sync tools error: ${err.message}`);
    }
  }

  async stop() {
    if (this.tunnel) {
      try {
        await this.tunnel.stop();
      } catch {}
    }
  }
}
