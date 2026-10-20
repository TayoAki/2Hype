import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeDoctorDiagnostic } from "@hypit/runtime-local/extension";
import { canonicalize, defineEndpoint, wakeAfter } from "@hypit/hypit/endpoint";
import type {
  AsyncEndpoint, CredentialRef, EndpointActionLimits, EndpointCapability, EndpointPricingDocument,
  EndpointRequest, EndpointSupport, ImmediateEndpointHandler, ResourceStore,
} from "@hypit/hypit/endpoint";
import {
  compileWireRequest, generationTypes, mappingSupportsRequest,
  sealGeneratedImageSet, sealGeneratedVideoSet, selectWireModelForRequest,
} from "@hypit/generation";
import type { GenerationMediaValue, GenerationRequest } from "@hypit/generation";
import type { BlobRef, CanonicalValue, CapabilityRef } from "@hypit/hypit/protocol";
import { openRouterModelForCapability, openRouterModels } from "./models.js";
import type { OpenRouterImageModel, OpenRouterModel, OpenRouterVideoModel } from "./models.js";

export const openRouterProviderModule = { name: "@hypit/provider-openrouter", version: "1" } as const;

export type PersonReferencePolicy = "submit" | "refuse";
export type GptImageQuality = "auto" | "low" | "medium" | "high";
export type ReferenceStaging = { readonly directory: string; readonly baseUrl: string };

export type CreateOpenRouterProviderOptions = {
  readonly instance: string;
  readonly pool: string;
  readonly apiKey: CredentialRef;
  /** OpenRouter API base. Defaults to https://openrouter.ai/api/v1. */
  readonly baseUrl?: string;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: EndpointActionLimits;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly imageTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  /** Quality sent to models with a quality knob (GPT Image 2). Defaults to `medium`. */
  readonly gptImageQuality?: GptImageQuality;
  /**
   * OpenRouter has no field for Hypit's person-reference classification. `submit` (default) sends
   * person-classified images and videos as ordinary references; `refuse` declines such requests.
   */
  readonly personReferences?: PersonReferencePolicy;
  /** Upper bound for image bytes inlined into one request as data URLs. Defaults to 24 MiB. */
  readonly maxInlineBytes?: number;
  /**
   * OpenRouter takes audio and video references only as HTTPS URLs. When set, the Provider writes each
   * such reference to `directory` under a random name and sends `baseUrl/<name>`; the host must serve
   * that directory at that address. Without it, requests carrying audio or video references are refused.
   */
  readonly referenceStaging?: ReferenceStaging;
  readonly fetch?: typeof globalThis.fetch;
};

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const MAX_POLL_RETRIES = 30;
const MAX_VIDEO_OUTPUTS = 4;

class OpenRouterHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "OpenRouterHttpError";
  }
}

