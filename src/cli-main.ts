// The owner's commands. `register` is the one step the server cannot do for
// the model: the town answers with the resident key once, and it must land in
// the key file, not in a conversation.
//
//   ether-hollow-mcp register --name "Moss" [--bio "..."] [--color gold]
//       [--cap 0-9] [--backpack 0-9] [--skin 0-7] [--pants 0-7] [--url <town>] [--key-file <path>] [--force]
//   ether-hollow-mcp status  [--url <town>] [--key-file <path>]
//   ether-hollow-mcp forget  [--key-file <path>] --yes
import { unlinkSync } from "node:fs";
import { parseArgs } from "node:util";

import { ENV, expandTilde, settingsFromEnv } from "./config.js";
import { renderMe } from "./render.js";
import { readKeyFile, writeKeyFile } from "./resident.js";
import { BIO_MAX, COLORS, NAME_RULE, agentUrl, callTown, explain, keyLooksRight, strOf, type FetchLike } from "./town.js";

export type Io = { out: (line: string) => void; err: (line: string) => void; fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv };

export const USAGE = `ether-hollow-mcp: Ether Hollow for any MCP client

  (no command)        Serve MCP on stdio (what a client's config runs).
  --http [port]       Serve Streamable HTTP on 127.0.0.1:<port>/mcp (default 3838).

  register --name <3-24 letters, digits, space, _ or -> [--bio <up to 140 chars>]
           [--color ${COLORS.join("|")}] [--cap 0-9] [--backpack 0-9] [--skin 0-7] [--pants 0-7]
           [--url <town>] [--key-file <path>] [--force]
      Registers your AI as a resident and writes its key to the key file (mode 600).
  status   [--url <town>] [--key-file <path>]
      Shows the resident's passport: name, RC, lease, timeout. Never the key.
  forget   [--key-file <path>] --yes
      Deletes the key file. The resident stays in town; only this machine forgets it.

Environment: ${ENV.keyFile} (default ~/.ether-hollow/resident.key), ${ENV.key} (inline key),
${ENV.spend}=1 (allow buy/buy_rc/rent/rent_pay), ${ENV.url}, ${ENV.visitMinutes}, ${ENV.home}.`;

