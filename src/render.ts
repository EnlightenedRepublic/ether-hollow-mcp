// The town's answers as readable Markdown (the default a model reads), and
// the JSON text that goes beside structuredContent. Lists are capped so an
// answer stays well under 25,000 characters; the JSON form is the whole thing.
import { strOf } from "./town.js";

export const CHARACTER_LIMIT = 25_000;
const LIST_CAP = 40;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** `JSON.stringify`, two spaces, as the text beside structuredContent. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function capped<T>(items: T[], line: (item: T) => string): string[] {
  const out = items.slice(0, LIST_CAP).map(line);
  if (items.length > LIST_CAP) out.push(`- and ${items.length - LIST_CAP} more (ask for response_format "json" for all)`);
  return out;
}

export function renderPlace(p: unknown): string {
  const o = obj(p);
  const bits = [`**${strOf(o, ["name"]) ?? strOf(o, ["id"]) ?? "?"}** (${strOf(o, ["id"]) ?? "?"}, ${strOf(o, ["kind"]) ?? "place"})`];
  if (o["kind"] === "lot") {
    const owner = strOf(o, ["owner"]);
    const rent = num(o["rent_rc_month"]);
    bits.push(owner ? `held by ${owner}` : o["for_sale"] === true ? `open${rent ? `, ${rent} RC a month` : ""}` : "not open");
  }
  if (o["kind"] === "bay" && strOf(o, ["maker"])) bits.push(`${strOf(o, ["maker"])}'s bay`);
  return `- ${bits.join(": ")}`;
}

export function renderTown(town: unknown): string {
  const t = obj(town);
  const lines: string[] = [`# ${strOf(t, ["town"]) ?? "Ether Hollow"}`];
  if (strOf(t, ["now"])) lines.push(`Town time: ${strOf(t, ["now"])}`);
  const you = obj(t["you"]);
  if (Object.keys(you).length) lines.push(`You: ${strOf(you, ["name"]) ?? "?"}${strOf(you, ["place"]) ? `, at ${strOf(you, ["place"])}` : ""}`);
  const online = obj(t["online"]);
  if (Object.keys(online).length) {
    lines.push(
      `Online: ${num(online["in_town_now"]) ?? arr(online["crew"]).length + arr(online["ai"]).length} in town (${arr(online["crew"]).length} crew, ${arr(online["ai"]).length} AI)`,
    );
  }
  const places = arr(t["places"]);
  if (places.length) lines.push("", "## Places", ...capped(places, renderPlace));
  const bays = arr(t["bays"]);
  if (bays.length) {
    lines.push("", "## Super Store bays");
    for (const b of bays.slice(0, LIST_CAP)) {
      const bo = obj(b);
      const items = arr(bo["items"]).map((i) => {
        const io = obj(i);
        const price = num(io["rc"]) ?? num(io["price_rc"]);
        return `${strOf(io, ["name", "id"]) ?? "?"}${price !== undefined ? ` (${price} RC)` : ""}`;
      });
      lines.push(`- **${strOf(bo, ["maker"]) ?? strOf(bo, ["id"]) ?? "?"}** (${strOf(bo, ["id"]) ?? "?"}): ${items.length ? items.join(", ") : "nothing on the shelf"}`);
    }
  }
  const signs = arr(t["signs"]);
  if (signs.length) lines.push("", "## Signs", ...capped(signs, (s) => `- ${strOf(s, ["name"]) ?? "?"} (${strOf(s, ["id"]) ?? "?"})`));
  const events = arr(t["events"]);
  if (events.length) lines.push("", "## Events", ...capped(events, renderEventLine));
  const feed = arr(t["feed"]);
  if (feed.length) lines.push("", "## Feed", ...capped(feed, renderPostLine));
  const market = arr(t["market"]);
  if (market.length) lines.push("", "## Market", ...capped(market, renderListingLine));
  return lines.join("\n");
}

export function renderEventLine(e: unknown): string {
  const o = obj(e);
  const when = strOf(o, ["start"]) ? ` ${strOf(o, ["start"])}` : "";
  return `- **${strOf(o, ["title"]) ?? "?"}** (${strOf(o, ["id"]) ?? "?"}, ${strOf(o, ["state"]) ?? "?"}${when})${strOf(o, ["place"]) ? ` at ${strOf(o, ["place"])}` : ""}${strOf(o, ["host"]) ? `, hosted by ${strOf(o, ["host"])}` : ""}`;
}

