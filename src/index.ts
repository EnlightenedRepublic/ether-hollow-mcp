#!/usr/bin/env node
// ether-hollow-mcp: serve MCP on stdio (default) or Streamable HTTP (--http),
// or run the owner's commands (register / status / forget).
import { createServer as createHttpServer, type IncomingMessage } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { main as cliMain, USAGE } from "./cli-main.js";
import { settingsFromEnv } from "./config.js";
import { SERVER_NAME, VERSION, buildDeps, createServer } from "./server.js";

const argv = process.argv.slice(2);
const first = argv[0] ?? "";

const io = {
  out: (line: string) => process.stdout.write(line + "\n"),
  err: (line: string) => process.stderr.write(line + "\n"),
};

if (["register", "status", "forget", "help", "--help", "-h"].includes(first)) {
  cliMain(first === "help" ? ["--help"] : argv, io).then(
    (code) => process.exit(code),
    (err) => {
      io.err(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
} else if (first === "--http") {
  serveHttp(Number(argv[1] ?? 3838));
} else if (first.startsWith("-") || first) {
  io.err(`Unknown argument "${first}".`);
  io.err(USAGE);
  process.exit(2);
} else {
  const deps = buildDeps(settingsFromEnv(), (line) => process.stderr.write(line + "\n"));
  serveStdio(() => createServer(deps));
  process.stderr.write(`${SERVER_NAME} ${VERSION} on stdio (town ${deps.resident.url.replace(/\/api\/agent$/, "")}; key ${deps.resident.hasKey() ? "found" : `missing, run: npx ${SERVER_NAME} register`}; spending ${deps.spend() ? "on" : "off"})\n`);
}

/** Only this machine may talk to a local HTTP server: the Host and Origin must be local (DNS rebinding guard). */
export function isLocalRequest(req: Pick<IncomingMessage, "headers">): boolean {
  const local = (value: string | undefined): boolean => {
    if (!value) return true;
    let host = value;
    try {
      host = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`).hostname;
    } catch {
      return false;
    }
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host.toLowerCase());
  };
  const origin = req.headers["origin"];
  return local(req.headers["host"]) && local(Array.isArray(origin) ? origin[0] : origin);
}

function serveHttp(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    io.err("--http takes a port number.");
    process.exit(2);
  }
  const deps = buildDeps(settingsFromEnv(), (line) => process.stderr.write(line + "\n"));
  const handler = toNodeHandler(createMcpHandler(() => createServer(deps)));
  const server = createHttpServer((req, res) => {
    if (!isLocalRequest(req)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("ether-hollow-mcp answers this machine only (Host/Origin must be localhost)\n");
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("the MCP endpoint is /mcp\n");
      return;
    }
    void handler(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`${SERVER_NAME} ${VERSION} on http://127.0.0.1:${port}/mcp (key ${deps.resident.hasKey() ? "found" : "missing"}; spending ${deps.spend() ? "on" : "off"})\n`);
  });
}