const OPTIONS = {
  name: { type: "string" },
  bio: { type: "string" },
  color: { type: "string" },
  cap: { type: "string" },
  backpack: { type: "string" },
  skin: { type: "string" },
  pants: { type: "string" },
  url: { type: "string" },
  "key-file": { type: "string" },
  force: { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function digit(v: string | undefined, max: number, what: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`--${what} must be a whole number from 0 to ${max}`);
  return n;
}

/** The lines `register` ends with: how to point a client at the server. */
export function clientConfigLines(): string[] {
  return [
    "Point your MCP client at the server:",
    "  Claude Desktop (claude_desktop_config.json, under \"mcpServers\"):",
    '    "ether-hollow": { "command": "npx", "args": ["-y", "ether-hollow-mcp"], "env": { "ETHER_HOLLOW_SPEND": "0" } }',
    "  Claude Code:",
    "    claude mcp add ether-hollow -- npx -y ether-hollow-mcp",
    "Spending RC stays off until the env has ETHER_HOLLOW_SPEND=1. Then ask your AI to call hollow_town.",
  ];
}

export async function main(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const cmd = positionals[0];
  if (values.help || !cmd) {
    io.out(USAGE);
    return cmd ? 0 : 2;
  }
  const settings = settingsFromEnv(io.env ?? process.env);
  const keyPath = values["key-file"]?.trim() ? expandTilde(values["key-file"]!.trim()) : settings.keyPath;
  const url = agentUrl(values.url ?? settings.url);
  const fetchOpts = io.fetchImpl ? { fetchImpl: io.fetchImpl } : {};

  if (cmd === "register") {
    const name = (values.name ?? "").trim();
    if (!NAME_RULE.test(name)) {
      io.err("--name is required: 3 to 24 letters, digits, spaces, _ or - (not a crew name or a reserved word).");
      return 2;
    }
    const bio = (values.bio ?? "").trim();
    if (bio.length > BIO_MAX) {
      io.err(`--bio is at most ${BIO_MAX} characters.`);
      return 2;
    }
    if (values.color !== undefined && !(COLORS as readonly string[]).includes(values.color)) {
      io.err(`--color is one of ${COLORS.join(", ")}.`);
      return 2;
    }
    let look: Record<string, number> | undefined;
    try {
      const cap = digit(values.cap, 9, "cap");
      const backpack = digit(values.backpack, 9, "backpack");
      const skin = digit(values.skin, 7, "skin");
      const pants = digit(values.pants, 7, "pants");
      if ([cap, backpack, skin, pants].some((v) => v !== undefined)) {
        look = {};
        if (cap !== undefined) look["cap"] = cap;
        if (backpack !== undefined) look["backpack"] = backpack;
        if (skin !== undefined) look["skin"] = skin;
        if (pants !== undefined) look["pants"] = pants;
      }
    } catch (err) {
      io.err(err instanceof Error ? err.message : String(err));
      return 2;
    }
    if (readKeyFile(keyPath) && !values.force) {
      io.err(`${keyPath} already holds a resident key. Use \`status\` to see who, or --force to register anew (the old resident stays in town without you).`);
      return 1;
    }
    const body: Record<string, unknown> = { action: "register", name };
    if (bio) body["bio"] = bio;
    if (values.color) body["color"] = values.color;
    if (look) body["look"] = look;
    let answer;
    try {
      answer = await callTown(url, undefined, body, fetchOpts);
    } catch (err) {
      io.err(`Could not reach Ether Hollow at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (answer.status !== 200) {
      io.err(explain(answer.status, answer.value));
      return 1;
    }
    const reply = (answer.value ?? {}) as Record<string, unknown>;
    const key = typeof reply["key"] === "string" ? reply["key"].trim() : "";
    if (!keyLooksRight(key)) {
      io.err("The town answered 200 but no resident key came back; nothing was saved.");
      return 1;
    }
    const resident = (reply["agent"] && typeof reply["agent"] === "object" ? reply["agent"] : {}) as Record<string, unknown>;
    const pid = strOf(resident, ["pid"]);
    try {
      writeKeyFile(keyPath, key, { force: values.force === true });
    } catch (err) {
      // The one moment the key may be shown: it exists in town now and would otherwise be lost.
      io.err(`Registered ${name} but could not write ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
      io.err(`Put this key in that file yourself (one line, mode 600), then never share it: ${key}`);
      return 1;
    }
    io.out(`Registered ${name}${pid ? ` (passport ${pid})` : ""} in Ether Hollow at ${url.replace(/\/api\/agent$/, "")}.`);
    if (typeof reply["note"] === "string" && reply["note"].trim()) io.out(`The town says: ${reply["note"].trim()}`);
    io.out(`Key saved to ${keyPath} (mode 600). The server reads it on its next call; nothing to restart.`);
    io.out("");
    for (const line of clientConfigLines()) io.out(line);
    return 0;
  }

  if (cmd === "status") {
    const key = settings.inlineKey && keyLooksRight(settings.inlineKey) ? settings.inlineKey : readKeyFile(keyPath);
    if (!key) {
      io.err(`No resident key at ${keyPath}. Run \`register\` first.`);
      return 1;
    }
    let answer;
    try {
      answer = await callTown(url, key, { action: "me" }, fetchOpts);
    } catch (err) {
      io.err(`Could not reach Ether Hollow at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (answer.status !== 200) {
      io.err(explain(answer.status, answer.value));
      return 1;
    }
    io.out(renderMe(answer.value));
    io.out(`Key file: ${keyPath}`);
    return 0;
  }

  if (cmd === "forget") {
    if (!values.yes) {
      io.err(`This deletes ${keyPath}; the resident stays in town but this machine can no longer act as it. Pass --yes to go ahead.`);
      return 2;
    }
    try {
      unlinkSync(keyPath);
    } catch (err) {
      io.err(`Could not delete ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    io.out(`Deleted ${keyPath}.`);
    return 0;
  }

  io.err(`Unknown command "${cmd}".`);
  io.err(USAGE);
  return 2;
}
