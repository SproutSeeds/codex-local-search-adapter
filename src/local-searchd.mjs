#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const defaultHost = process.env.LOCAL_SEARCHD_HOST || "127.0.0.1";
const defaultPort = Number(process.env.LOCAL_SEARCHD_PORT || 8767);
const defaultCacheDir =
  process.env.LOCAL_SEARCHD_CACHE_DIR || join(homedir(), ".cache", "local-searchd");
const defaultSearxngUrl =
  process.env.LOCAL_SEARCHD_SEARXNG_URL || process.env.SEARXNG_URL || "http://127.0.0.1:8080";
const defaultDdgsApiUrl =
  process.env.LOCAL_SEARCHD_DDGS_API_URL || process.env.DDGS_API_URL || "http://127.0.0.1:4479";
const defaultTimeoutMs = Number(process.env.LOCAL_SEARCHD_TIMEOUT_MS || 10000);
const defaultMaxResults = Number(process.env.LOCAL_SEARCHD_MAX_RESULTS || 8);
const defaultUserAgent =
  process.env.LOCAL_SEARCHD_USER_AGENT ||
  "LocalSearchD/0.1 (+local Codex OSS web search broker)";
const maxBodyBytes = 2_000_000;
const maxPageTextChars = 80_000;
const maxOutputChars = 48_000;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

const config = {
  host: args.host || defaultHost,
  port: Number(args.port || defaultPort),
  cacheDir: args.cacheDir || defaultCacheDir,
  searxngUrl: trimTrailingSlash(args.searxngUrl || defaultSearxngUrl),
  ddgsApiUrl: trimTrailingSlash(args.ddgsApiUrl || defaultDdgsApiUrl),
  timeoutMs: Number(args.timeoutMs || defaultTimeoutMs),
  maxResults: Number(args.maxResults || defaultMaxResults),
  userAgent: args.userAgent || defaultUserAgent,
  noNetwork: Boolean(args.noNetwork),
};

const state = {
  nextRef: 1,
  refs: new Map(),
  opened: new Map(),
};

if (args.smoke) {
  runSmoke().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
} else {
  startServer();
}

function usage() {
  console.error(`Usage: node src/local-searchd.mjs [options]

Free local search broker for Codex OSS/local-model web_search.

Options:
  --host addr              Bind address. Default: ${defaultHost}
  --port n                 Bind port. Default: ${defaultPort}
  --cache-dir path         Cache directory. Default: ${defaultCacheDir}
  --searxng-url url        Local SearXNG URL. Default: ${defaultSearxngUrl}
  --ddgs-api-url url       Local DDGS API URL. Default: ${defaultDdgsApiUrl}
  --timeout-ms n           Per-request timeout. Default: ${defaultTimeoutMs}
  --max-results n          Results per backend/query. Default: ${defaultMaxResults}
  --no-network             Disable outbound network for deterministic smoke/debug.
  --smoke                  Run offline broker self-checks and exit.
  --help                   Show this help.

Endpoints:
  GET  /health
  POST /search             Codex SearchRequest or SearchCommands JSON.
  GET  /search?q=...
  POST /open               {"ref_id":"https://..."} or {"url":"https://..."}
  POST /find               {"ref_id":"...","pattern":"..."}
  POST /screenshot         {"ref_id":"...","pageno":0}
`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--smoke") parsed.smoke = true;
    else if (arg === "--no-network") parsed.noNetwork = true;
    else if (arg === "--host") parsed.host = argv[++index];
    else if (arg === "--port") parsed.port = argv[++index];
    else if (arg === "--cache-dir") parsed.cacheDir = argv[++index];
    else if (arg === "--searxng-url") parsed.searxngUrl = argv[++index];
    else if (arg === "--ddgs-api-url") parsed.ddgsApiUrl = argv[++index];
    else if (arg === "--timeout-ms") parsed.timeoutMs = argv[++index];
    else if (arg === "--max-results") parsed.maxResults = argv[++index];
    else if (arg === "--user-agent") parsed.userAgent = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function startServer() {
  mkdirSync(config.cacheDir, { recursive: true });
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      sendJson(res, 500, {
        encrypted_output: null,
        output: `Codex Local Search Broker internal error: ${err.message}`,
        error: err.message,
      });
    }
  });
  server.listen(config.port, config.host, () => {
    console.error(
      `local-searchd listening on http://${config.host}:${config.port} cache=${config.cacheDir}`,
    );
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, healthPayload());
    return;
  }
  if (req.method === "GET" && url.pathname === "/search") {
    const q = url.searchParams.get("q") || "";
    const output = await executeSearchRequest({ commands: { search_query: [{ q }] } });
    sendJson(res, 200, output);
    return;
  }
  if (req.method === "POST" && url.pathname === "/search") {
    const body = await readJsonBody(req);
    const output = await executeSearchRequest(body);
    sendJson(res, 200, output);
    return;
  }
  if (req.method === "POST" && url.pathname === "/open") {
    const body = await readJsonBody(req);
    const output = await openOperation({ ref_id: body.ref_id || body.url, lineno: body.lineno });
    sendJson(res, 200, searchResponse(output));
    return;
  }
  if (req.method === "POST" && url.pathname === "/find") {
    const body = await readJsonBody(req);
    const output = await findOperation({ ref_id: body.ref_id || body.url, pattern: body.pattern });
    sendJson(res, 200, searchResponse(output));
    return;
  }
  if (req.method === "POST" && url.pathname === "/screenshot") {
    const body = await readJsonBody(req);
    const output = await screenshotOperation({
      ref_id: body.ref_id || body.url,
      pageno: Number(body.pageno || 0),
    });
    sendJson(res, 200, searchResponse(output));
    return;
  }
  sendJson(res, 404, searchResponse(`Unknown local-searchd endpoint: ${req.method} ${url.pathname}`));
}

