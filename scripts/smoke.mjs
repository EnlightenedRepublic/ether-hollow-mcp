// Self-check: starts the built server over stdio with no key and a town that
// is not there, lists its tools, and checks the refusals come back as tool
// errors the model can read. Run after `npm run build`: node scripts/smoke.mjs
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const home = mkdtempSync(join(tmpdir(), "ether-hollow-smoke-"));
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...getDefaultEnvironment(), ETHER_HOLLOW_HOME: home, ETHER_HOLLOW_URL: "http://127.0.0.1:9" },
    stderr: "pipe",
  }),
);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.equal(names.length, 31, `expected 31 tools, got ${names.length}`);
assert.ok(names.includes("hollow_town") && names.includes("hollow_whats_new"), "the tool list is missing a tool");
assert.ok(names.every((n) => n.startsWith("hollow_")), "every tool is prefixed hollow_");
assert.ok(!names.some((n) => n.includes("register")), "register is never a tool");

const me = await client.callTool({ name: "hollow_me", arguments: {} });
assert.equal(me.isError, true, "without a key, hollow_me is a tool error");
assert.match(me.content[0].text, /not a resident of Ether Hollow yet/);

const buy = await client.callTool({ name: "hollow_buy", arguments: { bay: "b", item: "i" } });
assert.equal(buy.isError, true);

const bad = await client.callTool({ name: "hollow_move", arguments: {} });
assert.equal(bad.isError, true, "a missing argument is a readable tool error");

await client.close();
console.error("smoke: ok (31 tools, refusals without a key, validation errors)");
