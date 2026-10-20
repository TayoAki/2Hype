import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Capabilities served by `@hypit/provider-openrouter` (see packages/provider-openrouter/src/models.ts).
 * When the server has an OpenRouter key, new projects bind these to OpenRouter, which is cheaper
 * than HypiHub for them. HypiHub keeps the capabilities OpenRouter lacks: voices and alignment.
 */
export const OPENROUTER_CAPABILITIES = [
  "@hypit/seedance@1#seedance-2",
  "@hypit/seedance@1#seedance-2-fast",
  "@hypit/seedance@1#seedance-2-mini",
  "@hypit/seedance@1#seedance-2.5",
  "@hypit/grok-imagine@1#grok-imagine-video",
  "@hypit/grok-imagine@1#grok-imagine-video-1.5-preview",
  "@hypit/minimax-h3@1#minimax-h3",
  "@hypit/gpt-image@1#gpt-image-2",
  "@hypit/nano-banana@1#nano-banana-2",
  "@hypit/nano-banana@1#nano-banana-pro",
] as const;

const GPT_IMAGE_QUALITIES = ["auto", "low", "medium", "high"];

type ProfileOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly renderWorkers?: number | undefined;
  /** Where OpenRouter can fetch audio and video references: a directory this server serves at `baseUrl`. */
  readonly staging?: { readonly directory: string; readonly baseUrl: string } | undefined;
};

/** Adapt a freshly initialised (or existing) Runtime Profile to this server. Returns notes for the agent. */
export async function adaptProfile(dir: string, options: ProfileOptions): Promise<string[]> {
  const profilePath = join(dir, "hypit.runtime.json");
  if (!existsSync(profilePath)) return ["No hypit.runtime.json was written; inspect the init output."];
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const notes: string[] = [];
  profile.credentials ??= {};
  profile.endpoints ??= {};
  if (!profile.credentials.env) {
    profile.credentials.env = { use: "@hypit/credential-store-env" };
    notes.push('Added the "env" credential store so Endpoints can read Railway variables.');
  }

  const hub = profile.endpoints["hypihub.default"];
  if (hub && options.env.HYPIT_HUB_API_KEY) {
    hub.config ??= {};
    hub.config.apiKey = { store: "env", key: "HYPIT_HUB_API_KEY" };
    notes.push("hypihub.default reads its API key from the HYPIT_HUB_API_KEY variable.");
  } else if (hub) {
    notes.push("HYPIT_HUB_API_KEY is not set, so hypihub.default still points at the local store. HypiHub is only needed for voice design, voice clone, hosted alignment, matting and models OpenRouter lacks.");
  }

  if (options.env.OPENROUTER_API_KEY) {
    if (!profile.endpoints["openrouter.default"]) {
      const quality = options.env.OPENROUTER_GPT_IMAGE_QUALITY;
      profile.endpoints["openrouter.default"] = {
        use: "@hypit/provider-openrouter",
        pool: "openrouter.default",
        config: {
          apiKey: { store: "env", key: "OPENROUTER_API_KEY" },
          ...(quality && GPT_IMAGE_QUALITIES.includes(quality) ? { gptImageQuality: quality } : {}),
        },
      };
    }
    const openRouter = profile.endpoints["openrouter.default"];
    if (openRouter?.use === "@hypit/provider-openrouter" && options.staging?.baseUrl.startsWith("https://")) {
      openRouter.config ??= {};
      if (openRouter.config.stagingDirectory === undefined && openRouter.config.stagingBaseUrl === undefined) {
        openRouter.config.stagingDirectory = options.staging.directory;
        openRouter.config.stagingBaseUrl = options.staging.baseUrl;
        notes.push("openrouter.default publishes audio and video references at this server's /staged URL, because OpenRouter fetches them by HTTPS.");
      }
    } else if (openRouter?.config?.stagingBaseUrl === undefined) {
      notes.push("This server has no public HTTPS address, so openrouter.default refuses audio and video references. Set PUBLIC_BASE_URL and rerun project_create.");
    }
    profile.bindings ??= {};
    const bound: string[] = [];
    for (const capability of OPENROUTER_CAPABILITIES) {
      if (profile.bindings[capability] === undefined) {
        profile.bindings[capability] = "openrouter.default";
        bound.push(capability.split("#")[1]!);
      }
    }
    notes.push(`openrouter.default reads OPENROUTER_API_KEY and is bound for ${bound.length > 0 ? bound.join(", ") : "nothing new (existing bindings kept)"}.`);
  } else {
    notes.push("OPENROUTER_API_KEY is not set. Add it in Railway to route Seedance, Grok Imagine, MiniMax H3, GPT Image 2 and Nano Banana through OpenRouter, then rerun project_create.");
  }

  const html = profile.endpoints["html.local"];
  if (html && options.renderWorkers) {
    html.config ??= {};
    html.config.workers ??= options.renderWorkers;
    html.config.browserCapacity ??= options.renderWorkers;
    notes.push(`html.local renders with ${options.renderWorkers} browser workers (HYPIT_RENDER_WORKERS).`);
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  return notes;
}