function healthPayload() {
  return {
    status: "ok",
    service: "local-searchd",
    free_backends: {
      searxng: config.searxngUrl,
      ddgs_api: config.ddgsApiUrl,
      python_ddgs: pythonModuleAvailable("ddgs"),
      scholarly: ["arxiv", "crossref", "pubmed"],
      open_fetch: true,
      pdf_extractors: {
        pdftotext: commandAvailable("pdftotext"),
        python_pypdf: pythonModuleAvailable("pypdf"),
      },
      visual_capture: {
        playwright_module: moduleResolvable("playwright"),
        pdftoppm: commandAvailable("pdftoppm"),
      },
    },
    cache_dir: config.cacheDir,
    no_network: config.noNetwork,
  };
}

async function executeSearchRequest(request) {
  const commands = normalizeCommands(request);
  const responseLength = commands.response_length || request.response_length || "medium";
  const budget = outputBudget(responseLength, request.max_output_tokens);
  const sections = [
    "Codex Local Search Broker",
    "Free local web-search execution. Backends: SearXNG, DDGS API, Python DDGS, scholarly APIs, direct fetch, local cache.",
  ];
  const diagnostics = [];

  if (!hasRunnableCommands(commands)) {
    const inferredQuery = inferQueryFromRequest(request);
    if (inferredQuery) {
      commands.search_query = [{ q: inferredQuery }];
      diagnostics.push(`inferred search query from recent input: ${inferredQuery}`);
    }
  }

  if (commands.search_query?.length) {
    for (const query of commands.search_query) {
      const result = await searchQuery(query, "general");
      sections.push(result.output);
      diagnostics.push(...result.diagnostics);
    }
  }

  if (commands.image_query?.length) {
    for (const query of commands.image_query) {
      const result = await searchQuery(query, "images");
      sections.push(result.output);
      diagnostics.push(...result.diagnostics);
    }
  }

  if (commands.open?.length) {
    for (const operation of commands.open) {
      sections.push(await openOperation(operation));
    }
  }

  if (commands.click?.length) {
    for (const operation of commands.click) {
      sections.push(await clickOperation(operation));
    }
  }

  if (commands.find?.length) {
    for (const operation of commands.find) {
      sections.push(await findOperation(operation));
    }
  }

  if (commands.screenshot?.length) {
    for (const operation of commands.screenshot) {
      sections.push(await screenshotOperation(operation));
    }
  }

  sections.push(...freeLookupFallbacks(commands));

  if (sections.length === 2) {
    sections.push("No search commands were provided.");
  }

  if (diagnostics.length) {
    sections.push(formatDiagnostics(diagnostics));
  }

  return searchResponse(limitText(sections.filter(Boolean).join("\n\n"), budget));
}

function normalizeCommands(request) {
  if (!request || typeof request !== "object") return {};
  const source = request.commands && typeof request.commands === "object" ? request.commands : request;
  if (typeof source.q === "string") {
    return { search_query: [{ q: source.q }] };
  }
  if (typeof source.search_query === "string") {
    return { ...source, search_query: [{ q: source.search_query }] };
  }
  if (Array.isArray(source.search_query)) {
    return { ...source, search_query: source.search_query.map(normalizeQuery).filter(Boolean) };
  }
  if (typeof source.image_query === "string") {
    return { ...source, image_query: [{ q: source.image_query }] };
  }
  if (Array.isArray(source.image_query)) {
    return { ...source, image_query: source.image_query.map(normalizeQuery).filter(Boolean) };
  }
  return source;
}

function hasRunnableCommands(commands) {
  return [
    "search_query",
    "image_query",
    "open",
    "click",
    "find",
    "screenshot",
    "finance",
    "weather",
    "sports",
    "time",
  ].some((field) => Array.isArray(commands[field]) && commands[field].length > 0);
}

function inferQueryFromRequest(request) {
  const inputText = compactWhitespace(extractText(request?.input).join(" "));
  if (!inputText) return "";

  const patterns = [
    /\bsearch(?:\s+(?:the\s+web|web_search|online|internet))?\s+(?:for|about)\s+(.+?)(?:\band\s+return\b|\breturn\b|\bif\b|\bdo\s+not\b|$)/i,
    /\bfind\s+(.+?)(?:\band\s+return\b|\breturn\b|\bif\b|\bdo\s+not\b|$)/i,
    /\blook\s+up\s+(.+?)(?:\band\s+return\b|\breturn\b|\bif\b|\bdo\s+not\b|$)/i,
  ];
  for (const pattern of patterns) {
    const match = inputText.match(pattern);
    const cleaned = cleanInferredQuery(match?.[1]);
    if (cleaned) return cleaned;
  }

  return cleanInferredQuery(inputText);
}

