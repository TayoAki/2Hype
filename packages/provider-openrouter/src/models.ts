import type { CapabilityRef, ModuleRef } from "@hypit/hypit/protocol";
import type { GenerationWireMapping } from "@hypit/generation";

/**
 * Hypit Capabilities this Provider serves through OpenRouter, with the limits OpenRouter publishes
 * for each model in `GET /videos/models` and `GET /images/models`. The mappings compile a request
 * into flat intermediate fields; `provider.ts` turns those into OpenRouter's request body.
 *
 * Values are OpenRouter's own spellings. Where a Hypit Model admits something OpenRouter does not
 * list, the Provider refuses the request with a reason instead of narrowing it silently.
 */

const SEEDANCE: ModuleRef = { name: "@hypit/seedance", version: "1" };
const GROK: ModuleRef = { name: "@hypit/grok-imagine", version: "1" };
const MINIMAX: ModuleRef = { name: "@hypit/minimax-h3", version: "1" };
const GPT_IMAGE: ModuleRef = { name: "@hypit/gpt-image", version: "1" };
const NANO_BANANA: ModuleRef = { name: "@hypit/nano-banana", version: "1" };

export type ReferenceKind = "image" | "video" | "audio";
export type FrameKind = "first_frame" | "last_frame";

export type OpenRouterVideoModel = {
  readonly kind: "video";
  readonly mapping: GenerationWireMapping;
  /** OpenRouter model slug. */
  readonly model: string;
  /** Hypit resolution value → OpenRouter resolution value. Absent keys are unsupported. */
  readonly resolutions: Readonly<Record<string, string>>;
  /** Sent when the Model's resolution port is optional and the author omitted it. */
  readonly defaultResolution?: string;
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly aspectRatios: readonly string[];
  readonly frames: readonly FrameKind[];
  /** Reference kinds OpenRouter forwards to this model. Others would be silently ignored upstream. */
  readonly references: readonly ReferenceKind[];
};

export type OpenRouterImageModel = {
  readonly kind: "image";
  readonly mapping: GenerationWireMapping;
  readonly model: string;
  /** Hypit resolution value → OpenRouter resolution value, or `null` to send no resolution field. */
  readonly resolutions: Readonly<Record<string, string | null>>;
  readonly aspectRatios: readonly string[];
  readonly backgrounds: readonly string[];
  /** Output formats this route returns, as Hypit spells them. Empty when the Model has no such port. */
  readonly outputFormats: readonly string[];
  readonly maxReferences: number;
  /** Whether OpenRouter documents a `quality` parameter for this model. */
  readonly quality: boolean;
};

export type OpenRouterModel = OpenRouterVideoModel | OpenRouterImageModel;

const SEEDANCE_RATIOS = ["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"] as const;
const GROK_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] as const;

function seedance(name: string, model: string, resolutions: Readonly<Record<string, string>>, maxSeconds = 15,
  aspectRatios: readonly string[] = SEEDANCE_RATIOS): OpenRouterVideoModel {
  return {
    kind: "video", model, resolutions, minSeconds: 4, maxSeconds, aspectRatios,
    frames: ["first_frame", "last_frame"], references: ["image", "video", "audio"],
    mapping: {
      capability: { module: SEEDANCE, name }, result: "video", routes: [{ model }],
      fields: {
        prompt: { as: "value", field: "prompt" },
        duration: { as: "value", field: "duration" },
        resolution: { as: "value", field: "resolution" },
        aspectRatio: { as: "value", field: "aspect_ratio" },
        generateAudio: { as: "value", field: "generate_audio" },
        webSearch: { as: "value", field: "web_search" },
        firstFrame: { as: "url", field: "first_frame", resourceFields: ["personReference"] },
        lastFrame: { as: "url", field: "last_frame", resourceFields: ["personReference"] },
        referenceImage: { as: "urlArray", field: "reference_images", resourceFields: ["personReference"] },
        referenceVideo: { as: "urlArray", field: "reference_videos", resourceFields: ["personReference"] },
        referenceAudio: { as: "urlArray", field: "reference_audios" },
      },
    },
  };
}

function grok(name: string, model: string, resolutions: Readonly<Record<string, string>>): OpenRouterVideoModel {
  return {
    kind: "video", model, resolutions, minSeconds: 1, maxSeconds: 15, aspectRatios: GROK_RATIOS,
    frames: [], references: ["image"],
    mapping: {
      capability: { module: GROK, name }, result: "video", routes: [{ model }],
      fields: {
        prompt: { as: "value", field: "prompt" },
        duration: { as: "value", field: "duration" },
        resolution: { as: "value", field: "resolution" },
        aspectRatio: { as: "value", field: "aspect_ratio" },
        images: { as: "urlArray", field: "reference_images" },
      },
    },
  };
}

