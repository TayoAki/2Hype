/** Guidance that maps the Hypit Skill's local-machine assumptions onto this remote server. */
export const REMOTE_NOTES = `# Using Hypit through the remote MCP server

Hypit, its executable and every video project live on this server, not on the user's machine.
The Hypit Skill was written for an agent with a local shell; here is how its steps map to tools.

- **Read the Skill first.** Call \`hypit_docs\` with no path for SKILL.md, then open the references
  it points to (for example \`references/production/source-syntax.md\`) before authoring.
- **Commands.** Run CLI steps with the \`hypit\` tool, passing arguments as a list. For anything else
  (npm install, tsc, ffmpeg, git) use \`run_command\`; \`hypit\` is also on PATH there.
- **Projects.** Create one with \`project_create\`; it writes package.json and a Runtime Profile.
  Every file tool and command takes the project name and runs from the project root.
- **Files.** Use \`file_list\`, \`file_read\`, \`file_write\` and \`file_delete\`. \`file_read\` returns
  PNG, JPEG, WebP and GIF files as images, so you can look at frames, tiles and snapshots.
- **Getting media in.** \`file_fetch\` downloads a direct URL. For TikTok, YouTube, Instagram and
  similar pages run \`hypit download prepare\` once, then \`hypit download <url> --to <path>\`.
  For a file on the user's computer, call \`file_link\` with mode "upload" and give them the curl command.
- **Getting results out.** Export with \`hypit get <build-id> --output <name> --to exports/<file>\`,
  then call \`file_link\` for a download URL the user can open.
- **Long work.** Pass \`background: true\` to \`hypit\` or \`run_command\` and poll \`job_status\`.
  Submit Builds without \`--follow\`, then poll \`hypit status <build-id> --json\`.
- **Model services.** When OPENROUTER_API_KEY is set, \`project_create\` binds Seedance, Grok Imagine,
  MiniMax H3, GPT Image 2 and Nano Banana to the \`openrouter.default\` Endpoint. Read its limits
  with \`hypit_docs\` path \`@hypit/provider-openrouter\`.
  HypiHub remains the route for voice design, voice clone, hosted alignment and matting.
  Run \`hypit pricing <run>\` before paid work and tell the user the expected cost.
- **Supplied images.** Images the user made elsewhere, for example by hand in ChatGPT, are ordinary
  assets: give them a \`file_link\` upload command, then reference the file with \`media:Image\`.
- **Credentials.** Never ask the user to paste a secret into chat. API keys are Railway service
  variables on this server, such as OPENROUTER_API_KEY or HYPIT_HUB_API_KEY. A Profile references one with
  {"store": "env", "key": "VARIABLE_NAME"} through the "env" credential store. Browser OAuth
  login cannot complete on the server; ask the user to add the variable in Railway instead.
- **Studio and snapshots.** Start Studio as a background job, for example
  \`hypit studio --run <run> --port 4173\`, then capture frames with
  \`hypit snapshot --studio http://127.0.0.1:4173 ...\` and read the PNGs. Studio is not exposed publicly.
- **Resources.** The server has limited CPU and memory. Keep HTML renderer workers modest and
  prefer hosted alignment over local WhisperX unless the user asks for local models.
`;