function extractText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (!value || typeof value !== "object") return [];

  const chunks = [];
  for (const key of ["text", "content", "input_text", "message"]) {
    if (typeof value[key] === "string") chunks.push(value[key]);
  }
  if (Array.isArray(value.content)) chunks.push(...value.content.flatMap(extractText));
  if (Array.isArray(value.items)) chunks.push(...value.items.flatMap(extractText));
  return chunks;
}

function cleanInferredQuery(text) {
  const cleaned = compactWhitespace(text)
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\bfor this benchmark\b/gi, " ")
    .replace(/\busing only the details below\b/gi, " ")
    .replace(/\buse codex web search\b/gi, " ")
    .replace(/\buse web_search\b/gi, " ")
    .replace(/^.*\bsearch\s+(?:for|about)\s+/i, "")
    .replace(/\bexactly four bullets?:?.*$/i, " ")
    .replace(/\bwrite NO_SEARCH\b.*$/i, " ")
    .replace(/[.;:]+$/g, "");
  return compactWhitespace(cleaned).slice(0, 180);
}

function normalizeQuery(value) {
  if (typeof value === "string") return { q: value };
  if (value && typeof value.q === "string") return value;
  return null;
}

async function searchQuery(query, kind) {
  const q = query.q?.trim();
  if (!q) {
    return { output: `Skipped empty ${kind} query.`, diagnostics: [] };
  }

  const diagnostics = [];
  const cacheKey = cacheName("search", { q, kind, recency: query.recency, domains: query.domains });
  const cached = await readCacheJson(cacheKey);
  if (cached) {
    return {
      output: formatSearchResults(q, kind, cached.results, ["cache"], cached.scholarly || []),
      diagnostics: [`cache hit for ${kind} query: ${q}`],
    };
  }

  const backends = [];
  if (!config.noNetwork) {
    backends.push({ name: "searxng", run: () => searchSearxng(q, kind, query) });
    backends.push({ name: "ddgs-api", run: () => searchDdgsApi(q, kind, query) });
    backends.push({ name: "python-ddgs", run: () => searchDdgsPython(q, kind, query) });
    if (kind === "general") {
      backends.push({ name: "duckduckgo-html", run: () => searchDuckDuckGoHtml(q, query) });
      backends.push({ name: "wikipedia", run: () => searchWikipedia(q) });
    }
  }

  const results = [];
  const usedBackends = [];
  for (const backend of backends) {
    try {
      const backendResult = await backend.run();
      if (backendResult.results.length) {
        results.push(...backendResult.results);
        usedBackends.push(backendResult.name);
      }
      diagnostics.push(...backendResult.diagnostics);
    } catch (err) {
      diagnostics.push(`${backend.name} failed: ${err.message}`);
    }
    if (dedupeResults(results).length >= config.maxResults) break;
  }

  let scholarly = [];
  if (!config.noNetwork && shouldRunScholarly(q)) {
    const scholarlyResult = await searchScholarly(q);
    scholarly = scholarlyResult.results;
    diagnostics.push(...scholarlyResult.diagnostics);
    if (scholarly.length) usedBackends.push("scholarly");
  }

  const deduped = sortResultsForQuery(dedupeResults(results), q).slice(0, config.maxResults);
  await writeCacheJson(cacheKey, { results: deduped, scholarly });

  return {
    output: formatSearchResults(q, kind, deduped, usedBackends, scholarly),
    diagnostics,
  };
}

async function searchSearxng(q, kind, query) {
  const url = new URL(`${config.searxngUrl}/search`);
  url.searchParams.set("q", applyDomainFilters(q, query.domains));
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");
  if (kind === "images") url.searchParams.set("categories", "images");
  const timeRange = recencyToSearxngRange(query.recency);
  if (timeRange) url.searchParams.set("time_range", timeRange);

  const json = await fetchJson(url);
  const results = Array.isArray(json.results)
    ? json.results.map((item) => ({
        title: item.title || item.url || "Untitled result",
        url: item.url || item.img_src || item.thumbnail,
        snippet: item.content || item.img_src || item.thumbnail || "",
        source: `searxng${item.engine ? `:${item.engine}` : ""}`,
        thumbnail: item.thumbnail || item.img_src,
      }))
    : [];
  return {
    name: "searxng",
    results: results.filter((item) => item.url),
    diagnostics: [`searxng returned ${results.length} ${kind} results`],
  };
}

