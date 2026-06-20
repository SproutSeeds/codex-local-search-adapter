# Issue 28954 Update Packet

Draft comment for `openai/codex#28954`:

```md
Follow-up after building and verifying a local workaround.

I split the practical workaround out from the upstream capability-gating patch:

- Upstream capability-gating patch branch:
  https://github.com/SproutSeeds/codex/tree/cody/oss-web-search-28954
- Upstream compare:
  https://github.com/openai/codex/compare/main...SproutSeeds:codex:cody/oss-web-search-28954
- Local/free search reference adapter:
  https://github.com/SproutSeeds/codex-local-search-adapter

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

So this issue still looks like a real native hosted-tool capability/routing
boundary for OSS/local providers. The reference adapter is not meant as the
core upstream fix; it is a working local/free workaround and a concrete design
point for anyone who wants local models to search while the upstream behavior is
decided.
```
