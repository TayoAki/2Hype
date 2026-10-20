import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/executor";
import { assertMappingCoversPorts, generationTypes } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";
import { canonicalize } from "@hypit/hypit/endpoint";
import type { BlobRef, EndpointInvocationContext, EndpointStartContext } from "@hypit/hypit/endpoint";
import { gptImage2Ports, sealGptImage2Request } from "@hypit/gpt-image";
import { grokImaginePorts, sealGrokImagineRequest } from "@hypit/grok-imagine";
import { minimaxH3Ports, sealMinimaxH3Request } from "@hypit/minimax-h3";
import { nanoBananaPorts, sealNanoBananaRequest } from "@hypit/nano-banana";
import { sealSeedanceRequest, seedancePorts } from "@hypit/seedance";
import {
  createOpenRouterProvider, diagnoseOpenRouterProvider, openRouterModelForCapability, openRouterModels,
} from "../src/index.js";

const BASE = "http://localhost:8787/api/v1";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 9, 9]);
const apiKey = { store: "env", key: "OPENROUTER_API_KEY" } as const;

type Fetch = typeof globalThis.fetch;
type Call = { method: string; path: string; body?: Record<string, unknown>; auth: string | null };

function recorder(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${url.pathname.replace("/api/v1", "")}${url.search}`,
      auth: new Headers(init?.headers).get("authorization"),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    };
    calls.push(call);
    return await handler(call);
  };
  return { calls, fetch };
}

function need(capabilityName: string, module: string, constraints: GenerationRequest, returns = generationTypes.videoSet) {
  const capability = { module: { name: module, version: "1" }, name: capabilityName };
  return { id: `need:${capabilityName}`, capability, returns, constraints: canonicalize(constraints), result: `record:${capabilityName}` } as const;
}

const seedanceBase = { prompt: ["A couple turns to camera"], duration: [5], resolution: ["720p"], aspectRatio: ["9:16"],
  generateAudio: [true], webSearch: [false] };

test("every mapping covers its Model's declared ports", () => {
  const tables = {
    "seedance-2": seedancePorts["seedance-2"], "seedance-2-fast": seedancePorts["seedance-2-fast"],
    "seedance-2-mini": seedancePorts["seedance-2-mini"], "seedance-2.5": seedancePorts["seedance-2.5"],
    "grok-imagine-video": grokImaginePorts["grok-imagine-video"],
    "grok-imagine-video-1.5-preview": grokImaginePorts["grok-imagine-video-1.5-preview"],
    "minimax-h3": minimaxH3Ports, "gpt-image-2": gptImage2Ports,
    "nano-banana-2": nanoBananaPorts["nano-banana-2"], "nano-banana-pro": nanoBananaPorts["nano-banana-pro"],
  } as const;
  assert.equal(openRouterModels.length, Object.keys(tables).length);
  for (const spec of openRouterModels) {
    const table = tables[spec.mapping.capability.name as keyof typeof tables];
    assert.ok(table, `no port table for ${spec.mapping.capability.name}`);
    assertMappingCoversPorts(table, spec.mapping);
  }
});

test("a Seedance first-frame video is submitted inline, polled, costed and collected", async () => {
  const resources = new MemoryResourceStore();
  const frame = await resources.put(PNG, "image/png");
  let checkpoint: unknown;
  let polls = 0;
  const diagnostics: string[] = [];
  const progress: string[] = [];
  const { calls, fetch } = recorder((call) => {
    if (call.method === "POST" && call.path === "/videos") {
      return Response.json({ id: "gen-vid-1", polling_url: "/api/v1/videos/gen-vid-1", status: "pending" }, { status: 202 });
    }
    if (call.path === "/videos/gen-vid-1") {
      polls += 1;
      return Response.json(polls === 1
        ? { id: "gen-vid-1", status: "in_progress", polling_url: "x" }
        : { id: "gen-vid-1", status: "completed", polling_url: "x", unsigned_urls: [`${BASE}/videos/gen-vid-1/content?index=0`], usage: { cost: 0.756 } });
    }
    if (call.path === "/videos/gen-vid-1/content?index=0") {
      // OpenRouter may label the bytes generically; the Provider recognises the MP4 itself.
      return new Response(MP4, { headers: { "content-type": "application/octet-stream" } });
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const provider = createOpenRouterProvider({ instance: "openrouter.default", pool: "openrouter.default", apiKey, baseUrl: BASE, pollIntervalMs: 0, fetch });
  const request = need("seedance-2", "@hypit/seedance", sealSeedanceRequest("seedance-2", {
    ...seedanceBase, firstFrame: [{ role: "image", artifact: frame, fields: { personReference: true } }],
  }));
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolved = registry.resolve(request);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "asynchronous");
  const endpoint = resolved.registration.endpoint;
  const context: EndpointStartContext = {
    need: request, command: { kind: "fulfill-need", id: "command:video", need: request }, operation: "operation:video",
    resources, credentials: { apiKey: { secret: "sk-or-test" } },
    checkpoint: async (value) => { checkpoint = value; },
    reportProgress: async (value) => { progress.push(value.phase); },
    reportDiagnostic: async (value) => { diagnostics.push(value.message); },
  };
  const started = await endpoint.start(context);
  assert.equal(started.status, "pending");
  assert.deepEqual(checkpoint, { handle: { id: "gen-vid-1" }, receipt: { id: "gen-vid-1" } });
  const submitted = calls[0]!;
  assert.equal(submitted.auth, "Bearer sk-or-test");
  assert.deepEqual(submitted.body, {
    model: "bytedance/seedance-2.0", prompt: "A couple turns to camera", duration: 5, resolution: "720p",
    aspect_ratio: "9:16", generate_audio: true,
    frame_images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` }, frame_type: "first_frame" }],
  });
  const rendering = await endpoint.poll({ ...context, handle: started.handle });
  assert.equal(rendering.status, "pending");
  const ready = await endpoint.poll({ ...context, handle: rendering.handle });
  assert.equal(ready.status, "ready");
  assert.deepEqual(diagnostics, ["OpenRouter reported a cost of $0.756 for video job gen-vid-1"]);
  const collected = await endpoint.collect!({ ...context, handle: ready.handle });
  assert.equal(collected.status, "completed");
  assert.equal(collected.result.value.kind, "inline");
  const videos = (collected.result.value.value as unknown as { videos: BlobRef[] }).videos;
  assert.equal(videos[0]?.mediaType, "video/mp4");
  assert.deepEqual(await resources.get(videos[0]!.resource), MP4);
  assert.deepEqual(progress, ["Preparing bytedance/seedance-2.0 request", "Submitting bytedance/seedance-2.0 request", "Receiving generated video"]);
});