async function searchDdgsApi(q, kind, query) {
  const endpoint = kind === "images" ? "/search/images" : "/search/text";
  const attempts = ["q", "query"];
  for (const param of attempts) {
    const url = new URL(`${config.ddgsApiUrl}${endpoint}`);
    url.searchParams.set(param, applyDomainFilters(q, query.domains));
    url.searchParams.set("max_results", String(config.maxResults));
    const json = await fetchJson(url);
    const list = Array.isArray(json) ? json : Array.isArray(json.results) ? json.results : [];
    const results = list.map((item) => ({
      title: item.title || item.href || item.url || "Untitled result",
      url: item.href || item.url || item.image || item.thumbnail,
      snippet: item.body || item.content || item.description || "",
      source: "ddgs-api",
      thumbnail: item.thumbnail || item.image,
    }));
    if (results.length) {
      return {
        name: "ddgs-api",
        results: results.filter((item) => item.url),
        diagnostics: [`ddgs-api returned ${results.length} ${kind} results`],
      };
    }
  }
  return { name: "ddgs-api", results: [], diagnostics: ["ddgs-api returned no results"] };
}

async function searchDdgsPython(q, kind, query) {
  if (!pythonModuleAvailable("ddgs")) {
    return { name: "python-ddgs", results: [], diagnostics: ["python-ddgs module unavailable"] };
  }

  const script = `
import json
import sys
from ddgs import DDGS

query = sys.argv[1]
kind = sys.argv[2]
limit = int(sys.argv[3])
client = DDGS()
if kind == "images":
    rows = client.images(query, max_results=limit)
else:
    rows = client.text(query, max_results=limit)
print(json.dumps(list(rows)[:limit]))
`;
  const result = await runCommand(
    pythonCommand(),
    ["-c", script, applyDomainFilters(q, query.domains), kind, String(config.maxResults)],
    config.timeoutMs + 5000,
  );
  if (result.status !== 0) {
    return {
      name: "python-ddgs",
      results: [],
      diagnostics: [`python-ddgs failed: ${compactWhitespace(result.stderr).slice(0, 500)}`],
    };
  }
  try {
    const rows = JSON.parse(result.stdout);
    const results = mapDdgsPythonRows(rows, kind);
    return {
      name: "python-ddgs",
      results,
      diagnostics: [`python-ddgs returned ${results.length} ${kind} results`],
    };
  } catch (err) {
    return {
      name: "python-ddgs",
      results: [],
      diagnostics: [`python-ddgs parse failed: ${err.message}`],
    };
  }
}

function mapDdgsPythonRows(rows, kind) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((item) => {
      const imageUrl = item.image || item.thumbnail;
      const pageUrl = item.href || item.url;
      return {
        title: item.title || pageUrl || imageUrl || "DDGS result",
        url: kind === "images" ? imageUrl || pageUrl : pageUrl || imageUrl,
        snippet: item.body || item.content || item.description || (pageUrl ? `Source page: ${pageUrl}` : ""),
        source: item.source ? `python-ddgs:${item.source}` : "python-ddgs",
        thumbnail: item.thumbnail || imageUrl,
      };
    })
    .filter((item) => item.url);
}

async function searchDuckDuckGoHtml(q, query) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", applyDomainFilters(q, query.domains));
  const html = await fetchText(url);
  const blocks = html.split(/<div class="result results_links/gi).slice(1);
  const results = blocks.slice(0, config.maxResults * 2).map((block) => {
    const href = decodeEntities(
      firstMatch(block, /<a[^>]+class="result__a"[^>]+href="([^"]+)"/i) ||
        firstMatch(block, /<a[^>]+href="([^"]+)"[^>]+class="result__a"/i),
    );
    const title = decodeEntities(firstMatch(block, /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i).replace(/<[^>]+>/g, " "));
    const snippet = decodeEntities(firstMatch(block, /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i).replace(/<[^>]+>/g, " "));
    const resultUrl = resolveDuckDuckGoUrl(href);
    return {
      title: title || resultUrl || "DuckDuckGo result",
      url: resultUrl,
      snippet,
      source: "duckduckgo-html",
    };
  });
  return {
    name: "duckduckgo-html",
    results: results.filter((item) => item.url),
    diagnostics: [`duckduckgo-html returned ${results.filter((item) => item.url).length} results`],
  };
}

