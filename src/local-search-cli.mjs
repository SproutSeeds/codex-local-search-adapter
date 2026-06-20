#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const searchdPath = fileURLToPath(new URL("./local-searchd.mjs", import.meta.url));
const defaultUrl = process.env.LOCAL_SEARCH_CLI_URL || process.env.LOCAL_SEARCH_MCP_URL || "http://127.0.0.1:8767";
const config = {
  url: trimTrailingSlash(defaultUrl),
  autostart: true,
  json: false,
  timeoutMs: Number(process.env.LOCAL_SEARCH_CLI_TIMEOUT_MS || 60000),
  startupTimeoutMs: Number(process.env.LOCAL_SEARCH_CLI_STARTUP_TIMEOUT_MS || 10000),
  responseLength: "medium",
  maxOutputTokens: undefined,
  recency: undefined,
  domains: [],
};

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(0);
}
if (argv.includes("--smoke")) {
  runSmoke().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
} else {
  main(argv).catch((err) => {
    console.error(`codex-local-search: ${err.message}`);
    process.exit(1);
  });
}

function usage() {
  console.error(`Usage:
  node src/local-search-cli.mjs health [--json]
  node src/local-search-cli.mjs search [options] <query...>
  node src/local-search-cli.mjs image [options] <query...>
  node src/local-search-cli.mjs open <ref-or-url> [lineno]
  node src/local-search-cli.mjs find <ref-or-url> <pattern...>
  node src/local-search-cli.mjs screenshot <ref-or-url> [pageno]
  node src/local-search-cli.mjs stop

Shell fallback for Codex local-provider runs when MCP tool routing is unavailable.

Options:
  --url URL                 Broker URL. Default: ${defaultUrl}
  --no-autostart            Do not start local-searchd when missing.
  --json                    Print full JSON response.
  --response-length VALUE   short, medium, or long. Default: medium.
  --max-output-tokens N     Broker output budget hint.
  --recency DAYS            Prefer recent results.
  --domain DOMAIN           Restrict search. Can be repeated.
  --smoke                   Run an offline CLI smoke test.
`);
}

