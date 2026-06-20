Follow-up after building and verifying a local workaround.

I published the working local/free search adapter here:

https://github.com/SproutSeeds/codex-local-search-adapter

This is separate from the conservative upstream capability-gating patch:

- Branch: https://github.com/SproutSeeds/codex/tree/cody/oss-web-search-28954
- Compare: https://github.com/openai/codex/compare/main...SproutSeeds:codex:cody/oss-web-search-28954

Current read after testing:

1. Native hosted `web_search`
   - OSS/local providers should either not be offered hosted `web_search`, or
     Codex needs a local/provider adapter that can service it.
   - The branch above takes the conservative capability-gating path.

2. Local/free search for OSS models
   - The standalone adapter uses a localhost search broker plus CLI/MCP bridge.
   - On Codex 0.141.0, hosted Codex paths can call the MCP bridge, but
     `--oss --local-provider ollama` can still reject MCP-shaped calls as
     `unsupported call: mcp__...`.
   - The reliable route today is:

     local model -> Codex `shell_command` -> local search CLI -> local broker

Verified local canary:

- A local `qwen3-coder:30b` Codex run invoked the shell command fallback.
- The command returned a current/public search result.
- No ChatGPT auth or hosted OpenAI web-search tool was required.

The reference adapter repo itself was also checked with:

- `npm run check`
- `npm run smoke`
- `LOCAL_SEARCH_CLI_URL=http://127.0.0.1:8877 ./bin/codex-local-search health`
- `LOCAL_SEARCH_CLI_URL=http://127.0.0.1:8878 ./bin/codex-local-search search --response-length short --max-output-tokens 800 sunflower conjecture arxiv`

So this issue still looks like a real native hosted-tool capability/routing
boundary for OSS/local providers. The reference adapter is not meant as the
core upstream fix; it is a working local/free workaround and a concrete design
point for anyone who wants local models to search while the upstream behavior is
decided.