async function searchWikipedia(q) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("utf8", "1");
  url.searchParams.set("srlimit", String(Math.min(config.maxResults, 8)));
  const json = await fetchJson(url);
  const items = json.query?.search || [];
  const results = items.map((item) => ({
    title: item.title || "Wikipedia result",
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title || "").replace(/\s+/g, "_"))}`,
    snippet: decodeEntities(String(item.snippet || "").replace(/<[^>]+>/g, " ")),
    source: "wikipedia",
  }));
  return {
    name: "wikipedia",
    results,
    diagnostics: [`wikipedia returned ${results.length} results`],
  };
}

function resolveDuckDuckGoUrl(href) {
  if (!href) return null;
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    if (redirected) return redirected;
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname === "/l/") {
      return parsed.searchParams.get("uddg");
    }
    return parsed.toString();
  } catch {
    return href;
  }
}

async function searchScholarly(q) {
  const diagnostics = [];
  const searches = [searchArxiv(q), searchCrossref(q), searchPubmed(q)];
  const settled = await Promise.allSettled(searches);
  const results = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      results.push(...item.value.results);
      diagnostics.push(...item.value.diagnostics);
    } else {
      diagnostics.push(item.reason.message);
    }
  }
  return {
    results: sortResultsForQuery(dedupeResults(results), q).slice(0, config.maxResults),
    diagnostics,
  };
}

async function searchArxiv(q) {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", arxivQuery(q));
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(Math.min(config.maxResults, 5)));
  const xml = await fetchText(url);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1]);
  const results = entries.map((entry) => ({
    title: cleanXml(firstXml(entry, "title")) || "arXiv result",
    url: cleanXml(firstXml(entry, "id")),
    snippet: cleanXml(firstXml(entry, "summary")),
    source: "arxiv",
  }));
  return { results: results.filter((item) => item.url), diagnostics: [`arxiv returned ${results.length} results`] };
}

function arxivQuery(q) {
  const terms = queryTokens(q).slice(0, 6);
  if (!terms.length) return `all:${q}`;
  return terms.map((term) => `all:${term}`).join(" AND ");
}

async function searchCrossref(q) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", q);
  url.searchParams.set("rows", String(Math.min(config.maxResults, 5)));
  const json = await fetchJson(url);
  const items = json.message?.items || [];
  const results = items.map((item) => ({
    title: Array.isArray(item.title) ? item.title[0] : item.title || item.DOI || "Crossref result",
    url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : null),
    snippet: [
      item.DOI ? `DOI: ${item.DOI}` : "",
      item.publisher ? `Publisher: ${item.publisher}` : "",
      item.issued?.["date-parts"]?.[0]?.[0] ? `Year: ${item.issued["date-parts"][0][0]}` : "",
    ]
      .filter(Boolean)
      .join(" | "),
    source: "crossref",
  }));
  return {
    results: results.filter((item) => item.url),
    diagnostics: [`crossref returned ${results.length} results`],
  };
}

async function searchPubmed(q) {
  const searchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  searchUrl.searchParams.set("db", "pubmed");
  searchUrl.searchParams.set("retmode", "json");
  searchUrl.searchParams.set("retmax", String(Math.min(config.maxResults, 5)));
  searchUrl.searchParams.set("term", q);
  const searchJson = await fetchJson(searchUrl);
  const ids = searchJson.esearchresult?.idlist || [];
  if (!ids.length) return { results: [], diagnostics: ["pubmed returned 0 ids"] };

  const summaryUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  summaryUrl.searchParams.set("db", "pubmed");
  summaryUrl.searchParams.set("retmode", "json");
  summaryUrl.searchParams.set("id", ids.join(","));
  const summaryJson = await fetchJson(summaryUrl);
  const results = ids.map((id) => {
    const item = summaryJson.result?.[id] || {};
    return {
      title: item.title || `PubMed ${id}`,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      snippet: [item.fulljournalname, item.pubdate].filter(Boolean).join(" | "),
      source: "pubmed",
    };
  });
  return { results, diagnostics: [`pubmed returned ${results.length} results`] };
}

function formatSearchResults(q, kind, results, backends, scholarly) {
  const lines = [`## ${kind === "images" ? "Image Search" : "Search"}: ${q}`];
  lines.push(`Backends: ${backends.length ? backends.join(", ") : "none"}`);
  if (!results.length) {
    lines.push("No web results were returned by the configured free backends.");
  }
  results.forEach((result) => {
    const ref = storeRef(result);
    lines.push("");
    lines.push(`[${ref}] ${result.title}`);
    lines.push(`URL: ${result.url}`);
    lines.push(`Source: ${result.source}`);
    if (result.thumbnail) lines.push(`Thumbnail: ${result.thumbnail}`);
    if (result.snippet) lines.push(`Snippet: ${compactWhitespace(result.snippet).slice(0, 700)}`);
  });

  if (scholarly?.length) {
    lines.push("");
    lines.push("## Scholarly Enrichment");
    scholarly.forEach((result) => {
      const ref = storeRef(result);
      lines.push("");
      lines.push(`[${ref}] ${result.title}`);
      lines.push(`URL: ${result.url}`);
      lines.push(`Source: ${result.source}`);
      if (result.snippet) lines.push(`Snippet: ${compactWhitespace(result.snippet).slice(0, 700)}`);
    });
  }
  return lines.join("\n");
}

