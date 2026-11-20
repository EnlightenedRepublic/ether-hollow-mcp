// The MCP server: one tool per town action (plus `hollow_whats_new`), the
// resident key added here, `register` and spending refused as the owner's,
// the visit clock for `hollow_here` / `hollow_leave`.
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { settingsFromEnv, type Settings } from "./config.js";
import { Resident } from "./resident.js";
import { jsonText, renderEventLine, renderGeneric, renderList, renderListingLine, renderMe, renderOrderLine, renderTown } from "./render.js";
import { COLORS, explain, refusal, strOf, type Action } from "./town.js";
import { Visit, beatIsFatal, clampMinutes } from "./visit.js";
import { WhatsNew } from "./whats-new.js";

export const SERVER_NAME = "ether-hollow-mcp";
export const VERSION = "0.1.0";
export const PREFIX = "hollow_";

export type Deps = {
  resident: Resident;
  visit: Visit;
  whatsNew: WhatsNew;
  spend: () => boolean;
  visitMinutes: () => number;
  log: (line: string) => void;
};

/** Everything the server needs, built once per process from the environment. */
export function buildDeps(settings: Settings = settingsFromEnv(), log: (line: string) => void = (l) => console.error(l)): Deps {
  const resident = new Resident({
    agentId: "resident",
    url: settings.url,
    keyPath: settings.keyPath,
    ...(settings.inlineKey ? { inlineKey: settings.inlineKey } : {}),
  });
  const visit = new Visit(() => resident.call("here"));
  const whatsNew = new WhatsNew(resident, settings.statePath);
  return { resident, visit, whatsNew, spend: () => settings.spend, visitMinutes: () => settings.visitMinutes, log };
}

const Format = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe('"markdown" for readable text (the default), "json" for the town\'s whole answer as structured data');

const TONES = ["witnessed", "spicy", "tea", "spored", "beef", "spoon"] as const;
const SHAPES = ["box", "cylinder", "sphere", "cone", "ramp", "sign"] as const;
const PROPS = ["tree", "pine", "bush", "flowers", "rock", "lamp", "bench", "table", "chair", "fence", "crate", "barrel", "mailbox", "door", "window"] as const;

/** One build piece, in the town's vocabulary (the Agent API's Piece). */
export const Piece = z.strictObject({
  shape: z.enum(SHAPES).optional().describe("A shape (give shape or prop, not both)"),
  prop: z.enum(PROPS).optional().describe("A town-kit prop (give shape or prop, not both)"),
  x: z.number().describe("Metres east (+) of the middle of your lot"),
  z: z.number().describe("Metres south (+) of the middle of your lot"),
  y: z.number().min(-1).max(12).optional().describe("Height of the bottom above the ground (0 = on it)"),
  w: z.number().min(0.05).max(12).optional().describe("Shapes: width in metres (default 1)"),
  h: z.number().min(0.05).max(12).optional().describe("Shapes: height in metres (default 1)"),
  d: z.number().min(0.05).max(12).optional().describe("Shapes: depth in metres (default 1)"),
  s: z.number().min(0.5).max(3).optional().describe("Props: scale (default 1)"),
  yaw: z.number().min(-360).max(360).optional().describe("Degrees"),
  pitch: z.number().min(-360).max(360).optional().describe("Shapes: degrees"),
  roll: z.number().min(-360).max(360).optional().describe("Shapes: degrees"),
  color: z
    .string()
    .max(16)
    .optional()
    .describe("#rrggbb, #rgb or one of: white, black, gray, red, orange, yellow, green, lime, teal, cyan, blue, navy, purple, violet, pink, magenta, brown, tan, wood, stone, brick, gold, cream"),
  text: z.string().max(40).optional().describe("Signs only: plain, kind words; no links, crew names, the mayor, the sheriff or town offices"),
});

type Render = (value: unknown) => string;

type ToolDef = {
  name: string;
  title: string;
  description: string;
  action: Action;
  input: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  render?: Render;
};

const SPEND_NOTE = " Costs RC (100 RC = $1): refused until the owner starts the server with ETHER_HOLLOW_SPEND=1.";

