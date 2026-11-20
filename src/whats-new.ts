// `hollow_whats_new`: what the town has for the resident since the last look,
// remembered across server runs in a small state file so a new session does
// not re-report what the last one saw.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Resident } from "./resident.js";
import { newSeen, reasonText, triggers, type Seen, type Trigger } from "./wake.js";

/** Ids remembered per list; the oldest fall off. */
const REMEMBER = 500;

type Stored = {
  feed: string[];
  orders: string[];
  rentDue?: string;
  missed: number;
  resetOn?: string;
  inTimeout: boolean;
  primed: boolean;
  savedAt: string;
};

export function loadSeen(path: string): Seen {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
    const seen = newSeen();
    for (const id of Array.isArray(s.feed) ? s.feed : []) if (typeof id === "string") seen.feed.add(id);
    for (const id of Array.isArray(s.orders) ? s.orders : []) if (typeof id === "string") seen.orders.add(id);
    if (typeof s.rentDue === "string") seen.rentDue = s.rentDue;
    if (typeof s.missed === "number") seen.missed = s.missed;
    if (typeof s.resetOn === "string") seen.resetOn = s.resetOn;
    seen.inTimeout = s.inTimeout === true;
    seen.primed = s.primed === true;
    return seen;
  } catch {
    return newSeen();
  }
}

export function saveSeen(path: string, seen: Seen): void {
  const trim = (set: Set<string>) => [...set].slice(-REMEMBER);
  const stored: Stored = {
    feed: trim(seen.feed),
    orders: trim(seen.orders),
    ...(seen.rentDue !== undefined ? { rentDue: seen.rentDue } : {}),
    missed: seen.missed,
    ...(seen.resetOn !== undefined ? { resetOn: seen.resetOn } : {}),
    inTimeout: seen.inTimeout,
    primed: seen.primed,
    savedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export type WhatsNewAnswer = {
  /** False on the very first look from this machine: nothing to compare with yet. */
  primed: boolean;
  triggers: Trigger[];
  reason: string;
  name: string;
};

export class WhatsNew {
  private seen?: Seen;
  constructor(
    private readonly resident: Resident,
    private readonly statePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async check(signal?: AbortSignal): Promise<WhatsNewAnswer> {
    this.seen ??= loadSeen(this.statePath);
    const primed = this.seen.primed;
    const me = await this.resident.call("me", {}, signal);
    if (me.status !== 200) throw new Error(`the town answered ${me.status} to \`me\``);
    const town = await this.resident.call("town", {}, signal);
    const orders = await this.resident.call("orders", {}, signal);
    const name = this.resident.name ?? "you";
    const out = triggers(
      this.seen,
      name,
      me.value,
      town.status === 200 ? town.value : undefined,
      orders.status === 200 ? orders.value : undefined,
      Math.floor(this.now() / 1000),
    );
    try {
      saveSeen(this.statePath, this.seen);
    } catch {
      /* a read-only home: the memory lasts the process */
    }
    return { primed, triggers: out, reason: reasonText(out), name };
  }
}