async function openOperation(operation) {
  const refId = operation?.ref_id;
  if (!refId) return "Open failed: missing ref_id.";
  const target = resolveRef(refId);
  if (!target?.url) return `Open failed: unknown ref_id or URL: ${refId}`;
  const document = await openUrl(target.url);
  const lineText = operation.lineno ? excerptAroundLine(document.text, Number(operation.lineno)) : null;
  const links = document.links.slice(0, 30).map((link, index) => {
    link.id = index;
    return `${index}. ${link.text || link.url}\n   ${link.url}`;
  });
  state.opened.set(refId, document);
  state.opened.set(target.url, document);
  state.opened.set(document.ref, document);

  return [
    `## Open: ${document.title || target.url}`,
    `Ref: ${document.ref}`,
    `URL: ${target.url}`,
    `Content-Type: ${document.contentType || "unknown"}`,
    document.summary ? `Summary: ${document.summary}` : "",
    lineText ? `Requested line context:\n${lineText}` : "",
    `Text:\n${limitText(numberLines(document.text), 9000)}`,
    links.length ? `Links:\n${links.join("\n")}` : "Links: none extracted",
    document.localPath ? `Local file: ${document.localPath}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function clickOperation(operation) {
  const document = state.opened.get(operation.ref_id);
  if (!document) return `Click failed: page ref not opened: ${operation.ref_id}`;
  const link = document.links.find((candidate) => Number(candidate.id) === Number(operation.id));
  if (!link) return `Click failed: link id ${operation.id} not found in ${operation.ref_id}`;
  return openOperation({ ref_id: link.url });
}

async function findOperation(operation) {
  if (!operation?.pattern) return "Find failed: missing pattern.";
  const target = operation.ref_id ? resolveRef(operation.ref_id) : null;
  const document =
    state.opened.get(operation.ref_id) || (target?.url ? await openUrl(target.url) : null);
  if (!document) return `Find failed: unknown or unopened ref_id: ${operation.ref_id}`;
  const matches = findMatches(document.text, operation.pattern, 8);
  if (!matches.length) {
    return `## Find: ${operation.pattern}\nRef: ${operation.ref_id}\nNo matches found.`;
  }
  return [
    `## Find: ${operation.pattern}`,
    `Ref: ${operation.ref_id}`,
    `URL: ${document.url}`,
    ...matches.map((match, index) => `${index + 1}. line ${match.line}: ${match.excerpt}`),
  ].join("\n");
}

async function screenshotOperation(operation) {
  const target = resolveRef(operation?.ref_id);
  if (!target?.url) return `Screenshot failed: unknown ref_id or URL: ${operation?.ref_id}`;
  const document = state.opened.get(operation.ref_id) || (await openUrl(target.url));
  if (document.kind === "pdf") {
    const rendered = await renderPdfPage(document.localPath, Number(operation.pageno || 0));
    if (rendered) {
      return [
        "## Screenshot",
        `PDF page: ${Number(operation.pageno || 0)}`,
        `URL: ${document.url}`,
        `Image path: ${rendered}`,
      ].join("\n");
    }
  }
  const pageShot = await capturePageScreenshot(target.url);
  if (pageShot) {
    return ["## Screenshot", `URL: ${target.url}`, `Image path: ${pageShot}`].join("\n");
  }
  return [
    "## Screenshot",
    `URL: ${target.url}`,
    "Visual capture is unavailable. Install Playwright for page screenshots or pdftoppm for PDF screenshots.",
    "Text extraction is available through open/find.",
  ].join("\n");
}

async function openUrl(url) {
  const cacheKey = cacheName("open", { url });
  const cached = await readCacheJson(cacheKey);
  if (cached) {
    state.opened.set(url, cached);
    return cached;
  }

  if (config.noNetwork) {
    throw new Error(`Network disabled; cannot open ${url}`);
  }

  const response = await fetchWithTimeout(url, {
    headers: { "user-agent": config.userAgent, accept: "*/*" },
  });
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const ref = storeRef({ title: url, url, snippet: "opened page", source: "open" });

  let document;
  if (contentType.includes("pdf") || /\.pdf($|[?#])/i.test(url)) {
    const localPath = await writeCachedBlob(url, buffer, ".pdf");
    const text = await extractPdfText(localPath);
    document = {
      ref,
      kind: "pdf",
      url,
      title: basename(new URL(url).pathname) || url,
      contentType,
      text: text || "[PDF fetched, but no local PDF text extractor succeeded.]",
      summary: "PDF document",
      links: [],
      localPath,
    };
  } else {
    const html = buffer.toString("utf8");
    document = extractHtmlDocument(url, html, contentType, ref);
  }

  await writeCacheJson(cacheKey, document);
  state.opened.set(url, document);
  state.opened.set(ref, document);
  return document;
}

function extractHtmlDocument(url, html, contentType = "text/html", ref = null) {
  const title = decodeEntities(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) || url;
  const description =
    decodeEntities(firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)) ||
    "";
  const links = extractLinks(url, html);
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = compactBlankLines(decodeEntities(body)).slice(0, maxPageTextChars);
  return {
    ref: ref || storeRef({ title, url, snippet: description, source: "open" }),
    kind: "html",
    url,
    title,
    contentType,
    summary: description,
    text,
    links,
  };
}

function extractLinks(baseUrl, html) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(match[1]);
    const text = compactWhitespace(decodeEntities(match[2].replace(/<[^>]+>/g, " ")));
    try {
      links.push({ url: new URL(href, baseUrl).toString(), text });
    } catch {
      // Ignore malformed href values.
    }
  }
  return dedupeLinks(links).slice(0, 100);
}