function nanoBanana(name: string, model: string, aspectRatios: readonly string[]): OpenRouterImageModel {
  return {
    kind: "image", model, aspectRatios, resolutions: { "1K": "1K", "2K": "2K", "4K": "4K" },
    backgrounds: [], outputFormats: ["png"], maxReferences: 14, quality: false,
    mapping: {
      capability: { module: NANO_BANANA, name }, result: "image", routes: [{ model }],
      fields: {
        prompt: { as: "value", field: "prompt" },
        aspectRatio: { as: "value", field: "aspect_ratio" },
        resolution: { as: "value", field: "resolution" },
        outputFormat: { as: "value", field: "output_format" },
        images: { as: "urlArray", field: "reference_images" },
      },
    },
  };
}

export const openRouterModels: readonly OpenRouterModel[] = [
  seedance("seedance-2", "bytedance/seedance-2.0", { "480p": "480p", "720p": "720p", "1080p": "1080p", "4k": "4K" }),
  seedance("seedance-2-fast", "bytedance/seedance-2.0-fast", { "480p": "480p", "720p": "720p" }),
  seedance("seedance-2-mini", "bytedance/seedance-2.0-mini", { "480p": "480p", "720p": "720p" }),
  seedance("seedance-2.5", "bytedance/seedance-2.5", { "480p": "480p", "720p": "720p" }, 30,
    ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
  grok("grok-imagine-video", "x-ai/grok-imagine-video", { "480p": "480p", "720p": "720p" }),
  // Following the Distribution's BeatAPI Provider, the 1.5 preview Capability is served by the
  // published Grok Imagine Video 1.5 model.
  grok("grok-imagine-video-1.5-preview", "x-ai/grok-imagine-video-1.5", { "480p": "480p", "720p": "720p", "1080p": "1080p" }),
  {
    kind: "video", model: "minimax/hailuo-3", resolutions: { "2K": "2K" }, defaultResolution: "2K",
    minSeconds: 5, maxSeconds: 15, aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    frames: ["first_frame", "last_frame"], references: ["image"],
    mapping: {
      capability: { module: MINIMAX, name: "minimax-h3" }, result: "video", routes: [{ model: "minimax/hailuo-3" }],
      fields: {
        prompt: { as: "value", field: "prompt" },
        duration: { as: "value", field: "duration" },
        resolution: { as: "value", field: "resolution" },
        aspectRatio: { as: "value", field: "aspect_ratio" },
        firstFrame: { as: "url", field: "first_frame" },
        lastFrame: { as: "url", field: "last_frame" },
        referenceImage: { as: "urlArray", field: "reference_images" },
        referenceVideo: { as: "urlArray", field: "reference_videos" },
        referenceAudio: { as: "urlArray", field: "reference_audios" },
      },
    },
  },
  {
    // OpenRouter's GPT Image 2 route documents no resolution parameter, so only 1K is served.
    kind: "image", model: "openai/gpt-image-2", resolutions: { "1K": null },
    aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"],
    backgrounds: ["auto", "opaque"], outputFormats: [], maxReferences: 16, quality: true,
    mapping: {
      capability: { module: GPT_IMAGE, name: "gpt-image-2" }, result: "image", routes: [{ model: "openai/gpt-image-2" }],
      fields: {
        prompt: { as: "value", field: "prompt" },
        aspectRatio: { as: "value", field: "aspect_ratio" },
        resolution: { as: "value", field: "resolution" },
        background: { as: "value", field: "background" },
        images: { as: "urlArray", field: "reference_images" },
      },
    },
  },
  nanoBanana("nano-banana-2", "google/gemini-3.1-flash-image",
    ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"]),
  nanoBanana("nano-banana-pro", "google/gemini-3-pro-image",
    ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]),
];

export function capabilityKey(ref: CapabilityRef): string {
  return `${ref.module.name}@${ref.module.version}#${ref.name}`;
}

const byCapability = new Map(openRouterModels.map((model) => [capabilityKey(model.mapping.capability), model]));

export function openRouterModelForCapability(capability: CapabilityRef): OpenRouterModel | undefined {
  return byCapability.get(capabilityKey(capability));
}