async function main(rawArgs) {
  const args = parseArgs(rawArgs);
  const command = args.positionals.shift();
  if (!command) {
    usage();
    process.exit(2);
  }

  if (command === "stop") {
    stopBroker();
    return;
  }

  await ensureBroker();

  if (command === "health") {
    printHealth(await requestJson("GET", "/health"));
    return;
  }

  if (command === "search" || command === "image") {
    const query = args.positionals.join(" ").trim();
    if (!query) throw new Error(`${command} requires a query.`);
    const queryField = command === "image" ? "image_query" : "search_query";
    const queryItem = { q: query };
    if (Number.isInteger(config.recency)) queryItem.recency = config.recency;
    if (config.domains.length) queryItem.domains = config.domains;
    const json = await requestJson("POST", "/search", {
      commands: {
        [queryField]: [queryItem],
        response_length: config.responseLength,
      },
      max_output_tokens: config.maxOutputTokens,
    });
    printBroker(json);
    return;
  }

  if (command === "open") {
    const ref = args.positionals[0];
    if (!ref) throw new Error("open requires a ref or URL.");
    const json = await requestJson("POST", "/open", {
      ref_id: ref,
      lineno: integerOrUndefined(args.positionals[1]),
    });
    printBroker(json);
    return;
  }

  if (command === "find") {
    const ref = args.positionals.shift();
    const pattern = args.positionals.join(" ").trim();
    if (!ref || !pattern) throw new Error("find requires a ref/URL and pattern.");
    const json = await requestJson("POST", "/find", { ref_id: ref, pattern });
    printBroker(json);
    return;
  }

  if (command === "screenshot") {
    const ref = args.positionals[0];
    if (!ref) throw new Error("screenshot requires a ref or URL.");
    const json = await requestJson("POST", "/screenshot", {
      ref_id: ref,
      pageno: integerOrUndefined(args.positionals[1]) ?? 0,
    });
    printBroker(json);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function parseArgs(rawArgs) {
  const positionals = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--url") config.url = trimTrailingSlash(requiredValue(rawArgs, ++index, "--url"));
    else if (arg.startsWith("--url=")) config.url = trimTrailingSlash(arg.slice("--url=".length));
    else if (arg === "--no-autostart") config.autostart = false;
    else if (arg === "--json") config.json = true;
    else if (arg === "--response-length") config.responseLength = requiredValue(rawArgs, ++index, "--response-length");
    else if (arg.startsWith("--response-length=")) config.responseLength = arg.slice("--response-length=".length);
    else if (arg === "--max-output-tokens") {
      config.maxOutputTokens = Number(requiredValue(rawArgs, ++index, "--max-output-tokens"));
    } else if (arg.startsWith("--max-output-tokens=")) {
      config.maxOutputTokens = Number(arg.slice("--max-output-tokens=".length));
    } else if (arg === "--recency") {
      config.recency = Number(requiredValue(rawArgs, ++index, "--recency"));
    } else if (arg.startsWith("--recency=")) {
      config.recency = Number(arg.slice("--recency=".length));
    } else if (arg === "--domain") {
      config.domains.push(requiredValue(rawArgs, ++index, "--domain"));
    } else if (arg.startsWith("--domain=")) {
      config.domains.push(arg.slice("--domain=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (!["short", "medium", "long"].includes(config.responseLength)) {
    throw new Error("--response-length must be short, medium, or long.");
  }
  if (config.maxOutputTokens !== undefined && !Number.isInteger(config.maxOutputTokens)) {
    throw new Error("--max-output-tokens must be an integer.");
  }
  if (config.recency !== undefined && !Number.isInteger(config.recency)) {
    throw new Error("--recency must be an integer.");
  }
  return { positionals };
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

async function ensureBroker() {
  if (await healthReachable()) return;
  if (!config.autostart) {
    throw new Error(`broker unavailable at ${config.url}; autostart disabled.`);
  }
  if (!isLoopbackBroker(config.url)) {
    throw new Error(`broker unavailable at ${config.url}; autostart requires localhost.`);
  }

  const parsed = new URL(config.url);
  const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
  const port = parsed.port || "8767";
  const child = spawn(process.execPath, [searchdPath, "--host", host, "--port", port], {
    cwd: here,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  mkdirSync(dirname(pidFile()), { recursive: true });
  writeFileSync(pidFile(), `${child.pid}\n`);

  const deadline = Date.now() + config.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await healthReachable()) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for broker at ${config.url}. Check whether ${host}:${port} is occupied.`);
}

async function healthReachable() {
  try {
    const json = await requestJson("GET", "/health", undefined, 1500);
    return json?.status === "ok" && json?.service === "local-searchd";
  } catch {
    return false;
  }
}

function stopBroker() {
  const file = pidFile();
  if (!existsSync(file)) {
    console.log(`No pid file at ${file}`);
    return;
  }
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid)) throw new Error(`invalid pid file: ${file}`);
  process.kill(pid, "SIGTERM");
  unlinkSync(file);
  console.log(`Stopped local-searchd pid ${pid}`);
}

async function requestJson(method, path, body, timeoutMs = config.timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`broker returned non-JSON response: ${text.slice(0, 500)}`);
    }
    if (!response.ok) throw new Error(json?.error || json?.output || `broker HTTP ${response.status}`);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function printBroker(json) {
  if (config.json || typeof json?.output !== "string") printJson(json);
  else console.log(json.output);
}

function printHealth(json) {
  if (config.json) printJson(json);
  else console.log(`${json.service || "unknown"} ${json.status || "unknown"}`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function pidFile() {
  const port = new URL(config.url).port || "8767";
  return process.env.LOCAL_SEARCH_CLI_PID_FILE || join(homedir(), ".cache", "local-searchd", `local-searchd-${port}.pid`);
}

function integerOrUndefined(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function isLoopbackBroker(url) {
  const parsed = new URL(url);
  return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/g, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmoke() {
  const originalUrl = config.url;
  const originalAutostart = config.autostart;
  const fake = await startFakeServer();
  config.url = fake.url;
  config.autostart = false;
  try {
    assertIncludes(JSON.stringify(await requestJson("GET", "/health")), "fake-local-searchd", "health");
    const search = await requestJson("POST", "/search", {
      commands: { search_query: [{ q: "sunflower conjecture" }], response_length: "short" },
    });
    assertIncludes(search.output, "fake search: sunflower conjecture", "search");
    const open = await requestJson("POST", "/open", { ref_id: "https://example.test" });
    assertIncludes(open.output, "fake open: https://example.test", "open");
    const found = await requestJson("POST", "/find", {
      ref_id: "https://example.test",
      pattern: "needle",
    });
    assertIncludes(found.output, "fake find: needle", "find");
    console.log("local-search-cli smoke PASS");
  } finally {
    config.url = originalUrl;
    config.autostart = originalAutostart;
    fake.close();
  }
}

async function startFakeServer() {
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = req.method === "POST" ? await readRequestJson(req) : {};
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.pathname === "/health") {
      res.end(JSON.stringify({ status: "ok", service: "fake-local-searchd" }));
    } else if (req.method === "POST" && url.pathname === "/search") {
      res.end(JSON.stringify({ output: `fake search: ${body.commands?.search_query?.[0]?.q}` }));
    } else if (req.method === "POST" && url.pathname === "/open") {
      res.end(JSON.stringify({ output: `fake open: ${body.ref_id}` }));
    } else if (req.method === "POST" && url.pathname === "/find") {
      res.end(JSON.stringify({ output: `fake find: ${body.pattern}` }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function assertIncludes(value, expected, label) {
  if (!String(value).includes(expected)) {
    throw new Error(`${label} smoke failed: expected ${JSON.stringify(expected)} in ${value}`);
  }
}