async function extractPdfText(localPath) {
  if (commandAvailable("pdftotext")) {
    const result = await runCommand("pdftotext", ["-layout", localPath, "-"], config.timeoutMs);
    if (result.status === 0 && result.stdout.trim()) return result.stdout;
  }
  if (pythonModuleAvailable("pypdf")) {
    const script =
      "import sys\nfrom pypdf import PdfReader\nreader = PdfReader(sys.argv[1])\nprint('\\n\\n'.join((p.extract_text() or '') for p in reader.pages))\n";
    const result = await runCommand(pythonCommand(), ["-c", script, localPath], config.timeoutMs);
    if (result.status === 0 && result.stdout.trim()) return result.stdout;
  }
  return "";
}

async function renderPdfPage(localPath, pageIndex) {
  if (!commandAvailable("pdftoppm")) return null;
  const outBase = join(config.cacheDir, `pdf-page-${hash(`${localPath}:${pageIndex}`)}`);
  const result = await runCommand(
    "pdftoppm",
    ["-png", "-f", String(pageIndex + 1), "-singlefile", localPath, outBase],
    config.timeoutMs,
  );
  if (result.status === 0) return `${outBase}.png`;
  return null;
}

async function capturePageScreenshot(url) {
  if (!moduleResolvable("playwright")) return null;
  const out = join(config.cacheDir, `page-${hash(url)}.png`);
  const script = `
    const { chromium } = require("playwright");
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
      await page.goto(process.argv[1], { waitUntil: "networkidle", timeout: ${config.timeoutMs} });
      await page.screenshot({ path: process.argv[2], fullPage: true });
      await browser.close();
    })().catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
  `;
  const result = await runCommand(process.execPath, ["-e", script, url, out], config.timeoutMs + 5000);
  return result.status === 0 ? out : null;
}

function freeLookupFallbacks(commands) {
  const sections = [];
  if (commands.time?.length) {
    sections.push(
      [
        "## Time",
        ...commands.time.map((item) => {
          const date = new Date();
          return `${item.utc_offset}: ${date.toISOString()} UTC reference`;
        }),
      ].join("\n"),
    );
  }
  const searchLike = [];
  for (const item of commands.finance || []) {
    searchLike.push(`${item.ticker} ${item.type || ""} quote ${item.market || ""}`.trim());
  }
  for (const item of commands.weather || []) {
    searchLike.push(`weather forecast ${item.location} ${item.start || ""}`.trim());
  }
  for (const item of commands.sports || []) {
    searchLike.push(`${item.league} ${item.team || ""} ${item.fn || item.function || ""} schedule standings`.trim());
  }
  if (searchLike.length) {
    sections.push(
      [
        "## Routed Free Lookup",
        "Finance, weather, and sports provider-specific APIs are not hardwired yet. Ask web_search.search_query with these generated queries for free backend lookup:",
        ...searchLike.map((q) => `- ${q}`),
      ].join("\n"),
    );
  }
  return sections;
}

function shouldRunScholarly(q) {
  return /\b(arxiv|paper|papers|scholar|scholarly|doi|pubmed|journal|preprint|study|studies|theorem|lemma|proof|biology|medicine|clinical|trial)\b/i.test(
    q,
  );
}

function applyDomainFilters(q, domains) {
  if (!Array.isArray(domains) || !domains.length) return q;
  return `${q} ${domains.map((domain) => `site:${domain}`).join(" OR ")}`;
}

function recencyToSearxngRange(recency) {
  if (!recency) return null;
  if (recency <= 1) return "day";
  if (recency <= 31) return "month";
  return "year";
}

