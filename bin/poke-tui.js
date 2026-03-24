#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const PUI_CONFIG = join(CONFIG_DIR, "poke-tui", "config.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(PUI_CONFIG, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  mkdirSync(join(CONFIG_DIR, "poke-tui"), { recursive: true });
  writeFileSync(PUI_CONFIG, JSON.stringify(config, null, 2));
}

function loadPokeCredentials() {
  try {
    const creds = JSON.parse(readFileSync(join(CONFIG_DIR, "poke", "credentials.json"), "utf-8"));
    if (creds.token) return creds.token;
  } catch {}
  return null;
}

function resolveToken() {
  if (process.env.POKE_API_KEY) return process.env.POKE_API_KEY;
  const config = loadConfig();
  if (config.apiKey) return config.apiKey;
  const pokeCreds = loadPokeCredentials();
  if (pokeCreds) return pokeCreds;
  return null;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function onboarding() {
  console.log();
  console.log("  🌴 Welcome to Poke TUI");
  console.log();
  console.log("  To get started, either:");
  console.log();
  console.log("  Option 1: Run 'npx poke login' (recommended)");
  console.log("  Option 2: Paste an API key from https://poke.com/kitchen/api-keys");
  console.log();

  const key = await ask("  API key (or press Enter if you ran poke login): ");

  if (!key) {
    const pokeCreds = loadPokeCredentials();
    if (pokeCreds) {
      console.log();
      console.log("  Found poke login credentials! Starting...");
      console.log();
      return pokeCreds;
    }
    console.log();
    console.log("  No credentials found. Run: npx poke login");
    console.log();
    process.exit(1);
  }

  saveConfig({ apiKey: key });

  console.log();
  console.log("  Saved! Starting Poke TUI...");
  console.log();

  return key;
}

async function main() {
  let token = resolveToken();

  if (!token) {
    token = await onboarding();
  }

  process.env.POKE_API_KEY = token;

  await import("../src/app.js");
}

main();