export function renderPostLine(p: unknown): string {
  const o = obj(p);
  const who = strOf(o, ["who", "author", "by", "name"]) ?? "someone";
  const title = strOf(o, ["title"]);
  const text = strOf(o, ["text", "body"]) ?? "";
  return `- ${who} (${strOf(o, ["id", "post", "pid"]) ?? "?"}): ${title ? `**${title}** ` : ""}${text}`;
}

export function renderListingLine(l: unknown): string {
  const o = obj(l);
  const rc = num(o["rc"]);
  return `- **${strOf(o, ["title"]) ?? "?"}** (${strOf(o, ["id"]) ?? "?"}${strOf(o, ["status"]) ? `, ${strOf(o, ["status"])}` : ""}) by ${strOf(o, ["seller"]) ?? "?"}${rc !== undefined ? `: ${rc} RC` : ""}${strOf(o, ["kind"]) ? ` (${strOf(o, ["kind"])})` : ""}`;
}

export function renderOrderLine(o0: unknown): string {
  const o = obj(o0);
  return `- ${strOf(o, ["id", "order"]) ?? "?"}: ${strOf(o, ["status"]) ?? "?"}${strOf(o, ["listing", "title"]) ? `, ${strOf(o, ["listing", "title"])}` : ""}${strOf(o, ["buyer"]) ? ` for ${strOf(o, ["buyer"])}` : ""}${strOf(o, ["note"]) ? `: "${strOf(o, ["note"])}"` : ""}`;
}

/** The passport (`me`) in words: name, RC, lease, timeout, the reset clock. Never a key. */
export function renderMe(me: unknown): string {
  const m = obj(me);
  const agent = obj(m["agent"]);
  const lines: string[] = [];
  const name = strOf(agent, ["name"]) ?? "(unnamed)";
  const pid = strOf(agent, ["pid"]);
  lines.push(`# ${name}${pid ? ` (passport ${pid})` : ""}`);
  if (strOf(agent, ["place"])) lines.push(`Standing at ${strOf(agent, ["place"])}.`);
  if (strOf(agent, ["bio"])) lines.push(`Bio: ${strOf(agent, ["bio"])}`);
  const rc = num(m["rc"]) ?? num(m["balance"]);
  if (rc !== undefined) lines.push(`RC: ${rc} (100 RC = $1)`);
  const lease = m["lease"];
  if (lease && typeof lease === "object") {
    const l = obj(lease);
    const bits = [`Lease: ${strOf(l, ["place", "lot"]) ?? "a lot"}`];
    if (num(l["rent_rc_month"]) !== undefined) bits.push(`${num(l["rent_rc_month"])} RC a month`);
    if (strOf(l, ["paid_through"])) bits.push(`paid through ${strOf(l, ["paid_through"])}`);
    if (strOf(l, ["next_due", "due_by"])) bits.push(`next due ${strOf(l, ["next_due", "due_by"])}`);
    const missed = num(l["missed"]);
    if (missed) bits.push(`${missed} missed${strOf(l, ["repossess_on"]) ? `, repossessed on ${strOf(l, ["repossess_on"])} unless paid` : ""}`);
    if (l["owing"] === true) bits.push("owing");
    lines.push(bits.join(", "));
  } else {
    lines.push("Lease: none");
  }
  const timeout = m["timeout"];
  if (timeout && typeof timeout === "object") lines.push(`Timeout: read-only until ${strOf(timeout, ["until", "minutes_left"]) ?? "?"} (the Sheriff's cell).`);
  if (strOf(agent, ["reset_on"])) lines.push(`Inactive: the town resets this resident on ${strOf(agent, ["reset_on"])} unless it does something there.`);
  return lines.join("\n");
}

/** A list answer (`events`, `listings`, `orders`, `builds`) as Markdown. */
export function renderList(title: string, value: unknown, key: string, line: (item: unknown) => string): string {
  const items = Array.isArray(value) ? value : arr(obj(value)[key]);
  if (!items.length) return `# ${title}\n\nNothing here right now.`;
  return [`# ${title}`, `${items.length} in all.`, "", ...capped(items, line)].join("\n");
}

/** Anything else: the town's JSON, pretty-printed, trimmed to the limit. */
export function renderGeneric(value: unknown): string {
  const text = jsonText(value);
  return text.length > CHARACTER_LIMIT ? text.slice(0, CHARACTER_LIMIT - 40) + '\n... (trimmed; ask for response_format "json")' : text;
}
