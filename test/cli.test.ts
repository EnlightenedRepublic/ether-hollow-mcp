import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { main } from "../src/cli-main.js";
import { KEY, MockTown } from "./mock-town.js";

const town = new MockTown();
let url = "";
let dir = "";
beforeAll(async () => {
  url = await town.start();
  dir = mkdtempSync(join(tmpdir(), "ether-hollow-mcp-cli-"));
});
afterAll(async () => {
  await town.stop();
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return main(args, { out: (l) => out.push(l), err: (l) => err.push(l), env }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

test("register: the key lands in the file (mode 600), never on the screen; the client config is printed", async () => {
  const keyFile = join(dir, "resident.key");
  const r = await run(["register", "--name", "Moss", "--bio", "a quiet robot", "--color", "gold", "--cap", "3", "--url", url, "--key-file", keyFile]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Registered Moss (passport P-0001)");
  expect(r.out).toContain(`Key saved to ${keyFile} (mode 600)`);
  expect(r.out).toContain('"ether-hollow": { "command": "npx", "args": ["-y", "ether-hollow-mcp"]');
  expect(r.out).toContain("claude mcp add ether-hollow -- npx -y ether-hollow-mcp");
  expect(r.out + r.err).not.toContain("ehk_");
  expect(readFileSync(keyFile, "utf8").trim()).toBe(KEY);
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  expect(town.requests[0]!.body).toEqual({ action: "register", name: "Moss", bio: "a quiet robot", color: "gold", look: { cap: 3 } });
  expect(town.requests[0]!.auth).toBeUndefined();

  const again = await run(["register", "--name", "Moss2", "--url", url, "--key-file", keyFile]);
  expect(again.code).toBe(1);
  expect(again.err).toContain("already holds a resident key");
  expect(town.requests).toHaveLength(1);
});

test("register: the environment names the town and the key file when the flags do not", async () => {
  const home = join(dir, "home");
  const r = await run(["register", "--name", "Fern"], { ETHER_HOLLOW_URL: url, ETHER_HOLLOW_HOME: home });
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, "resident.key"), "utf8").trim()).toBe(KEY);
  const s = await run(["status"], { ETHER_HOLLOW_URL: url, ETHER_HOLLOW_HOME: home });
  expect(s.code).toBe(0);
  expect(s.out).toContain("# Moss (passport P-0001)");
  expect(s.out).toContain(`Key file: ${join(home, "resident.key")}`);
});

test("register: bad names, bad looks, the town's refusals", async () => {
  const keyFile = join(dir, "x.key");
  expect((await run(["register", "--url", url, "--key-file", keyFile])).code).toBe(2);
  expect((await run(["register", "--name", "a", "--url", url, "--key-file", keyFile])).code).toBe(2);
  expect((await run(["register", "--name", "Moss", "--cap", "12", "--url", url, "--key-file", keyFile])).code).toBe(2);
  expect((await run(["register", "--name", "Moss", "--color", "plaid", "--url", url, "--key-file", keyFile])).code).toBe(2);
  const taken = await run(["register", "--name", "taken", "--url", url, "--key-file", keyFile]);
  expect(taken.code).toBe(1);
  expect(taken.err).toMatch(/already exists or conflicts \(409\).*that name is taken/);
  expect(existsSync(keyFile)).toBe(false);
});

test("status: the passport without the key; forget needs --yes", async () => {
  const keyFile = join(dir, "resident.key");
  const s = await run(["status", "--url", url, "--key-file", keyFile]);
  expect(s.code).toBe(0);
  expect(s.out).toContain("# Moss (passport P-0001)");
  expect(s.out).toContain("Standing at square.");
  expect(s.out).toContain("RC: 25 (100 RC = $1)");
  expect(s.out).toContain("Lease: none");
  expect(s.out).not.toContain("ehk_");

  const missing = await run(["status", "--url", url, "--key-file", join(dir, "ghost.key")]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("No resident key");

  expect((await run(["forget", "--key-file", keyFile])).code).toBe(2);
  expect(existsSync(keyFile)).toBe(true);
  expect((await run(["forget", "--key-file", keyFile, "--yes"])).code).toBe(0);
  expect(existsSync(keyFile)).toBe(false);
});

test("usage: no command or --help", async () => {
  expect((await run([])).code).toBe(2);
  const h = await run(["--help"]);
  expect(h.out).toContain("register --name");
  expect(h.out).toContain("ETHER_HOLLOW_SPEND=1");
  expect((await run(["dance"])).code).toBe(2);
});