test("Seedance references map by kind, audio and video are staged, and 4k uses OpenRouter's spelling", async () => {
  const resources = new MemoryResourceStore();
  const image = await resources.put(PNG, "image/png");
  const video = await resources.put(MP4, "video/mp4");
  const MP3 = new Uint8Array([0x49, 0x44, 0x33]);
  const audio = await resources.put(MP3, "audio/mpeg");
  const directory = await mkdtemp(join(tmpdir(), "openrouter-staging-"));
  const { calls, fetch } = recorder(() => Response.json({ id: "gen-vid-2", status: "pending", polling_url: "x" }, { status: 202 }));
  const provider = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, fetch,
    referenceStaging: { directory, baseUrl: "https://media.example.test/staged/" } });
  const request = need("seedance-2", "@hypit/seedance", sealSeedanceRequest("seedance-2", {
    ...seedanceBase, resolution: ["4k"], aspectRatio: ["16:9"],
    referenceImage: [{ role: "image", artifact: image, fields: { personReference: false } }],
    referenceVideo: [{ role: "video", artifact: video, fields: { personReference: true } }],
    referenceAudio: [{ role: "audio", artifact: audio }],
  }));
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolved = registry.resolve(request);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "asynchronous");
  await resolved.registration.endpoint.start({ need: request, command: { kind: "fulfill-need", id: "c", need: request },
    operation: "o", resources, credentials: { apiKey: { secret: "k" } } });
  const body = calls[0]!.body!;
  assert.equal(body.resolution, "4K");
  const references = body.input_references as { type: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string } }[];
  assert.deepEqual(references.map((item) => item.type), ["image_url", "video_url", "audio_url"]);
  assert.match(references[0]!.image_url!.url, /^data:image\/png;base64,/u);
  const staged = [[references[1]!.video_url!.url, ".mp4", MP4], [references[2]!.audio_url!.url, ".mp3", MP3]] as const;
  for (const [url, extension, bytes] of staged) {
    const name = url.replace("https://media.example.test/staged/", "");
    assert.match(name, new RegExp(`^[0-9a-f]{32}\\${extension}$`, "u"));
    assert.deepEqual(new Uint8Array(await readFile(join(directory, name))), bytes);
  }
  assert.equal(body.frame_images, undefined);
});