function object(value: unknown, subject = "OpenRouter response"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${subject} is missing`);
  return value;
}

/** Service messages are republished without URLs, data URIs or unbounded length. */
function redact(message: string): string {
  return message
    .replace(/data:[^\s"']+/giu, "[data-url]")
    .replace(/https?:\/\/\S+/giu, "[url]")
    .slice(0, 600);
}

/** OpenRouter fetches staged media itself, so only a public HTTPS address will do. */
function stagingAddress(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("OpenRouter referenceStaging baseUrl must use HTTPS");
  return url.href.replace(/\/+$/u, "");
}

function address(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OpenRouter baseUrl must use HTTPS or loopback HTTP");
  }
  return url.href.replace(/\/+$/u, "");
}

function isTransient(error: unknown): boolean {
  if (error instanceof OpenRouterHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

function describeError(error: unknown): string {
  if (error instanceof OpenRouterHttpError) return `HTTP ${error.status}`;
  return error instanceof Error ? error.name : "transport failure";
}

type Ports = GenerationRequest["ports"];

function portsOf(request: EndpointRequest): Ports {
  const constraints = request.constraints as unknown as Partial<GenerationRequest> | null;
  return constraints?.ports ?? {};
}

function scalarOf(ports: Ports, name: string): string | number | boolean | undefined {
  const value = ports[name]?.[0];
  return value === undefined || typeof value === "object" ? undefined : value;
}

function mediaOf(ports: Ports, name: string): GenerationMediaValue[] {
  return (ports[name] ?? []).filter((value): value is GenerationMediaValue => typeof value === "object");
}

function present(request: EndpointRequest, name: string): boolean {
  return (portsOf(request)[name]?.length ?? 0) > 0 || (request.pendingInputs ?? []).some((slot) => slot.input === name);
}

function hasPersonReference(ports: Ports): boolean {
  return Object.keys(ports).some((name) => mediaOf(ports, name).some((item) => item.fields?.personReference === true));
}

function list(values: readonly string[]): string {
  return values.join(", ");
}

function commonSupport(spec: OpenRouterModel, request: EndpointRequest): string | undefined {
  if (!mappingSupportsRequest(spec.mapping, request.constraints)) return "the request has an input this Provider cannot map";
  for (const slot of request.pendingInputs ?? []) {
    if (spec.mapping.fields[slot.input] === undefined) return `future input ${slot.input} cannot be mapped`;
  }
  return undefined;
}

export function videoSupport(spec: OpenRouterVideoModel, request: EndpointRequest, policy: PersonReferencePolicy,
  staged = false): EndpointSupport {
  const refuse = (reason: string): EndpointSupport => ({ status: "unsupported", reason: `OpenRouter ${spec.model} ${reason}` });
  const common = commonSupport(spec, request);
  if (common !== undefined) return refuse(common);
  const ports = portsOf(request);
  const resolution = scalarOf(ports, "resolution");
  if (resolution !== undefined && spec.resolutions[String(resolution)] === undefined) {
    return refuse(`renders ${list(Object.keys(spec.resolutions))}, not ${String(resolution)}`);
  }
  const duration = scalarOf(ports, "duration");
  if (typeof duration === "number" && (duration < spec.minSeconds || duration > spec.maxSeconds)) {
    return refuse(`accepts ${spec.minSeconds} to ${spec.maxSeconds} seconds, not ${duration}`);
  }
  const ratio = scalarOf(ports, "aspectRatio");
  if (ratio !== undefined && !spec.aspectRatios.includes(String(ratio))) {
    return refuse(`accepts aspect ratios ${list(spec.aspectRatios)}, not ${String(ratio)}`);
  }
  if (scalarOf(ports, "webSearch") === true) return refuse("has no web search option");
  if (present(request, "firstFrame") && !spec.frames.includes("first_frame")) return refuse("takes no first frame");
  if (present(request, "lastFrame") && !spec.frames.includes("last_frame")) return refuse("takes no last frame");
  const references: readonly (readonly [string, "image" | "video" | "audio"])[] = [
    ["referenceImage", "image"], ["images", "image"], ["referenceVideo", "video"], ["referenceAudio", "audio"],
  ];
  for (const [port, kind] of references) {
    if (present(request, port) && !spec.references.includes(kind)) {
      return refuse(`receives no ${kind} references through OpenRouter, which would ignore them`);
    }
  }
  if (policy === "refuse" && hasPersonReference(ports)) {
    return refuse("cannot carry person-reference classifications and this Endpoint is set to refuse them");
  }
  if (!staged && (present(request, "referenceVideo") || present(request, "referenceAudio"))) {
    return refuse("takes video and audio references only as HTTPS URLs, and this Endpoint has no referenceStaging to publish them");
  }
  return { status: "supported" };
}

export function imageSupport(spec: OpenRouterImageModel, request: EndpointRequest): EndpointSupport {
  const refuse = (reason: string): EndpointSupport => ({ status: "unsupported", reason: `OpenRouter ${spec.model} ${reason}` });
  const common = commonSupport(spec, request);
  if (common !== undefined) return refuse(common);
  const ports = portsOf(request);
  const resolution = scalarOf(ports, "resolution");
  if (resolution !== undefined && !Object.hasOwn(spec.resolutions, String(resolution))) {
    return refuse(`renders ${list(Object.keys(spec.resolutions))}, not ${String(resolution)}`);
  }
  const ratio = scalarOf(ports, "aspectRatio");
  if (ratio !== undefined && !spec.aspectRatios.includes(String(ratio))) {
    return refuse(`accepts aspect ratios ${list(spec.aspectRatios)}, not ${String(ratio)}`);
  }
  const background = scalarOf(ports, "background");
  if (background !== undefined && !spec.backgrounds.includes(String(background))) {
    return refuse(spec.backgrounds.length === 0 ? "has no background option"
      : `accepts backgrounds ${list(spec.backgrounds)}, not ${String(background)}`);
  }
  const format = scalarOf(ports, "outputFormat");
  if (format !== undefined && !spec.outputFormats.includes(String(format))) {
    return refuse(`returns ${list(spec.outputFormats)}, not ${String(format)}`);
  }
  if (mediaOf(ports, "images").length > spec.maxReferences) return refuse(`accepts at most ${spec.maxReferences} reference images`);
  return { status: "supported" };
}

const STAGED_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};

/**
 * Images travel inline as base64 data URLs. OpenRouter rejects data URLs for audio and video, so those
 * are written under an unguessable name to the staging directory and sent as its HTTPS address.
 */
function referenceResolver(resources: ResourceStore, maxBytes: number, staging: ReferenceStaging | undefined) {
  let used = 0;
  return async (artifact: BlobRef): Promise<string> => {
    const inline = artifact.mediaType.startsWith("image/");
    if (inline) {
      used += artifact.size;
      if (used > maxBytes) {
        throw new Error(`Reference images exceed this Endpoint's ${Math.round(maxBytes / 1024 / 1024)} MiB inline limit; raise maxInlineMegabytes or use smaller media`);
      }
    } else if (staging === undefined) {
      throw new Error(`OpenRouter takes ${artifact.mediaType} references only as HTTPS URLs; configure referenceStaging`);
    }
    const bytes = await resources.get(artifact.resource);
    if (bytes === undefined) throw new Error("Reference media is unavailable in the Build's resource store");
    if (inline) return `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
    const name = `${randomBytes(16).toString("hex")}${STAGED_EXTENSIONS[artifact.mediaType] ?? ".bin"}`;
    await mkdir(staging!.directory, { recursive: true });
    await writeFile(join(staging!.directory, name), bytes);
    return `${staging!.baseUrl}/${name}`;
  };
}

function strings(value: CanonicalValue | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
}

export function videoBody(spec: OpenRouterVideoModel, input: Readonly<Record<string, CanonicalValue>>): Record<string, unknown> {
  const body: Record<string, unknown> = { model: spec.model };
  if (typeof input.prompt === "string") body.prompt = input.prompt;
  if (typeof input.duration === "number") body.duration = input.duration;
  const resolution = input.resolution === undefined ? spec.defaultResolution : spec.resolutions[String(input.resolution)];
  if (resolution !== undefined) body.resolution = resolution;
  if (typeof input.aspect_ratio === "string") body.aspect_ratio = input.aspect_ratio;
  if (typeof input.generate_audio === "boolean") body.generate_audio = input.generate_audio;
  const frames = (["first_frame", "last_frame"] as const).flatMap((frame) => strings(input[frame])
    .map((url) => ({ type: "image_url", image_url: { url }, frame_type: frame })));
  const references = [
    ...strings(input.reference_images).map((url) => ({ type: "image_url", image_url: { url } })),
    ...strings(input.reference_videos).map((url) => ({ type: "video_url", video_url: { url } })),
    ...strings(input.reference_audios).map((url) => ({ type: "audio_url", audio_url: { url } })),
  ];
  if (frames.length > 0) body.frame_images = frames;
  if (references.length > 0) body.input_references = references;
  return body;
}

export function imageBody(spec: OpenRouterImageModel, input: Readonly<Record<string, CanonicalValue>>,
  quality: GptImageQuality): Record<string, unknown> {
  const body: Record<string, unknown> = { model: spec.model, n: 1 };
  if (typeof input.prompt === "string") body.prompt = input.prompt;
  if (typeof input.aspect_ratio === "string") body.aspect_ratio = input.aspect_ratio;
  const resolution = input.resolution === undefined ? undefined : spec.resolutions[String(input.resolution)];
  if (typeof resolution === "string") body.resolution = resolution;
  if (typeof input.background === "string") body.background = input.background;
  if (spec.quality) body.quality = quality;
  const references = strings(input.reference_images).map((url) => ({ type: "image_url", image_url: { url } }));
  if (references.length > 0) body.input_references = references;
  return body;
}

function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (String.fromCharCode(...bytes.slice(0, 3)) === "GIF") return "image/gif";
  return undefined;
}

function sniffVideo(bytes: Uint8Array): string | undefined {
  if (String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    return String.fromCharCode(...bytes.slice(8, 10)) === "qt" ? "video/quicktime" : "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return undefined;
}

function cost(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const amount = (value as Record<string, unknown>).cost;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : undefined;
}

const SIZE_HEIGHT: Readonly<Record<string, number>> = { "480p": 480, "720p": 720, "768p": 768, "1080p": 1080, "2K": 1440, "4K": 2160 };

/** Pick OpenRouter's listed WIDTHxHEIGHT for a resolution and aspect ratio, when it lists one. */
function listedSize(sizes: unknown, resolution: string | undefined, ratio: string | undefined): [number, number] | undefined {
  if (!Array.isArray(sizes) || resolution === undefined || ratio === undefined) return undefined;
  const short = SIZE_HEIGHT[resolution];
  const [rw, rh] = ratio.split(":").map(Number);
  if (short === undefined || !rw || !rh) return undefined;
  for (const size of sizes) {
    if (typeof size !== "string") continue;
    const [w, h] = size.split("x").map(Number);
    if (!w || !h || Math.min(w, h) !== short) continue;
    if (Math.abs(w / h - rw / rh) < 0.02) return [w, h];
  }
  return undefined;
}

function skuText(key: string, value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${key}: ${String(value)}`;
  if (key.startsWith("video_tokens")) return `${key} $${(amount * 1e6).toFixed(2)} per 1M tokens`;
  if (key.startsWith("cents_per")) return `${key} $${(amount / 100).toFixed(4)}`;
  if (key.includes("duration_seconds") || key.startsWith("per-video-second")) return `${key} $${amount} per second`;
  return `${key} ${amount}`;
}

