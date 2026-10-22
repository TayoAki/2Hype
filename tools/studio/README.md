# Remake Studio

Upload a reference advert, see it cut into shots, and remake it shot by shot with your own brand: the stills come
first and are checked against the reference, then each approved still is animated with Seedance and the shots are
strung together on the reference's timeline, side by side with it. Nothing from the reference is ever used to
generate: it is measured (shot timing, framing, head counts, repeated setups, voice structure) and only those
measurements shape our version.

One engine (`engine.mjs`) runs every step; three ways drive it:

| Where | How |
| --- | --- |
| Web app | `https://<server>/studio` on the hosted MCP server (sign in with the server's `MCP_AUTH_TOKEN`) |
| Chat or a claude.ai artifact | the server's `studio_*` MCP tools (the connector at `https://<server>/mcp/<token>`, named "Remake Studio" for the artifact page) |
| Shell | `node tools/studio/cli.mjs <projects dir> ...` |

## Steps

| Step | What it does | Rough cost |
| --- | --- | --- |
| analyze | Cuts the reference into shots, labels each one, measures timing, voice and music (`shot-list.mjs`) | about 2¢ a shot |
| draft | Writes our version of every shot, our cast, our sets and our voice lines from the brief (Claude through OpenRouter) | about 25¢ |
| cast | One character sheet per character, a world image and the app screens (GPT Image 2) | about 5¢ an image |
| plates | One empty-set still per setup the reference returns to (`keyframes.mjs plates`) | about 5¢ a setup |
| stills | Each shot's opening still on its plate; screen close-ups get the app laid on and a last frame (`keyframes.mjs stills`, `screens`) | about 5¢ a shot |
| check | Every still against its reference shot: people, framing, setting, props, cast, set (`keyframes.mjs check`) | about 4¢ |
| animate | One Seedance clip per shot from its still, at the model chosen per shot, cut into its slot (`keyframes.mjs frames`, `assemble.mjs`) | 7.6¢ (Mini) to 37¢ (full 1080p) a second, 4 s minimum a shot |
| soundtrack | Our voice lines on the reference's phrase timings, music at its tempo (`soundtrack.mjs`) | about 10¢ |
| final | Every slot strung together on the reference's timeline (a shot not animated yet holds its still) | free |
| compare | The cut against the reference, led by the format-critical score (`shot-list.mjs --compare`) | about 5¢ |

`all` runs draft to check, `images` runs plates, stills and check, `video` runs animate, soundtrack and final.
`stills` and `animate` take `only` (shot numbers) to redo single shots, and a run can name its own list of steps
(`["animate", "final"]` animates one shot and restrings the cut).

## Projects

Each project is a folder under the studio root (`/data/studio` on the server): `project.json` (state, brief,
decisions, costs), `reference/`, `analysis/` (from `shot-list.mjs`), `template.json` (the filled template every tool
reads), `cast/`, `screens/`, `stills/` (plates, opening and last frames, `check.json`), `takes/` and `slots/` (clips),
`audio/`, `final/` and `logs/<step>.log`. It is also a Hypit project (its own `hypit.runtime.json` binds GPT Image 2
and Seedance to OpenRouter).