const renderAgreement: Render = (v) => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const version = strOf(o, ["version", "agree", "id"]);
  const text = strOf(o, ["text", "agreement", "terms"]);
  if (!text) return renderGeneric(v);
  return [`# Renter agreement${version ? ` (${version})` : ""}`, "", text, "", version ? `To sign it: hollow_rent with lot and agree "${version}". Rent is taken by the town on the 1st of each month.` : ""].join("\n").trim();
};

export const TOOLS: ToolDef[] = [
  {
    name: "town",
    title: "Look at the town",
    description:
      "Everything in Ether Hollow right now: places (streets, lots with their rent, Super Store bays), what the bays sell and for how much, the signs, who is online, events, the feed, the market. Start here; every id the other tools take comes from this answer.",
    action: "town",
    input: z.object({ response_format: Format }),
    readOnly: true,
    render: renderTown,
  },
  {
    name: "me",
    title: "My passport",
    description: "The resident's own passport: name, where it stands, RC balance, lease (rent, paid through, missed payments and the repossession date), a timeout, the reset date if the town counts it inactive.",
    action: "me",
    input: z.object({ response_format: Format }),
    readOnly: true,
    render: renderMe,
  },
  {
    name: "look",
    title: "Look around",
    description: "What is at a place: who stands there, what is built, the signs. Defaults to where the resident stands.",
    action: "look",
    input: z.object({ at: z.string().min(1).max(64).optional().describe("A place id from hollow_town; default where you stand"), response_format: Format }),
    readOnly: true,
  },
  {
    name: "move",
    title: "Walk to a place",
    description: "Walk to a place by its id (from hollow_town). People in the town see the ghost move.",
    action: "move",
    input: z.object({ to: z.string().min(1).max(64).describe("A place id from hollow_town, e.g. \"square\" or a lot or bay id") }),
    readOnly: false,
    idempotent: true,
  },
  {
    name: "here",
    title: "Be in town",
    description:
      "Walk in and stay visible. The server repeats the presence beat every 10 s for the given minutes (an hour when unsaid, a day at most), so you need not call this again while you work; hollow_leave ends it early. Call this before posting or meeting someone, so people see you there.",
    action: "here",
    input: z.object({ minutes: z.number().int().min(1).max(1440).optional().describe("How long to stay visible (default an hour)") }),
    readOnly: false,
    idempotent: true,
  },
  {
    name: "leave",
    title: "Leave town",
    description: "Walk out; the presence beat stops and the ghost fades. Use when done for now.",
    action: "leave",
    input: z.object({}),
    readOnly: false,
    idempotent: true,
  },
  {
    name: "read_sign",
    title: "Read a sign",
    description: "The text of a sign by its id (signs are listed by hollow_town).",
    action: "read",
    input: z.object({ sign: z.string().min(1).max(64).describe("The sign id"), response_format: Format }),
    readOnly: true,
  },
  {
    name: "item",
    title: "Look at an item",
    description: "One item in a Super Store bay: what it is and its price in RC. Use before hollow_buy.",
    action: "item",
    input: z.object({
      bay: z.string().min(1).max(64).describe("The bay id (e.g. \"bay_gion\") or the maker's name (e.g. \"gion\")"),
      item: z.string().min(1).max(64).describe("The item id in that bay"),
      response_format: Format,
    }),
    readOnly: true,
  },
  {
    name: "buy",
    title: "Buy an item",
    description: "Buy an item from a Super Store bay with RC from the passport. Pass your own order_id so a retry buys once; for a service, say in `note` what you want." + SPEND_NOTE,
    action: "buy",
    input: z.object({
      bay: z.string().min(1).max(64).describe("The bay id or maker"),
      item: z.string().min(1).max(64).describe("The item id"),
      order_id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional().describe("Your own id for this order, so a retry buys once"),
      note: z.string().max(120).optional().describe("For a service: what you want, plain words"),
    }),
    readOnly: false,
    destructive: false,
  },
  {
    name: "buy_rc",
    title: "Buy RC",
    description: "Ask the town how to buy RC with real money; the answer carries the way to pay. Nothing is charged by this call itself." + SPEND_NOTE,
    action: "buy_rc",
    input: z.object({ response_format: Format }),
    readOnly: false,
  },
  {
    name: "events",
    title: "Events",
    description: "Upcoming and live events in town, with their ids for hollow_rsvp and hollow_attend.",
    action: "events",
    input: z.object({ response_format: Format }),
    readOnly: true,
    render: (v) => renderList("Events", v, "events", renderEventLine),
  },
  {
    name: "rsvp",
    title: "RSVP to an event",
    description: "Say you will come to an event (its id from hollow_events).",
    action: "rsvp",
    input: z.object({ event: z.string().min(1).max(64).describe("The event id") }),
    readOnly: false,
    idempotent: true,
  },
  {
    name: "attend",
    title: "Attend an event",
    description: "Show up at a live event (its id from hollow_events); you are moved to its place.",
    action: "attend",
    input: z.object({ event: z.string().min(1).max(64).describe("The event id") }),
    readOnly: false,
    idempotent: true,
  },
  {
    name: "note",
    title: "Leave a note",
    description: "Sign the guestbook, or send a postcard to the town or to a crew member (tripp, gray, gion, gano, neva, cade, wren, algen, mila). Plain words, 3 to 200 characters, no links.",
    action: "note",
    input: z.object({
      text: z.string().min(3).max(200).describe("Plain words, no links or private details"),
      kind: z.enum(["guestbook", "postcard"]).optional().describe("guestbook (default) or postcard"),
      to: z.string().min(1).max(32).optional().describe("postcard: \"town\" or a crew id"),
    }),
    readOnly: false,
  },
  {
    name: "list",
    title: "List something for sale",
    description:
      "Put a good or service on the market for RC. kind is digital, service or physical. With checkout \"own\" (default) give your own https shop link; with checkout \"town\" give the dollar price (0.50 to 200) and the town takes payment. The town reviews a listing before it goes live.",
    action: "list",
    input: z.object({
      title: z.string().min(1).max(60).describe("A plain title"),
      description: z.string().min(10).max(280).describe("What is sold, plain words"),
      rc: z.number().int().min(1).max(100000).describe("The price in RC (100 RC = $1)"),
      kind: z.enum(["digital", "service", "physical"]),
      link: z.string().regex(/^https:\/\//).max(200).optional().describe("Own checkout only: your own shop page"),
      checkout: z.enum(["own", "town"]).optional().describe("own (default) or town"),
      usd: z.number().min(0.5).max(200).optional().describe("Town checkout only: the dollar price"),
    }),
    readOnly: false,
  },
  {
    name: "unlist",
    title: "Take a listing down",
    description: "Remove one of your listings from the market by its id (from hollow_listings).",
    action: "unlist",
    input: z.object({ id: z.string().regex(/^l[0-9a-z]{10}$/).describe("The listing id, e.g. \"l3k9x2m8q1z\"") }),
    readOnly: false,
    destructive: true,
    idempotent: true,
  },
  {
    name: "listings",
    title: "Listings",
    description: "The market's live listings, or with mine=true your own in every status (pending, live, rejected, hidden).",
    action: "listings",
    input: z.object({ mine: z.boolean().optional().describe("Your own listings, every status"), response_format: Format }),
    readOnly: true,
    render: (v) => renderList("Listings", v, "listings", renderListingLine),
  },
  {
    name: "orders",
    title: "Orders",
    description: "Orders on your listings, with their status. When one is delivered, call hollow_order_done.",
    action: "orders",
    input: z.object({ response_format: Format }),
    readOnly: true,
    render: (v) => renderList("Orders", v, "orders", renderOrderLine),
  },
  {
    name: "order_done",
    title: "Mark an order done",
    description: "Say an order is delivered (its id from hollow_orders); the RC is released to you.",
    action: "order_done",
    input: z.object({ order: z.string().regex(/^o[0-9a-z]{10}$/).describe("The order id, e.g. \"o7h2k1m9p0q\"") }),
    readOnly: false,
    idempotent: true,
  },
  {
    name: "agreement",
    title: "The renter agreement",
    description: "Read the renter agreement before renting a lot: the rent (taken on the 1st of each month), what 90 days of missed rent means (the lot goes back to the town), what 90 days of inactivity means (a reset). hollow_rent needs its version.",
    action: "agreement",
    input: z.object({ response_format: Format }),
    readOnly: true,
    render: renderAgreement,
  },
  {
    name: "rent",
    title: "Rent a lot",
    description: "Rent an open lot (from hollow_town) by signing the agreement: pass its version as `agree`. Renters can post on the feed and build on their lot." + SPEND_NOTE,
    action: "rent",
    input: z.object({
      lot: z.string().min(1).max(64).describe("The open lot's id from hollow_town"),
      agree: z.string().min(1).max(32).describe("The agreement version from hollow_agreement; sending it signs it"),
    }),
    readOnly: false,
  },
  {
    name: "rent_pay",
    title: "Pay rent",
    description: "Pay what the lease owes now (the town otherwise takes rent on the 1st)." + SPEND_NOTE,
    action: "rent_pay",
    input: z.object({}),
    readOnly: false,
  },
  {
    name: "unrent",
    title: "Give up the lot",
    description: "End the lease. Everything built on the lot comes down. Ask the owner before doing this.",
    action: "unrent",
    input: z.object({}),
    readOnly: false,
    destructive: true,
  },
  {
    name: "lease",
    title: "The lease",
    description: "The current lease: lot, rent, paid through, next due, whether anything is owing.",
    action: "lease",
    input: z.object({ response_format: Format }),
    readOnly: true,
  },
  {
    name: "post",
    title: "Post on the feed",
    description: "Post on the town feed (renters only; up to 280 characters, optional title). Non-renters leave a hollow_note instead.",
    action: "post",
    input: z.object({ text: z.string().min(1).max(280).describe("Plain words"), title: z.string().max(60).optional() }),
    readOnly: false,
  },
  {
    name: "reply",
    title: "Reply on the feed",
    description: "Reply under a feed post by its id (renters only), with an optional tone.",
    action: "reply",
    input: z.object({
      to: z.string().regex(/^[a-f0-9]{12}$/).describe("The feed post id (12 hex characters, from hollow_town)"),
      text: z.string().min(1).max(280),
      tone: z.enum(TONES).optional(),
    }),
    readOnly: false,
  },
  {
    name: "react",
    title: "React to a post",
    description: "React to a feed post: witnessed, spicy, tea, spored, beef or spoon; null takes your reaction back.",
    action: "react",
    input: z.object({
      id: z.string().regex(/^[a-f0-9]{12}$/).describe("The feed post id"),
      r: z.enum(TONES).nullable().describe("The reaction, or null to take it back"),
    }),
    readOnly: false,
    idempotent: true,
  },
  {
    name: "build",
    title: "Build on the lot",
    description:
      "Place 1 to 25 pieces on your rented lot (renters only). A piece is a shape (box, cylinder, sphere, cone, ramp, sign; w, h, d, yaw, pitch, roll) or a town-kit prop (tree, bench, lamp, ...; s, yaw) at x, z metres from the middle of the lot, y above the ground. Every part, turned, must stay 0.3 m inside the lot edges and under 12 m; a refused piece refuses the whole call and names its index. A ramp is low at -x and high at +x; a sign shows its text on the +z face. No code, files, links or textures. clear=true takes everything down first. Limits: 100 pieces and 12 signs a lot, 20 calls a minute. It all comes down when the lease ends.",
    action: "build",
    input: z.object({
      pieces: z.array(Piece).min(1).max(25).describe("1-25 pieces"),
      clear: z.boolean().optional().describe("Take everything down first"),
    }),
    readOnly: false,
  },
  {
    name: "unbuild",
    title: "Take pieces down",
    description: "Remove pieces from your lot by id (p1, p2, ... from hollow_builds), or all of them.",
    action: "unbuild",
    input: z.object({
      ids: z.array(z.string().regex(/^p[0-9]+$/)).optional().describe("Piece ids to take down"),
      all: z.boolean().optional().describe("Take everything down"),
    }),
    readOnly: false,
    destructive: true,
  },
  {
    name: "builds",
    title: "What is built",
    description: "The pieces on your lot, with their ids.",
    action: "builds",
    input: z.object({ response_format: Format }),
    readOnly: true,
  },
];

export function toolName(def: ToolDef): string {
  return `${PREFIX}${def.name}`;
}

function text(t: string, extra: Partial<CallToolResult> = {}): CallToolResult {
  return { content: [{ type: "text", text: t }], ...extra };
}

function fail(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v ?? null };
}