test("requests OpenRouter cannot serve are refused with reasons, not narrowed", async () => {
  const provider = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE });
  const strict = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, personReferences: "refuse" });
  const offer = (p: typeof provider, name: string) => p.offers.find((item) => item.capability.name === name)!;
  const reason = (support: ReturnType<NonNullable<ReturnType<typeof offer>["supports"]>>) =>
    support.status === "unsupported" ? support.reason : "supported";
  const store = new MemoryResourceStore();
  const artifact = await store.put(PNG, "image/png");
  const clip = await store.put(MP4, "video/mp4");
  const cases: [string, string, ReturnType<typeof need>, RegExp][] = [
    ["seedance-2-mini", "mini at 720p", need("seedance-2-mini", "@hypit/seedance", sealSeedanceRequest("seedance-2-mini", seedanceBase)), /^supported$/u],
    ["seedance-2", "adaptive ratio", need("seedance-2", "@hypit/seedance", sealSeedanceRequest("seedance-2", { ...seedanceBase, aspectRatio: ["adaptive"] })), /not adaptive/u],
    ["seedance-2", "web search", need("seedance-2", "@hypit/seedance", sealSeedanceRequest("seedance-2", { ...seedanceBase, webSearch: [true] })), /no web search/u],
    ["seedance-2.5", "1080p on 2.5", need("seedance-2.5", "@hypit/seedance", sealSeedanceRequest("seedance-2.5", { ...seedanceBase, resolution: ["1080p"] })), /renders 480p, 720p, not 1080p/u],
    ["seedance-2.5", "automatic duration", need("seedance-2.5", "@hypit/seedance", sealSeedanceRequest("seedance-2.5", { ...seedanceBase, duration: [-1] })), /4 to 30 seconds, not -1/u],
    ["grok-imagine-video", "grok 1080p", need("grok-imagine-video", "@hypit/grok-imagine", sealGrokImagineRequest("grok-imagine-video", { prompt: ["x"], aspectRatio: ["9:16"], resolution: ["1080p"], duration: [6] })), /not 1080p/u],
    ["grok-imagine-video", "grok 20 seconds", need("grok-imagine-video", "@hypit/grok-imagine", sealGrokImagineRequest("grok-imagine-video", { prompt: ["x"], aspectRatio: ["9:16"], resolution: ["720p"], duration: [20] })), /1 to 15 seconds, not 20/u],
    ["minimax-h3", "minimax 768P", need("minimax-h3", "@hypit/minimax-h3", sealMinimaxH3Request({ prompt: ["x"], duration: [6], resolution: ["768P"], aspectRatio: ["9:16"] })), /renders 2K, not 768P/u],
    ["minimax-h3", "minimax reference video", need("minimax-h3", "@hypit/minimax-h3", sealMinimaxH3Request({ prompt: ["x"], duration: [6], aspectRatio: ["9:16"], referenceVideo: [{ role: "video", artifact: clip }] })), /no video references/u],
    ["gpt-image-2", "gpt 2K", need("gpt-image-2", "@hypit/gpt-image", sealGptImage2Request({ prompt: ["x"], aspectRatio: ["2:3"], resolution: ["2K"] }), generationTypes.imageSet), /renders 1K, not 2K/u],
    ["gpt-image-2", "gpt transparent", need("gpt-image-2", "@hypit/gpt-image", sealGptImage2Request({ prompt: ["x"], aspectRatio: ["2:3"], resolution: ["1K"], background: ["transparent"] }), generationTypes.imageSet), /not transparent/u],
    ["nano-banana-2", "nano jpg", need("nano-banana-2", "@hypit/nano-banana", sealNanoBananaRequest("nano-banana-2", { prompt: ["x"], aspectRatio: ["9:16"], resolution: ["2K"], outputFormat: ["jpg"] }), generationTypes.imageSet), /returns png, not jpg/u],
  ];
  for (const [name, label, request, expected] of cases) {
    assert.match(reason(offer(provider, name).supports!(request)), expected, label);
  }
  const person = need("seedance-2", "@hypit/seedance", sealSeedanceRequest("seedance-2", {
    ...seedanceBase, firstFrame: [{ role: "image", artifact, fields: { personReference: true } }],
  }));
  assert.equal(reason(offer(provider, "seedance-2").supports!(person)), "supported");
  assert.match(reason(offer(strict, "seedance-2").supports!(person)), /person-reference/u);
  // OpenRouter rejects data URLs for audio, so an Endpoint without staging refuses it at plan time.
  const voiced = need("seedance-2", "@hypit/seedance", sealSeedanceRequest("seedance-2", {
    ...seedanceBase, referenceImage: [{ role: "image", artifact, fields: { personReference: true } }],
    referenceAudio: [{ role: "audio", artifact: await store.put(new Uint8Array([1]), "audio/wav") }],
  }));
  assert.match(reason(offer(provider, "seedance-2").supports!(voiced)), /only as HTTPS URLs/u);
  const staged = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE,
    referenceStaging: { directory: tmpdir(), baseUrl: "https://media.example.test" } });
  assert.equal(reason(offer(staged, "seedance-2").supports!(voiced)), "supported");
  assert.throws(() => createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE,
    referenceStaging: { directory: tmpdir(), baseUrl: "http://media.example.test" } }), /must use HTTPS/u);
  // A future reference video is judged before its bytes exist.
  const pending = { ...need("minimax-h3", "@hypit/minimax-h3", sealMinimaxH3Request({ prompt: ["x"], duration: [6], aspectRatio: ["9:16"] })),
    pendingInputs: [{ input: "referenceVideo", role: "video" }] };
  assert.match(reason(offer(provider, "minimax-h3").supports!(pending)), /no video references/u);
});