function resolveRef(refId) {
  if (!refId) return null;
  if (/^https?:\/\//i.test(refId)) return { url: refId };
  return state.refs.get(refId) || null;
}

function storeRef(result) {
  const existing = [...state.refs.entries()].find(([, value]) => value.url === result.url);
  if (existing) return existing[0];
  const ref = `u${state.nextRef++}`;
  state.refs.set(ref, result);
  return ref;
}

function dedupeResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    const key = normalizeUrlKey(result.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function sortResultsForQuery(results, q) {
  return [...results].sort((left, right) => scoreResult(right, q) - scoreResult(left, q));
}

function scoreResult(result, q) {
  const tokens = queryTokens(q);
  const title = String(result.title || "").toLowerCase();
  const snippet = String(result.snippet || "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 4;
    if (snippet.includes(token)) score += 1;
  }
  if (/withdrawn|plagiarized|fictitious|administratively withdrawn/i.test(`${title} ${snippet}`)) {
    score -= 6;
  }
  return score;
}

function queryTokens(q) {
  return String(q || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 2 && !["site", "http", "https", "www", "arxiv", "paper"].includes(token));
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    const key = normalizeUrlKey(link.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeUrlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url || "";
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/json",
      "user-agent": config.userAgent,
    },
  });
  if (!response.ok) {
    throw new Error(`${url.hostname} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
      "user-agent": config.userAgent,
    },
  });
  if (!response.ok) {
    throw new Error(`${url.hostname} returned ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function searchResponse(output) {
  return { encrypted_output: null, output };
}

function outputBudget(responseLength, maxOutputTokens) {
  const byLength = { short: 5000, medium: 14000, long: 32000 };
  const requested = byLength[String(responseLength || "medium").toLowerCase()] || byLength.medium;
  if (maxOutputTokens) {
    return Math.max(2000, Math.min(maxOutputChars, Number(maxOutputTokens) * 4));
  }
  return Math.min(maxOutputChars, requested);
}

function formatDiagnostics(diagnostics) {
  return [
    "## Backend Diagnostics",
    ...diagnostics
      .filter(Boolean)
      .slice(0, 20)
      .map((item) => `- ${item}`),
  ].join("\n");
}

function findMatches(text, pattern, maxMatches) {
  const haystack = text.split(/\r?\n/);
  const needle = pattern.toLowerCase();
  const matches = [];
  for (let index = 0; index < haystack.length; index += 1) {
    const line = haystack[index];
    if (line.toLowerCase().includes(needle)) {
      matches.push({ line: index + 1, excerpt: compactWhitespace(line).slice(0, 700) });
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}

function excerptAroundLine(text, lineNumber) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, lineNumber - 4);
  const end = Math.min(lines.length, lineNumber + 3);
  return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n");
}

function numberLines(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

function limitText(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Truncated by local-searchd at ${limit} characters.]`;
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function compactBlankLines(text) {
  return String(text || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean)
    .join("\n");
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : "";
}

function firstXml(text, tag) {
  return firstMatch(text, new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
}

function cleanXml(text) {
  return compactWhitespace(decodeEntities(String(text || "").replace(/<[^>]+>/g, " ")));
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function cacheName(kind, value) {
  return `${kind}-${hash(JSON.stringify(value))}.json`;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function readCacheJson(name) {
  try {
    const text = await readFile(join(config.cacheDir, name), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeCacheJson(name, value) {
  mkdirSync(config.cacheDir, { recursive: true });
  await writeFile(join(config.cacheDir, name), JSON.stringify(value, null, 2));
}

async function writeCachedBlob(url, buffer, extension) {
  mkdirSync(config.cacheDir, { recursive: true });
  const path = join(config.cacheDir, `${hash(url)}${extension}`);
  await writeFile(path, buffer);
  return path;
}

function commandAvailable(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function pythonCommand() {
  const configured = process.env.LOCAL_SEARCHD_PYTHON;
  if (configured && existsSync(configured)) return configured;
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && localAppData) {
    const candidates = [
      join(localAppData, "Programs", "Python", "Python313", "python.exe"),
      join(localAppData, "Programs", "Python", "Python312", "python.exe"),
      join(localAppData, "Programs", "Python", "Python311", "python.exe"),
    ];
    const candidate = candidates.find((path) => existsSync(path));
    if (candidate) return candidate;
  }
  if (commandAvailable("python3")) return "python3";
  if (commandAvailable("python")) return "python";
  return "python";
}

function pythonModuleAvailable(moduleName) {
  const command = pythonCommand();
  const result = spawnSync(command, ["-c", `import ${moduleName}`], { stdio: "ignore" });
  return result.status === 0;
}

function moduleResolvable(moduleName) {
  const result = spawnSync(process.execPath, ["-e", `require.resolve(${JSON.stringify(moduleName)})`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: err.message });
    });
  });
}

async function runSmoke() {
  const checks = [];
  const commands = normalizeCommands({ q: "sunflower conjecture arxiv" });
  assert(commands.search_query[0].q === "sunflower conjecture arxiv", "q shorthand normalizes");
  checks.push("q shorthand normalizes");

  const inferred = inferQueryFromRequest({
    input:
      "Use Codex web search for this benchmark. Search for an official OpenAI Codex documentation page that discusses web search or internet access. Return exactly four bullets.",
  });
  assert(
    inferred === "an official OpenAI Codex documentation page that discusses web search or internet access",
    "empty-call query inference works",
  );
  checks.push("empty-call query inference works");

  const html = `<!doctype html><html><head><title>Example Page</title><meta name="description" content="A tiny test page"></head><body><h1>Hello</h1><p>Find me here.</p><a href="/next">Next page</a></body></html>`;
  const doc = extractHtmlDocument("https://example.test/root", html, "text/html", "test");
  assert(doc.title === "Example Page", "html title extracts");
  assert(doc.links[0].url === "https://example.test/next", "relative links resolve");
  assert(findMatches(doc.text, "find me", 2).length === 1, "find works");
  checks.push("html title extracts");
  checks.push("relative links resolve");
  checks.push("find works");

  const ddgsRows = mapDdgsPythonRows(
    [{ title: "Example", href: "https://example.test", body: "Example snippet" }],
    "general",
  );
  assert(ddgsRows[0].url === "https://example.test", "ddgs text mapping works");
  checks.push("ddgs text mapping works");

  const tempDir = await mkdtemp(join(tmpdir(), "local-searchd-smoke-"));
  try {
    const oldCache = config.cacheDir;
    config.cacheDir = tempDir;
    await writeCacheJson("smoke.json", { ok: true });
    const cached = await readCacheJson("smoke.json");
    assert(cached.ok === true, "cache roundtrip works");
    checks.push("cache roundtrip works");
    config.cacheDir = oldCache;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ status: "ok", checks, health: healthPayload() }, null, 2));
}

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke check failed: ${message}`);
}