export function videoPricingSummary(spec: OpenRouterVideoModel, entry: Record<string, unknown>, request: EndpointRequest): string {
  const skus = Object.entries(object(entry.pricing_skus ?? {}, "OpenRouter pricing_skus"));
  const parts = [`OpenRouter ${spec.model}: ${skus.map(([key, value]) => skuText(key, value)).join("; ")}.`];
  if (skus.some(([key]) => key.startsWith("video_tokens"))) {
    parts.push("Video tokens = width x height x seconds x 24 / 1024.");
    const ports = portsOf(request);
    const authored = scalarOf(ports, "resolution");
    const resolution = authored === undefined ? spec.defaultResolution : spec.resolutions[String(authored)];
    const ratio = scalarOf(ports, "aspectRatio");
    const size = listedSize(entry.supported_sizes, resolution, ratio === undefined ? undefined : String(ratio));
    const withVideo = present(request, "referenceVideo");
    const tier = resolution === "1080p" ? "_1080p" : resolution === "4K" ? "_4k" : "";
    const sku = Object.fromEntries(skus);
    const rate = Number(sku[`video_tokens${tier}${withVideo ? "_with_video_input" : ""}`] ?? sku[`video_tokens${withVideo ? "_with_video_input" : ""}`] ?? sku.video_tokens);
    if (size !== undefined && Number.isFinite(rate)) {
      const perSecond = (size[0] * size[1] * 24 / 1024) * rate;
      parts.push(`At ${size[0]}x${size[1]} that is $${perSecond.toFixed(4)} per second of output.`);
    }
  }
  parts.push("OpenRouter adds a 5.5% fee when credits are bought.");
  return parts.join(" ");
}