test("a transient status failure keeps the job; a failed job keeps OpenRouter's redacted reason", async () => {
  let reads = 0;
  const { fetch } = recorder((call) => {
    if (call.method === "POST") return Response.json({ id: "gen-vid-3", status: "pending", polling_url: "x" }, { status: 202 });
    reads += 1;
    if (reads === 1) return Response.json({ error: { code: 503, message: "busy" } }, { status: 503 });
    return Response.json({ id: "gen-vid-3", status: "failed", polling_url: "x", error: "Content policy violation, see https://openrouter.ai/x?sig=secret" });
  });
  const provider = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, pollIntervalMs: 0, fetch });
  const request = need("seedance-2-mini", "@hypit/seedance", sealSeedanceRequest("seedance-2-mini", seedanceBase));
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolved = registry.resolve(request);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "asynchronous");
  const endpoint = resolved.registration.endpoint;
  const context: EndpointStartContext = { need: request, command: { kind: "fulfill-need", id: "c", need: request },
    operation: "o", resources: new MemoryResourceStore(), credentials: { apiKey: { secret: "k" } } };
  const started = await endpoint.start(context);
  if (started.status !== "pending") throw new Error("submission did not return a pending job");
  const retried = await endpoint.poll({ ...context, handle: started.handle });
  if (retried.status !== "pending") throw new Error("a transient status failure ended the job");
  assert.deepEqual(retried.handle, { id: "gen-vid-3", retries: 1 });
  const failed = await endpoint.poll({ ...context, handle: retried.handle });
  assert.equal(failed.status, "failed");
  assert.equal(failed.status === "failed" ? failed.failure.code : "", "OPENROUTER_VIDEO_FAILED");
  assert.match(failed.status === "failed" ? failed.failure.message : "", /gen-vid-3 failed: Content policy violation/u);
  assert.doesNotMatch(failed.status === "failed" ? failed.failure.message : "", /sig=secret/u);
  assert.deepEqual(failed.receipt, { id: "gen-vid-3" });
});

