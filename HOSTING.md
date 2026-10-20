# 2Hype: hosted Hypit with an MCP server

This repository is a copy of [hypit-ai/hypit](https://github.com/hypit-ai/hypit) with a remote MCP
server added, so Claude can produce Hypit videos on a hosted machine instead of a local one.

| Upstream | Value |
| --- | --- |
| Repository | https://github.com/hypit-ai/hypit |
| Commit | `0d36de9a9d17562fca0e478969b80eb1c16a7693` |
| Version | `@hypit/hypit` 0.3.1 |

## What this fork adds

- `mcp-server/` is the MCP server. Its [README](mcp-server/README.md) lists the tools and settings.
- `packages/provider-openrouter/` is a Hypit Provider for OpenRouter's video and image APIs. It is a
  default Distribution package, so projects can select it without installing anything. Its
  [README](packages/provider-openrouter/README.md) lists the models, settings and limits.
- `Dockerfile` and `railway.json` build one image with Hypit, FFmpeg, uv, Chrome dependencies and
  the MCP server, ready for Railway.
- `.mcp.json` registers the hosted server for Claude Code sessions opened in this repository.
- `.github/workflows/mcp-server.yml` type-checks, builds and tests the server.
- The upstream `sync-hypihub-docs` workflow is removed, since it pushes to Hypit's docs site.

Outside those, the only upstream files touched are the two manifests that register the OpenRouter
package, `package.json` and `packages/video/package.json`, plus `pnpm-lock.yaml`.

## Current deployment

| Item | Value |
| --- | --- |
| Railway project | `2hype-hypit`, service `hypit-mcp`, volume `hypit-data` at `/data` |
| Public URL | https://hypit-mcp-production.up.railway.app |
| MCP endpoint | `https://hypit-mcp-production.up.railway.app/mcp` |
| Token | The `MCP_AUTH_TOKEN` variable on the service in Railway |

## Deploy on Railway

1. Create a service from this GitHub repository. Railway reads `railway.json` and builds the Dockerfile.
2. Attach a volume at `/data`. Projects, renders, the managed Chrome and Python helpers live there.
3. Set the variables below, then generate a public domain.
4. Check `https://<domain>/healthz`, then connect a client as described in the server README.

| Variable | Value |
| --- | --- |
| `MCP_AUTH_TOKEN` | A long random string, e.g. from `openssl rand -hex 32` |
| `OPENROUTER_API_KEY` | Your OpenRouter API key, for Seedance, Grok Imagine, MiniMax H3, GPT Image 2 and Nano Banana |
| `OPENROUTER_GPT_IMAGE_QUALITY` | Optional: `low`, `medium` (default) or `high` for GPT Image 2 |
| `HYPIT_HUB_API_KEY` | Your HypiHub API key, if you also use HypiHub for voices, alignment or matting |
| `HYPIT_RENDER_WORKERS` | Chrome workers per render, e.g. `2` on a small instance |

Rendering runs headless Chrome and FFmpeg, so give the service at least 2 vCPU and 4 GB of memory.

## Update from upstream

```bash
git remote add upstream https://github.com/hypit-ai/hypit.git
git fetch upstream
git merge upstream/main
```

The fork's own files sit outside upstream's tree, so merges rarely conflict. Update the commit in
the table above after each merge.

## License

Hypit is released under the [Hypit Open Source License](LICENSE). It allows running Hypit on your own
infrastructure for your own organization. It does not allow offering it to other parties as a
multi-tenant or hosted service without a commercial license. Keep this deployment single-tenant.