export function imagePricingSummary(spec: OpenRouterImageModel, endpoints: Record<string, unknown>, quality: GptImageQuality): string {
  const first = Array.isArray(endpoints.endpoints) ? endpoints.endpoints[0] : undefined;
  const rows = first !== undefined && Array.isArray(object(first).pricing) ? object(first).pricing as unknown[] : [];
  const rates = rows.map((row) => {
    const item = object(row, "OpenRouter pricing row");
    const amount = Number(item.cost_usd);
    return item.unit === "token" && Number.isFinite(amount)
      ? `${String(item.billable)} $${(amount * 1e6).toFixed(2)} per 1M tokens`
      : `${String(item.billable)} $${String(item.cost_usd)} per ${String(item.unit)}`;
  });
  return [`OpenRouter ${spec.model}: ${rates.join("; ") || "no published rate rows"}.`,
    ...(spec.quality ? [`This Endpoint requests quality "${quality}".`] : []),
    "OpenRouter adds a 5.5% fee when credits are bought."].join(" ");
}

export function createOpenRouterProvider(options: CreateOpenRouterProviderOptions) {
  const base = address(options.baseUrl ?? DEFAULT_BASE_URL);
  const fetcher = options.fetch ?? globalThis.fetch;
  const interval = options.pollIntervalMs ?? 10_000;
  const requestTimeout = options.requestTimeoutMs ?? 120_000;
  const imageTimeout = options.imageTimeoutMs ?? 300_000;
  const downloadTimeout = options.downloadTimeoutMs ?? 600_000;
  const quality = options.gptImageQuality ?? "medium";
  const personPolicy = options.personReferences ?? "submit";
  const maxInline = options.maxInlineBytes ?? 24 * 1024 * 1024;
  const staging = options.referenceStaging === undefined ? undefined
    : { directory: options.referenceStaging.directory, baseUrl: stagingAddress(options.referenceStaging.baseUrl) };
  const key = (credentials: Readonly<Record<string, { readonly secret: string }>>) =>
    text(credentials.apiKey?.secret, "OpenRouter API key");

  async function failure(response: Response, method: string, path: string): Promise<OpenRouterHttpError> {
    let code: string | undefined;
    let message = "";
    try {
      const error = object(object(await response.json()).error, "OpenRouter error");
      if (error.code !== undefined) code = String(error.code);
      if (typeof error.message === "string") message = redact(error.message);
    } catch { /* The status line remains the evidence when the body is not OpenRouter's error JSON. */ }
    return new OpenRouterHttpError(`OpenRouter ${method} ${path} returned HTTP ${response.status}${message ? `: ${message}` : ""}`,
      response.status, code);
  }

  async function api(method: "GET" | "POST", path: string, secret: string | undefined, body: unknown, timeoutMs: number) {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: {
        ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw await failure(response, method, path);
    return object(await response.json());
  }

  function videoEndpoint(spec: OpenRouterVideoModel): AsyncEndpoint {
    return {
      async start(context) {
        const support = videoSupport(spec, context.need, personPolicy, staging !== undefined);
        if (support.status === "unsupported") throw new Error(support.reason);
        const secret = key(context.credentials);
        const authored = context.need.constraints as unknown as GenerationRequest;
        selectWireModelForRequest(spec.mapping, authored);
        await context.reportProgress?.({ phase: `Preparing ${spec.model} request` });
        const compiled = await compileWireRequest(spec.mapping, authored, referenceResolver(context.resources, maxInline, staging));
        const body = videoBody(spec, compiled.input as Readonly<Record<string, CanonicalValue>>);
        await context.reportProgress?.({ phase: `Submitting ${spec.model} request` });
        const job = await api("POST", "/videos", secret, body, requestTimeout);
        const id = text(job.id, "OpenRouter video job id");
        const handle = { id };
        const receipt = { id };
        await context.checkpoint?.({ handle, receipt });
        return { ...wakeAfter(handle, interval, Date.now(), { phase: "queued at OpenRouter" }), receipt };
      },
      async poll(context) {
        const handle = object(context.handle, "OpenRouter video handle");
        const id = text(handle.id, "OpenRouter video job id");
        const retries = typeof handle.retries === "number" ? handle.retries : 0;
        let job: Record<string, unknown>;
        try {
          job = await api("GET", `/videos/${encodeURIComponent(id)}`, key(context.credentials), undefined, requestTimeout);
        } catch (error) {
          if (isTransient(error) && retries < MAX_POLL_RETRIES) {
            return wakeAfter({ id, retries: retries + 1 }, interval, Date.now(),
              { phase: `waiting for OpenRouter job status (${describeError(error)})` });
          }
          throw error;
        }
        const status = text(job.status, "OpenRouter video job status");
        if (status === "pending" || status === "in_progress") {
          return wakeAfter({ id }, interval, Date.now(),
            { phase: status === "pending" ? "queued at OpenRouter" : "rendering at OpenRouter" });
        }
        if (status === "completed") {
          const reported = cost(job.usage);
          if (reported !== undefined) {
            await context.reportDiagnostic?.({ level: "info", message: `OpenRouter reported a cost of $${reported} for video job ${id}` });
          }
          const outputs = Array.isArray(job.unsigned_urls) && job.unsigned_urls.length > 0 ? job.unsigned_urls.length : 1;
          return { status: "ready", handle: { id, outputs: Math.min(outputs, MAX_VIDEO_OUTPUTS) }, receipt: { id } };
        }
        if (status === "failed" || status === "cancelled" || status === "expired") {
          const reason = typeof job.error === "string" && job.error.length > 0 ? `: ${redact(job.error)}` : "";
          return { status: "failed", receipt: { id }, failure: {
            code: `OPENROUTER_VIDEO_${status.toUpperCase()}`,
            message: `OpenRouter video job ${id} ${status}${reason}`,
          } };
        }
        throw new Error(`OpenRouter video job ${id} returned unknown status ${status}`);
      },
      async collect(context) {
        const handle = object(context.handle, "OpenRouter video handle");
        const id = text(handle.id, "OpenRouter video job id");
        const outputs = typeof handle.outputs === "number" ? handle.outputs : 1;
        const secret = key(context.credentials);
        await context.reportProgress?.({ phase: "Receiving generated video" });
        const videos: BlobRef[] = [];
        for (let index = 0; index < outputs; index += 1) {
          const path = `/videos/${encodeURIComponent(id)}/content?index=${index}`;
          const response = await fetcher(`${base}${path}`, {
            headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(downloadTimeout),
          });
          if (!response.ok) throw await failure(response, "GET", path);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const declared = response.headers.get("content-type")?.split(";")[0]?.trim();
          const mediaType = declared?.startsWith("video/") ? declared : sniffVideo(bytes);
          if (mediaType === undefined) throw new Error(`OpenRouter video job ${id} returned a non-video result`);
          videos.push(await context.resources.put(bytes, mediaType));
        }
        return { status: "completed", receipt: { id }, result: { value: {
          kind: "inline", value: canonicalize(sealGeneratedVideoSet({ videos })),
        } } };
      },
    };
  }

  function imageHandler(spec: OpenRouterImageModel): ImmediateEndpointHandler {
    return async (context) => {
      const support = imageSupport(spec, context.need);
      if (support.status === "unsupported") throw new Error(support.reason);
      const secret = key(context.credentials);
      const authored = context.need.constraints as unknown as GenerationRequest;
      await context.reportProgress?.({ phase: `Generating image with ${spec.model}` });
      const compiled = await compileWireRequest(spec.mapping, authored, referenceResolver(context.resources, maxInline, staging));
      const body = imageBody(spec, compiled.input as Readonly<Record<string, CanonicalValue>>, quality);
      const result = await api("POST", "/images", secret, body, imageTimeout);
      const data = Array.isArray(result.data) ? result.data : [];
      if (data.length === 0) throw new Error(`OpenRouter ${spec.model} returned no image`);
      const requested = scalarOf(authored.ports, "outputFormat");
      const images: BlobRef[] = [];
      for (const entry of data) {
        const item = object(entry, "OpenRouter image");
        const bytes = new Uint8Array(Buffer.from(text(item.b64_json, "OpenRouter image data"), "base64"));
        const mediaType = typeof item.media_type === "string" && item.media_type.startsWith("image/")
          ? item.media_type : sniffImage(bytes);
        if (mediaType === undefined) throw new Error(`OpenRouter ${spec.model} returned an unrecognised image format`);
        if (requested === "png" && mediaType !== "image/png") {
          throw new Error(`OpenRouter ${spec.model} returned ${mediaType}, not the requested PNG`);
        }
        images.push(await context.resources.put(bytes, mediaType));
      }
      const reported = cost(result.usage);
      if (reported !== undefined) {
        await context.reportDiagnostic?.({ level: "info", message: `OpenRouter reported a cost of $${reported} for ${spec.model}` });
      }
      return { value: { kind: "inline", value: canonicalize(sealGeneratedImageSet({ images })) } };
    };
  }

  const capabilities: EndpointCapability[] = openRouterModels.map((spec): EndpointCapability => spec.kind === "video"
    ? {
        capability: spec.mapping.capability, returns: generationTypes.videoSet, lifecycle: "asynchronous",
        supports: (request) => videoSupport(spec, request, personPolicy, staging !== undefined), endpoint: videoEndpoint(spec),
      }
    : {
        capability: spec.mapping.capability, returns: generationTypes.imageSet, lifecycle: "immediate",
        supports: (request) => imageSupport(spec, request), handler: imageHandler(spec),
      });

  return defineEndpoint({
    instance: options.instance,
    pool: options.pool,
    credentials: { apiKey: options.apiKey },
    credentialInputs: { apiKey: { label: "OpenRouter API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 4,
    actionLimits: options.actionLimits ?? { submit: { concurrency: 2 }, poll: { concurrency: 8 }, collect: { concurrency: 2 } },
    pricing: { kind: "page", url: "https://openrouter.ai/models" },
    async readPricing(context): Promise<readonly EndpointPricingDocument[]> {
      const spec = openRouterModelForCapability(context.request.capability);
      if (spec === undefined) throw new Error("This Capability is not served by the OpenRouter Provider");
      if (spec.kind === "video") {
        const source = `${base}/videos/models`;
        const catalogue = await api("GET", "/videos/models", undefined, undefined, requestTimeout);
        const entries = Array.isArray(catalogue.data) ? catalogue.data : [];
        const entry = entries.map((item) => object(item, "OpenRouter video model")).find((item) => item.id === spec.model);
        if (entry === undefined) throw new Error(`OpenRouter's video catalogue does not list ${spec.model}`);
        return [{
          source,
          data: canonicalize({
            model: spec.model,
            pricing_skus: canonicalize(entry.pricing_skus ?? {}),
            supported_resolutions: canonicalize(entry.supported_resolutions ?? []),
            supported_durations: canonicalize(entry.supported_durations ?? []),
            supported_sizes: canonicalize(entry.supported_sizes ?? []),
          }),
          summary: videoPricingSummary(spec, entry, context.request),
        }];
      }
      const path = `/images/models/${spec.model}/endpoints`;
      const endpoints = await api("GET", path, undefined, undefined, requestTimeout);
      return [{
        source: `${base}${path}`,
        data: canonicalize(endpoints as unknown as CanonicalValue),
        summary: imagePricingSummary(spec, endpoints, quality),
      }];
    },
    capabilities,
  });
}

/** `hypit doctor`: check the key, report the remaining balance and confirm each model is listed. */
export async function diagnoseOpenRouterProvider(
  options: CreateOpenRouterProviderOptions,
  context: {
    readonly credentials: Readonly<Record<string, { readonly secret: string }>>;
    readonly capabilities?: readonly CapabilityRef[];
  },
): Promise<readonly RuntimeDoctorDiagnostic[]> {
  const base = address(options.baseUrl ?? DEFAULT_BASE_URL);
  const fetcher = options.fetch ?? globalThis.fetch;
  const secret = context.credentials.apiKey?.secret;
  if (typeof secret !== "string" || secret.length === 0) {
    return [{ severity: "error", code: "OPENROUTER_KEY_MISSING", message: "The OpenRouter API key is unavailable" }];
  }
  const diagnostics: RuntimeDoctorDiagnostic[] = [];
  const credits = await fetcher(`${base}/credits`, {
    headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(30_000),
  });
  if (credits.status === 401 || credits.status === 403) {
    return [{ severity: "error", code: "OPENROUTER_KEY_REJECTED", message: `OpenRouter rejected the API key (HTTP ${credits.status})` }];
  }
  if (credits.ok) {
    const data = object(object(await credits.json()).data ?? {}, "OpenRouter credits");
    const total = Number(data.total_credits);
    const used = Number(data.total_usage);
    if (Number.isFinite(total) && Number.isFinite(used)) {
      const remaining = total - used;
      diagnostics.push({
        severity: remaining > 0 ? "info" : "warning", code: "OPENROUTER_CREDITS",
        message: `OpenRouter credits: $${remaining.toFixed(2)} remaining of $${total.toFixed(2)} purchased`,
      });
    }
  } else {
    diagnostics.push({ severity: "warning", code: "OPENROUTER_CREDITS_UNKNOWN", message: `OpenRouter /credits returned HTTP ${credits.status}` });
  }
  const listed = new Set<string>();
  for (const path of ["/videos/models", "/images/models"]) {
    const response = await fetcher(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) continue;
    const data = object(await response.json()).data;
    if (Array.isArray(data)) for (const item of data) if (typeof object(item).id === "string") listed.add(String(object(item).id));
  }
  for (const capability of context.capabilities ?? []) {
    const spec = openRouterModelForCapability(capability);
    if (spec !== undefined && listed.size > 0 && !listed.has(spec.model)) {
      diagnostics.push({ severity: "warning", code: "OPENROUTER_MODEL_UNLISTED", subject: capability.name,
        message: `OpenRouter's public catalogue no longer lists ${spec.model}` });
    }
  }
  return diagnostics;
}

export { openRouterModels } from "./models.js";
