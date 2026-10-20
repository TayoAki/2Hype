# `@hypit/provider-openrouter`

Hypit Runtime Provider for [OpenRouter](https://openrouter.ai)'s video and image generation APIs.
It is maintained in the 2Hype fork, not by Hypit.AI. One OpenRouter API key serves every model below,
billed at OpenRouter's published rates plus its fee on credit purchases.

| Hypit Capability | OpenRouter model | Kind |
| --- | --- | --- |
| `@hypit/seedance@1#seedance-2` | `bytedance/seedance-2.0` | video |
| `@hypit/seedance@1#seedance-2-fast` | `bytedance/seedance-2.0-fast` | video |
| `@hypit/seedance@1#seedance-2-mini` | `bytedance/seedance-2.0-mini` | video |
| `@hypit/seedance@1#seedance-2.5` | `bytedance/seedance-2.5` | video |
| `@hypit/grok-imagine@1#grok-imagine-video` | `x-ai/grok-imagine-video` | video |
| `@hypit/grok-imagine@1#grok-imagine-video-1.5-preview` | `x-ai/grok-imagine-video-1.5` | video |
| `@hypit/minimax-h3@1#minimax-h3` | `minimax/hailuo-3` | video |
| `@hypit/gpt-image@1#gpt-image-2` | `openai/gpt-image-2` | image |
| `@hypit/nano-banana@1#nano-banana-2` | `google/gemini-3.1-flash-image` | image |
| `@hypit/nano-banana@1#nano-banana-pro` | `google/gemini-3-pro-image` | image |

Seedream is not mapped: OpenRouter's Seedream 5 Lite route has no equivalent of the Model's
`quality` and `nsfwCheck` ports.

## Profile

```json
{
  "credentials": { "env": { "use": "@hypit/credential-store-env" } },
  "endpoints": {
    "openrouter.default": {
      "use": "@hypit/provider-openrouter",
      "pool": "openrouter.default",
      "config": {
        "apiKey": { "store": "env", "key": "OPENROUTER_API_KEY" },
        "gptImageQuality": "medium"
      }
    }
  },
  "bindings": {
    "@hypit/seedance@1#seedance-2-mini": "openrouter.default",
    "@hypit/gpt-image@1#gpt-image-2": "openrouter.default"
  }
}
```

Bind every Capability you want OpenRouter to serve when another Endpoint, such as HypiHub, offers
the same one. A writable Store also works: `hypit auth login openrouter.default` prompts for the key.

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | CredentialRef for the OpenRouter API key |
| `baseUrl` | `https://openrouter.ai/api/v1` | API base; HTTPS, or loopback HTTP for tests |
| `gptImageQuality` | `medium` | `auto`, `low`, `medium` or `high` for GPT Image 2. It drives that model's price |
| `personReferences` | `submit` | OpenRouter has no person-reference field. `submit` sends such media as ordinary references; `refuse` declines the request |
| `maxInlineMegabytes` | `24` | Reference bytes inlined into one request as base64 data URLs |
| `defaultConcurrency` | `4` | Simultaneous requests across this Endpoint |
| `actionLimits` | submit 2, poll 8, collect 2 | Video lifecycle admission |
| `pollIntervalMs` | `10000` | Delay between video status reads |
| `requestTimeoutMs`, `imageTimeoutMs`, `downloadTimeoutMs` | 120 s, 300 s, 600 s | HTTP bounds |

## Behaviour

- **Video** uses `POST /videos`, then polls `GET /videos/{id}` and downloads
  `GET /videos/{id}/content`. The job id is checkpointed before polling starts. Status reads that hit
  HTTP 408, 429, 5xx or a network failure are retried up to 30 times on the same job.
- **Images** use the synchronous `POST /images` and store the returned base64 image.
- **References** travel inline as data URLs: first and last frames as `frame_images`, image, video
  and audio references as `input_references`. No upload service is involved.
- **Cost**: when OpenRouter reports a job's cost, the Provider records it as an execution diagnostic.
  `hypit pricing` reads the public model catalogue and states the per-second rate at the requested size.
- **Doctor**: `hypit doctor --endpoint openrouter.default` checks the key, reports remaining credits
  and warns when a mapped model disappears from OpenRouter's catalogue.

## Refused requests

The Provider reports these instead of narrowing the author's request:

- Seedance: aspect ratio `adaptive`, Seedance 2.5 `duration="-1"`, Seedance 2.5 above 720p, and
  `web-search="true"`.
- Grok Imagine: more than 15 seconds, or 1080p on `grok-imagine-video`.
- MiniMax H3: `768P` (OpenRouter serves 2K only), 4 seconds, and reference video or audio, which
  OpenRouter would ignore for this model.
- GPT Image 2: resolutions other than 1K, `transparent` backgrounds and aspect ratios outside
  OpenRouter's list.
- Nano Banana: `output-format="jpg"` and aspect ratios outside OpenRouter's list.

Seedance applies ByteDance's own moderation upstream. Images showing identifiable real people can
be rejected; the job's failure message keeps OpenRouter's reason.
