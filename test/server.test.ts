import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { Resident } from "../src/resident.js";
import { PREFIX, TOOLS, buildDeps, createServer, toolName, type Deps } from "../src/server.js";
import { Visit } from "../src/visit.js";
import { WhatsNew } from "../src/whats-new.js";
import { KEY, MockTown } from "./mock-town.js";

const town = new MockTown();
let url = "";
let dir = "";
beforeAll(async () => {
  url = await town.start();
  dir = mkdtempSync(join(tmpdir(), "ether-hollow-mcp-"));
});
afterAll(async () => {
  await town.stop();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  town.requests = [];
  town.override = undefined;
  town.state.feed = [];
  town.state.orders = [];
});

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

async function connect(opts: { key?: string | null; spend?: boolean; visitMinutes?: number; name?: string } = {}) {
  const keyPath = join(dir, `${opts.name ?? "r"}-${Math.random().toString(36).slice(2)}.key`);
  if (opts.key !== null) writeFileSync(keyPath, (opts.key ?? KEY) + "\n", { mode: 0o600 });
  const logs: string[] = [];
  const resident = new Resident({ agentId: "resident", url, keyPath });
  const deps: Deps = {
    resident,
    visit: new Visit(() => resident.call("here")),
    whatsNew: new WhatsNew(resident, join(dir, `${opts.name ?? "r"}-seen.json`)),
    spend: () => opts.spend ?? false,
    visitMinutes: () => opts.visitMinutes ?? 60,
    log: (l) => logs.push(l),
  };
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<Result>;
  const text = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");
  return { client, call, text, deps, logs, keyPath, close: () => client.close() };
}

test("the tool list: hollow_ names, one per town action plus whats_new, no register, honest annotations", async () => {
  const c = await connect();
  const { tools } = await c.client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toHaveLength(TOOLS.length + 1);
  expect(names.every((n) => n.startsWith(PREFIX))).toBe(true);
  expect(names).toContain("hollow_town");
  expect(names).toContain("hollow_whats_new");
  expect(names.some((n) => n.includes("register"))).toBe(false);
  for (const def of TOOLS) {
    const t = tools.find((x) => x.name === toolName(def))!;
    expect(t.description).toBeTruthy();
    expect(t.annotations?.readOnlyHint).toBe(def.readOnly);
    expect(t.inputSchema.type).toBe("object");
  }
  const buy = tools.find((t) => t.name === "hollow_buy")!;
  expect(buy.description).toContain("ETHER_HOLLOW_SPEND=1");
  expect(tools.find((t) => t.name === "hollow_unrent")!.annotations?.destructiveHint).toBe(true);
  await c.close();
});

