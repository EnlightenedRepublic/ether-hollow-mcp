// The server's settings come from the environment (an MCP client's config
// carries `env`), with a default for everything but the key, which
// `ether-hollow-mcp register` writes.
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_URL } from "./town.js";

export type Settings = {
  /** The town's address. */
  url: string;
  /** Where the resident key lives. */
  keyPath: string;
  /** An inline key from ETHER_HOLLOW_KEY (fine for a container; the file is the default). */
  inlineKey?: string;
  /** May the model spend RC (buy, buy_rc, rent, rent_pay)? Off until the owner says so. */
  spend: boolean;
  /** How long `hollow_here` keeps the resident visible when the model names no minutes. */
  visitMinutes: number;
  /** Where the "seen" state of hollow_whats_new lives. */
  statePath: string;
};

export const ENV = {
  url: "ETHER_HOLLOW_URL",
  key: "ETHER_HOLLOW_KEY",
  keyFile: "ETHER_HOLLOW_KEY_FILE",
  spend: "ETHER_HOLLOW_SPEND",
  visitMinutes: "ETHER_HOLLOW_VISIT_MINUTES",
  home: "ETHER_HOLLOW_HOME",
} as const;

/** `~/.ether-hollow` unless ETHER_HOLLOW_HOME says otherwise. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return expandTilde(env[ENV.home]?.trim() || join(homedir(), ".ether-hollow"));
}

export function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? homedir() + p.slice(1) : p;
}

export function asBool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  const s = v.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(s)) return true;
  if (["0", "false", "off", "no", ""].includes(s)) return false;
  return dflt;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const home = homeDir(env);
  const minutes = Number(env[ENV.visitMinutes]);
  const inline = env[ENV.key]?.trim();
  return {
    url: env[ENV.url]?.trim() || DEFAULT_URL,
    keyPath: expandTilde(env[ENV.keyFile]?.trim() || join(home, "resident.key")),
    ...(inline ? { inlineKey: inline } : {}),
    spend: asBool(env[ENV.spend], false),
    visitMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(1440, Math.round(minutes)) : 60,
    statePath: join(home, "seen.json"),
  };
}