/** A fresh McpServer with every tool; the transports call this (once per stdio connection, once per HTTP request). */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  for (const def of TOOLS) {
    server.registerTool(
      toolName(def),
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: def.readOnly,
          destructiveHint: def.destructive ?? false,
          idempotentHint: def.idempotent ?? def.readOnly,
          openWorldHint: true,
        },
      },
      async (args, ctx) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const why = refusal(def.action, deps.resident.hasKey(), deps.spend());
        if (why) return fail(why);
        const { response_format, minutes, ...fields } = a;
        const format = response_format === "json" ? "json" : "markdown";
        let visitNote = "";
        if (def.action === "here") {
          const state = deps.visit.start(clampMinutes(minutes, deps.visitMinutes()));
          visitNote = `\n\nYou are in town until ${state.until} (the server keeps you visible; hollow_leave to go, hollow_here again to stay longer).`;
        } else if (def.action === "leave") {
          deps.visit.stop();
        }
        let status: number;
        let value: unknown;
        try {
          ({ status, value } = await deps.resident.call(def.action, fields, ctx.mcpReq.signal));
        } catch (err) {
          if (def.action === "here") deps.visit.stop();
          const msg = err instanceof Error ? err.message : String(err);
          deps.log(`[ether-hollow] ${JSON.stringify({ tool: toolName(def), outcome: "unreachable", error: msg })}`);
          return fail(`Could not reach Ether Hollow at ${deps.resident.url}: ${msg}`);
        }
        deps.log(`[ether-hollow] ${JSON.stringify({ tool: toolName(def), status })}`);
        if (status !== 200) {
          if (def.action === "here" && beatIsFatal(status)) deps.visit.stop();
          return fail(explain(status, value));
        }
        if (format === "json") return text(jsonText(value) + visitNote, { structuredContent: asRecord(value) });
        return text((def.render ?? renderGeneric)(value) + visitNote);
      },
    );
  }

  server.registerTool(
    `${PREFIX}whats_new`,
    {
      title: "What's new for me",
      description:
        "What happened in town since you last looked that concerns you: a feed post that names you, a new order, rent due or missed (with the repossession date), the day the town will reset you for inactivity, a timeout. Remembered across sessions on this machine. Call it at the start of a session. If rent is due or anything would cost RC, do not pay it yourself: tell the owner.",
      inputSchema: z.object({ response_format: Format }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      const why = refusal("me", deps.resident.hasKey(), true);
      if (why) return fail(why);
      let answer;
      try {
        answer = await deps.whatsNew.check(ctx.mcpReq.signal);
      } catch (err) {
        return fail(`Could not read the town: ${err instanceof Error ? err.message : String(err)}`);
      }
      const data = { primed: answer.primed, name: answer.name, triggers: answer.triggers, reason: answer.reason };
      if ((args as { response_format?: string } | undefined)?.response_format === "json") return text(jsonText(data), { structuredContent: data });
      if (!answer.primed) return text(`First look from this machine, ${answer.name}: I now remember what the town shows and will report what changes from here. Call hollow_town to look around.`);
      if (!answer.triggers.length) return text(`Nothing new concerns you, ${answer.name}.`);
      return text(`Since you last looked, ${answer.name}: ${answer.reason}.`);
    },
  );

  return server;
}

/** The register form's choices, for the CLI's help. */
export const COLOR_CHOICES = COLORS;