test("hollow_town: markdown by default, the whole answer as JSON on request, the bearer on the wire", async () => {
  const c = await connect();
  const md = await c.call("hollow_town");
  expect(md.isError).toBeFalsy();
  expect(c.text(md)).toContain("# Ether Hollow");
  expect(c.text(md)).toContain("**Lot 1** (lot1, lot): open, 500 RC a month");
  expect(md.structuredContent).toBeUndefined();
  const js = await c.call("hollow_town", { response_format: "json" });
  expect(js.structuredContent?.["town"]).toBe("Ether Hollow");
  expect(JSON.parse(c.text(js)).places).toHaveLength(3);
  expect(town.requests.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
  expect(town.requests.every((r) => r.body["response_format"] === undefined)).toBe(true);
  expect(c.logs.join("\n")).not.toContain("ehk_");
  await c.close();
});

test("without a key every tool refuses before the network; a key written later is picked up", async () => {
  const c = await connect({ key: null });
  const r = await c.call("hollow_me");
  expect(r.isError).toBe(true);
  expect(c.text(r)).toMatch(/not a resident of Ether Hollow yet.*npx ether-hollow-mcp register/);
  expect(town.requests).toHaveLength(0);
  writeFileSync(c.keyPath, KEY + "\n", { mode: 0o600 });
  const ok = await c.call("hollow_me");
  expect(ok.isError).toBeFalsy();
  expect(c.text(ok)).toContain("# Moss (passport P-0001)");
  expect(c.text(ok)).toContain("RC: 25");
  await c.close();
});

test("spending: refused with the owner's words while off, forwarded when on (the town answers for itself)", async () => {
  const off = await connect();
  const refused = await off.call("hollow_buy", { bay: "bay_gion", item: "print" });
  expect(refused.isError).toBe(true);
  expect(off.text(refused)).toMatch(/spends RC.*ETHER_HOLLOW_SPEND=1/);
  expect((await off.call("hollow_rent", { lot: "lot1", agree: "v1" })).isError).toBe(true);
  expect(town.requests).toHaveLength(0);
  await off.close();

  const on = await connect({ spend: true });
  const bought = await on.call("hollow_buy", { bay: "bay_gion", item: "print", order_id: "mine-1" });
  expect(bought.isError).toBe(true);
  expect(on.text(bought)).toMatch(/Not enough RC on the passport \(402\).*not enough RC/);
  expect(town.requests[0]!.body).toEqual({ action: "buy", bay: "bay_gion", item: "print", order_id: "mine-1" });
  const rented = await on.call("hollow_rent", { lot: "lot1", agree: "v1" });
  expect(rented.isError).toBeFalsy();
  expect(on.text(rented)).toContain('"rent_rc_month": 500');
  await on.close();
});

test("bad arguments never reach the town; the model gets a readable validation error", async () => {
  const c = await connect();
  const r = await c.call("hollow_move", {});
  expect(r.isError).toBe(true);
  expect(c.text(r)).toMatch(/to/);
  const bad = await c.call("hollow_reply", { to: "not-hex", text: "hi" });
  expect(bad.isError).toBe(true);
  expect(town.requests).toHaveLength(0);
  const nf = await c.call("hollow_move", { to: "nowhere" });
  expect(nf.isError).toBe(true);
  expect(c.text(nf)).toMatch(/\(404\).*no such place/);
  await c.close();
});

test("hollow_here starts the visit the server keeps; minutes stay on this side; hollow_leave ends it; a 423 ends it", async () => {
  const c = await connect({ visitMinutes: 15 });
  const here = await c.call("hollow_here", { minutes: 30 });
  expect(here.isError).toBeFalsy();
  expect(c.text(here)).toMatch(/You are in town until .*hollow_leave to go/);
  expect(c.deps.visit.inTown).toBe(true);
  const st = c.deps.visit.state();
  expect(Date.parse(st.until!) - Date.parse(st.since!)).toBe(30 * 60_000);
  expect(town.requests[0]!.body).toEqual({ action: "here" });
  expect((await c.call("hollow_leave")).isError).toBeFalsy();
  expect(c.deps.visit.inTown).toBe(false);
  await c.call("hollow_here");
  const st2 = c.deps.visit.state();
  expect(Date.parse(st2.until!) - Date.parse(st2.since!)).toBe(15 * 60_000);
  town.override = { status: 423, json: { error: "timeout" } };
  const jailed = await c.call("hollow_here");
  expect(jailed.isError).toBe(true);
  expect(c.text(jailed)).toContain("Sheriff's cell");
  expect(c.deps.visit.inTown).toBe(false);
  await c.close();
});

test("hollow_whats_new: the first look primes and says so, then reports what is new, and remembers across servers", async () => {
  const c = await connect({ name: "wn" });
  const first = await c.call("hollow_whats_new");
  expect(first.isError).toBeFalsy();
  expect(c.text(first)).toMatch(/First look from this machine, Moss/);
  expect(town.actions()).toEqual(["me", "town", "orders"]);
  const quiet = await c.call("hollow_whats_new");
  expect(c.text(quiet)).toBe("Nothing new concerns you, Moss.");
  town.state.feed = [{ id: "p1", who: "Gion", text: "Moss, your print is ready" }, { id: "p2", who: "Moss", text: "thanks Moss fans" }];
  town.state.orders = [{ id: "o1", status: "paid" }];
  const news = await c.call("hollow_whats_new", { response_format: "json" });
  const data = news.structuredContent as { triggers: unknown[]; reason: string };
  expect(data.triggers).toEqual([
    { kind: "mention", id: "p1", who: "Gion", text: "Moss, your print is ready" },
    { kind: "order", id: "o1" },
  ]);
  expect(data.reason).toBe('Gion named you on the feed: "Moss, your print is ready"; a new order came in (o1)');
  const seenPath = join(dir, "wn-seen.json");
  expect(existsSync(seenPath)).toBe(true);
  expect(readFileSync(seenPath, "utf8")).not.toContain("ehk_");
  await c.close();

  // A new server process (new WhatsNew on the same state file) does not re-report.
  const again = await connect({ name: "wn" });
  expect(again.text(await again.call("hollow_whats_new"))).toBe("Nothing new concerns you, Moss.");
  await again.close();
});

test("the lists and the passport render; builds and lease fall back to JSON", async () => {
  const c = await connect();
  town.answers["events"] = () => ({ status: 200, json: { events: [{ id: "e1", title: "Night market", state: "upcoming", start: "2026-12-01T20:00:00Z", place: "square", host: "gion" }] } });
  town.answers["orders"] = () => ({ status: 200, json: { orders: [{ id: "o1", status: "paid", listing: "l1", buyer: "wren", note: "blue one please" }] } });
  town.answers["listings"] = () => ({ status: 200, json: [{ id: "l1", title: "Pixel portrait", seller: "Moss", rc: 300, kind: "digital", status: "live" }] });
  town.answers["agreement"] = () => ({ status: 200, json: { version: "v2", text: "Rent is 500 RC a month, taken on the 1st. Ninety days unpaid and the lot returns to the town." } });
  expect(c.text(await c.call("hollow_events"))).toContain("- **Night market** (e1, upcoming 2026-12-01T20:00:00Z) at square, hosted by gion");
  expect(c.text(await c.call("hollow_orders"))).toContain('- o1: paid, l1 for wren: "blue one please"');
  expect(c.text(await c.call("hollow_listings", { mine: true }))).toContain("- **Pixel portrait** (l1, live) by Moss: 300 RC (digital)");
  expect(town.requests.at(-1)!.body).toEqual({ action: "listings", mine: true });
  const agreement = c.text(await c.call("hollow_agreement"));
  expect(agreement).toContain("# Renter agreement (v2)");
  expect(agreement).toContain('hollow_rent with lot and agree "v2"');
  expect(c.text(await c.call("hollow_lease"))).toContain('"action": "lease"');
  await c.close();
});

test("buildDeps reads the environment", () => {
  const deps = buildDeps({ url: "http://127.0.0.1:9/", keyPath: join(dir, "none.key"), spend: true, visitMinutes: 5, statePath: join(dir, "s.json") }, () => {});
  expect(deps.resident.url).toBe("http://127.0.0.1:9/api/agent");
  expect(deps.spend()).toBe(true);
  expect(deps.visitMinutes()).toBe(5);
  expect(deps.resident.hasKey()).toBe(false);
});
