# Hypit MCP server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude (claude.ai,
Claude Code, the desktop and mobile apps) drive [Hypit](../README.md) on a hosted machine. It wraps the
vendored Hypit Distribution in this repository: the `hypit` CLI, project files, background jobs and the
Hypit Skill's documentation.

The server speaks stateless Streamable HTTP at `/mcp`. Every request needs the shared token.

## Tools

| Tool | What it does |
| --- | --- |
| `hypit_docs` | Reads the Hypit Skill (SKILL.md), its references, package READMEs and examples. Call it first. |
| `project_list` / `project_create` | Lists projects, or creates one with `runtime init` and a Profile adapted to the server. |
| `hypit` | Runs `hypit <args>` from a project root, in the foreground or as a background job. |
| `run_command` | Runs a bash command in a project, for npm installs, component builds, ffmpeg and so on. |
| `job_status` / `job_stop` | Follows or stops background jobs. |
| `file_list` / `file_read` / `file_write` / `file_delete` | Works with project files. Images come back as images. |
| `file_fetch` | Downloads a direct URL into a project. |
| `file_link` | Makes a signed download link for a result, or an upload link plus curl command for a local file. |

There is also a `hypit` prompt. In Claude Code it appears as `/mcp__hypit__hypit` and loads the Skill
plus notes on how its local-shell steps map onto these tools.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | required | Shared secret, at least 24 characters. Clients send it as `Authorization: Bearer <token>` or in the path as `/mcp/<token>`. |
| `OPENROUTER_API_KEY` | unset | OpenRouter API key. New projects route Seedance, Grok Imagine, MiniMax H3, GPT Image 2 and Nano Banana through `@hypit/provider-openrouter`. |
| `OPENROUTER_GPT_IMAGE_QUALITY` | `medium` | `auto`, `low`, `medium` or `high` for GPT Image 2 through OpenRouter. It sets that model's price. |
| `HYPIT_HUB_API_KEY` | unset | HypiHub API key, for voices, hosted alignment, matting and models OpenRouter lacks. |
| `HYPIT_RENDER_WORKERS` | unset | Browser workers for local HTML rendering in new projects. Match it to the machine size. |
| `PUBLIC_BASE_URL` | Railway domain | Base URL used in signed file links and for staged OpenRouter references. |
| `OPENROUTER_JOB_LEDGER` | `/data/openrouter-jobs.json` | Shared record of submitted OpenRouter video jobs; `project_create` points every project's OpenRouter Endpoint at it so rebuilds reuse jobs instead of paying again. |
| `HYPIT_STAGING_DIR`, `HYPIT_STAGING_MAX_AGE_HOURS` | `/data/staged`, `24` | Audio and video references the OpenRouter Provider publishes at `GET /staged/<random name>` (no token; names carry 128 random bits) and the age after which they are deleted. |
| `MCP_SIGNING_SECRET` | the auth token | Separate key for signed links, if you want to rotate them independently. |
| `MCP_ENABLE_SHELL` | `1` | Set to `0` to remove `run_command`. Component authoring needs it. |
| `MCP_DEFAULT_TIMEOUT_SECONDS` / `MCP_MAX_TIMEOUT_SECONDS` | `120` / `600` | Foreground command limits. Longer work runs as a background job. |
| `MCP_MAX_UPLOAD_MB` | `4096` | Size limit for uploads and `file_fetch`. |
| `HYPIT_WORKSPACE`, `HYPIT_JOBS_DIR`, `HOME` | `/data/...` | Projects, job logs, and Hypit's prepared tools and caches. Keep `/data` on a volume. |

Any other API key you add as a variable is visible to Hypit. Reference it from a project's Profile
with `{"store": "env", "key": "VARIABLE_NAME"}`.

## Connect a client

**claude.ai, the Claude apps and Claude Code on the web.** Add a custom connector at
<https://claude.ai/customize/connectors> with the URL `https://<your-domain>/mcp/<MCP_AUTH_TOKEN>`.
Connectors load when a session starts, so open a new chat or session afterwards.

**Claude Code CLI.**

```bash
claude mcp add --transport http hypit https://<your-domain>/mcp \
  --header "Authorization: Bearer $HYPIT_MCP_TOKEN"
```

The repository's `.mcp.json` does the same for anyone who opens this repo in Claude Code with
`HYPIT_MCP_TOKEN` set in their environment.

## Develop locally

```bash
pnpm install --frozen-lockfile && pnpm build:public-types   # from the repository root
cd mcp-server && npm ci && npm run build && npm test
MCP_AUTH_TOKEN=dev-token-0123456789abcdefghij HYPIT_WORKSPACE=/tmp/hypit-projects npm start
MCP_AUTH_TOKEN=dev-token-0123456789abcdefghij node scripts/smoke.mjs http://127.0.0.1:8080
```

## Security and licensing

- The token grants shell access to the server, so treat it like an SSH key. Rotate it by changing
  the variable; signed links made with the old token stop working.
- Signed file links are scoped to one file, one method and an expiry time.
- Hypit's [license](../LICENSE) allows running it on your own infrastructure for your own organization.
  Keep this deployment single-tenant: do not offer it to third parties as a hosted service without a
  commercial license from Hypit.AI.