test("submission errors keep OpenRouter's status and message", async () => {
  const { fetch } = recorder(() => Response.json({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 }));
  const provider = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, fetch });
  const request = need("seedance-2-mini", "@hypit/seedance", sealSeedanceRequest("seedance-2-mini", seedanceBase));
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolved = registry.resolve(request);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "asynchronous");
  await assert.rejects(Promise.resolve(resolved.registration.endpoint.start({ need: request, command: { kind: "fulfill-need", id: "c", need: request },
    operation: "o", resources: new MemoryResourceStore(), credentials: { apiKey: { secret: "k" } } })),
  /POST \/videos returned HTTP 402: Insufficient credits/u);
});

test("GPT Image 2 runs synchronously with inline references and the configured quality", async () => {
  const resources = new MemoryResourceStore();
  const reference = await resources.put(PNG, "image/png");
  const diagnostics: string[] = [];
  const { calls, fetch } = recorder(() => Response.json({
    created: 1, data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }], usage: { cost: 0.042 },
  }));
  const provider = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, fetch, gptImageQuality: "low" });
  const request = need("gpt-image-2", "@hypit/gpt-image", sealGptImage2Request({
    prompt: ["A portrait"], aspectRatio: ["2:3"], resolution: ["1K"], images: [{ role: "image", artifact: reference }],
  }), generationTypes.imageSet);
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolved = registry.resolve(request);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "immediate");
  const context: EndpointInvocationContext = { need: request, command: { kind: "fulfill-need", id: "c", need: request },
    resources, credentials: { apiKey: { secret: "k" } }, reportDiagnostic: async (value) => { diagnostics.push(value.message); } };
  const result = await resolved.registration.handler(context);
  assert.equal(calls[0]!.path, "/images");
  assert.deepEqual(calls[0]!.body, {
    model: "openai/gpt-image-2", n: 1, prompt: "A portrait", aspect_ratio: "2:3", quality: "low",
    input_references: [{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` } }],
  });
  assert.equal(result.value.kind, "inline");
  const images = (result.value.value as unknown as { images: BlobRef[] }).images;
  assert.equal(images[0]?.mediaType, "image/png");
  assert.deepEqual(await resources.get(images[0]!.resource), PNG);
  assert.deepEqual(diagnostics, ["OpenRouter reported a cost of $0.042 for openai/gpt-image-2"]);
});

test("Nano Banana sends its resolution and refuses a non-PNG result for a PNG request", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  const { calls, fetch } = recorder(() => Response.json({ created: 1, data: [{ b64_json: Buffer.from(jpeg).toString("base64") }] }));
  const provider = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, fetch });
  const request = need("nano-banana-pro", "@hypit/nano-banana", sealNanoBananaRequest("nano-banana-pro", {
    prompt: ["A product shot"], aspectRatio: ["4:5"], resolution: ["2K"], outputFormat: ["png"],
  }), generationTypes.imageSet);
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolved = registry.resolve(request);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "immediate");
  await assert.rejects(Promise.resolve(resolved.registration.handler({ need: request, command: { kind: "fulfill-need", id: "c", need: request },
    resources: new MemoryResourceStore(), credentials: { apiKey: { secret: "k" } } })), /returned image\/jpeg, not the requested PNG/u);
  assert.deepEqual(calls[0]!.body, { model: "google/gemini-3-pro-image", n: 1, prompt: "A product shot", aspect_ratio: "4:5", resolution: "2K" });
});

test("pricing reads the public catalogue and states the per-second rate at the requested size", async () => {
  const { calls, fetch } = recorder((call) => {
    if (call.path === "/videos/models") {
      return Response.json({ data: [{ id: "bytedance/seedance-2.0", pricing_skus: { video_tokens: "0.000007", video_tokens_1080p: "0.0000077" },
        supported_resolutions: ["480p", "720p", "1080p"], supported_durations: [4, 5], supported_sizes: ["720x1280", "1280x720", "1080x1920"] }] });
    }
    if (call.path === "/images/models/openai/gpt-image-2/endpoints") {
      return Response.json({ id: "openai/gpt-image-2", endpoints: [{ pricing: [{ billable: "output_image", unit: "token", cost_usd: 3e-5 }] }] });
    }
    throw new Error(`unexpected ${call.path}`);
  });
  const provider = createOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, fetch });
  const video = need("seedance-2", "@hypit/seedance", sealSeedanceRequest("seedance-2", seedanceBase));
  const [videoPrice] = await provider.readPricing!({ request: video, credentials: async () => ({}) });
  assert.equal(videoPrice?.source, `${BASE}/videos/models`);
  assert.match(videoPrice?.summary ?? "", /video_tokens \$7\.00 per 1M tokens/u);
  assert.match(videoPrice?.summary ?? "", /At 720x1280 that is \$0\.1512 per second/u);
  const image = need("gpt-image-2", "@hypit/gpt-image", sealGptImage2Request({ prompt: ["x"], aspectRatio: ["2:3"], resolution: ["1K"] }), generationTypes.imageSet);
  const [imagePrice] = await provider.readPricing!({ request: image, credentials: async () => ({}) });
  assert.match(imagePrice?.summary ?? "", /output_image \$30\.00 per 1M tokens.*quality "medium"/u);
  // Pricing uses the public catalogue and sends no key.
  assert.ok(calls.every((call) => call.auth === null));
});

test("doctor reports remaining credits and models missing from the catalogue", async () => {
  const { fetch } = recorder((call) => {
    if (call.path === "/credits") return Response.json({ data: { total_credits: 20, total_usage: 7.5 } });
    if (call.path === "/videos/models") return Response.json({ data: [{ id: "bytedance/seedance-2.0" }] });
    return Response.json({ data: [{ id: "openai/gpt-image-2" }] });
  });
  const diagnostics = await diagnoseOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE, fetch }, {
    credentials: { apiKey: { secret: "k" } },
    capabilities: [openRouterModelForCapability({ module: { name: "@hypit/seedance", version: "1" }, name: "seedance-2" })!.mapping.capability,
      { module: { name: "@hypit/seedance", version: "1" }, name: "seedance-2-mini" }],
  });
  assert.deepEqual(diagnostics.map((item) => item.code), ["OPENROUTER_CREDITS", "OPENROUTER_MODEL_UNLISTED"]);
  assert.match(diagnostics[0]!.message, /\$12\.50 remaining of \$20\.00/u);
  const rejected = await diagnoseOpenRouterProvider({ instance: "o", pool: "o", apiKey, baseUrl: BASE,
    fetch: async () => new Response("{}", { status: 401 }) }, { credentials: { apiKey: { secret: "bad" } } });
  assert.equal(rejected[0]?.code, "OPENROUTER_KEY_REJECTED");
});
