---
name: video-remake
description: "Study any reference video, document its format into VIDEO_SPEC.md, then produce an original video in the same format with Hypit. Three-phase workflow: analyze → spec → build. Never builds from memory; never copies the reference's footage, words, music, characters or branding."
user-invocable: true
---

# /video-remake

Make an original video that matches a reference video's format: same length, frame, pacing, shot grammar, text
system, loudness and audio structure, with our own brand, characters, script, footage and music. Three phases:
measure the reference → write VIDEO_SPEC.md → build from the spec only, then verify the render against it.

The builder never looks at the reference. Everything flows through VIDEO_SPEC.md and template.json.

## What is copied and what is not

| Copied exactly (measured) | Ours (written fresh) |
| --- | --- |
| Duration, aspect, fps, every cut point and shot length | Brand, palette, logo, slogan, end card |
| Shot grammar per slot: size, angle, camera move, beat role | Characters (designed from scratch), settings |
| Pacing curve, first-cut time, motion, brightness, saturation, contrast | Script and voiceover lines, deals and claims |
| Loudness and true peak, voiceover presence and pace, music genre and tempo | Music (generated), voice (licensed preset) |
| Where text sits and what role it plays | Every word on screen, every prompt |

The reference's content is recorded only as a short **paraphrased summary** (message, offers, call to action,
brand positioning, cast archetypes, purpose of each on-screen text) so we understand it and can make ours
clearly different. Never write verbatim transcripts, song lyrics or exact on-screen copy into the spec, never
describe a character in enough detail to recreate it, and never feed reference frames, clips or audio into a
generator. If the user asks for a shot-for-shot or near-identical copy, decline that part and offer this workflow
or a re-edit of footage they own.

## Inputs

Ask for these before starting (or take them from the user's message):

1. **Reference video**: a URL or a file. Instagram and TikTok usually download on the server; YouTube blocks
   data-centre addresses, so ask the user to upload the file (give them a `file_link` upload command). Never ask
   for cookies or passwords.
2. **Project name** on the Hypit server (new, lowercase).
3. **Brand and purpose**: whose video it is (or "invent a placeholder brand") and one line on what it is for.
4. **Budget cap in USD**. Check the OpenRouter balance first (`hypit doctor --endpoint openrouter.default`).
   OpenRouter refuses audio analysis below $0.50 and any job the balance cannot cover.

Do not start Phase 1 without the reference, the project name and the budget cap.

---

## Phase 1: Measure the reference

All commands run on the Hypit MCP server (`hypit`, `run_command`, `file_*` tools) from the project root. The tool
is at `/app/tools/shot-list.mjs`.

```bash
hypit download <url> --to references/source.mp4        # or the user's upload at references/source.mp4
node /app/tools/shot-list.mjs references/source.mp4 --out analysis/reference --analyze --spec
```

This writes, under `analysis/reference/`:

- `shots.json`, `shots.csv`: every cut with timecodes, plus per-shot labels, motion and palette
- `frames/`, `contact-sheet.jpg`, `index.html`: one frame per shot, for the human reviewing the analysis
- `template.json`, `template.md`: the slot structure with an empty `prompt` per slot
- `VIDEO_SPEC.md`: parts 1-4 and 4b filled with measured values; parts 5-7 left for us

Costs about $0.01 with `google/gemini-2.5-flash`. Without credits, drop `--analyze`: cuts, metrics and the
spec skeleton are free and need no key.

Check the analysis before moving on:

- Open `contact-sheet.jpg`. If a dissolve was missed or a flash made a false cut, rerun with `--threshold 0.2`
  or `0.4` and `--min-shot`.
- If any shot shows `analysisError`, rerun `--analyze` (rate limits are retried automatically).

---

## Phase 2: Complete VIDEO_SPEC.md

`VIDEO_SPEC.md` is the single source of truth. Parts 1-4 are measured; leave those numbers exactly as written.
"About" and "similar to" are not allowed in parts 1-4. Fill in:

1. **Overview**: our purpose and the budget cap.
2. **Part 5, our creative layer**:
   - Brand: name, palette as hex, wordmark, end-card copy. A placeholder brand needs a name that is not an
     existing well-known brand; tell the user to trademark-check it before real use.
   - Characters: each designed from scratch. Write one line on how each differs from the reference's cast in 4b
     (silhouette, palette, outfit, species or style).
   - Script: our own lines, sized to the measured pace in part 4 (words per second × speech span).
   - Music brief: genre, tempo and energy may follow part 4; the track is generated new.
   - Text system: a font, size, colour and position for each text role in part 3; all copy is ours.
   - Slot prompts: write `prompt` for every slot in `template.json`. Keep each slot's timing and grammar. Add a
     template-level `"style"` line and `"references"` for character and set sheets (see Phase 3).
3. **Part 6, production plan**: models, seconds and quotes. Group slots into multi-shot clips (`--group 15`);
   Seedance bills at least 4 seconds per clip, so one clip per short slot can cost two to three times as much.
4. **Part 7, originality checklist**: tick every box before any paid step.

---

## Phase 3: Build from the spec

Read VIDEO_SPEC.md and template.json completely before writing a file. Build only from them.

### 3a. Reference images (character and set sheets)

- Generate with `gpt:Image` (1K, the spec's aspect). Characters on a plain backdrop, full body; sets with no
  people and no readable text. Stylised characters work as Seedance references; **photoreal faces are rejected**
  by Seedance's filter, so for realistic people describe them in text instead of passing an image.
- Build them first with their own `.svrun`, inspect the PNGs, and only then spend on video.
- Add them to `template.json`: `"references": [{ "path": "./references/pip.png", "role": "is Pip, the lead
  character", "personReference": true }, { "path": "./references/store.png", "role": "is the store",
  "personReference": false }]`.

### 3b. Picture

```bash
node /app/tools/shot-list.mjs --svml analysis/reference/template.json --group 15 --out .
hypit check main.svrun && hypit plan main.svrun && hypit pricing main.svrun
```

- `--svml` writes `main.svml`, `main.svrun` and `look.svs` with one Seedance clip per group, each cut to its
  slots' frames. Compare the pricing quote with the budget cap; stop and ask if it is over.
- Then extend `main.svml` from part 5 of the spec: music (`asset:Audio` → `mediaop:Normalize` → `audio:Clip` with
  `gain` and `fade-out`), voiceover, titles, captions, deal callouts and the end card (`@hypit/text-fine`).

### 3c. Sound

- Music: Lyria 3 through OpenRouter (`google/lyria-3-clip-preview`, about $0.04 per 30 s), streamed from
  `/chat/completions` with `modalities: ["text","audio"]`. Ask for no vocals unless the spec says otherwise.
- Voice: an ElevenLabs preset through OpenRouter (`/audio/speech`, `elevenlabs/eleven-v3`, a voice from the
  model's `supported_voices`). For captions, get word timings from `/audio/transcriptions` with
  `response_format: "verbose_json"` and `timestamp_granularities: ["word"]`, and place text windows on frames.
- Master to the spec's loudness (−14 LUFS for social is typical) with peaks at or below −1 dBTP.

### 3d. Build, verify, fix

1. `hypit runtime up --endpoint html.local --endpoint media.local`, then `hypit build main.svrun`; poll
   `hypit status <id> --json`.
2. Export to a **new** filename each time (`hypit get` will not overwrite): `exports/<name>-v<N>.mp4`.
3. Verify against part 8 of the spec:
   ```bash
   node /app/tools/shot-list.mjs exports/<name>-vN.mp4 --out analysis/render-vN --metrics
   ```
   Compare duration, shot count, average shot, first cut and loudness with the targets. Look at the contact
   sheet and a 1 fps sheet for character consistency, misspelled generated text and callouts that cross a cut.
4. Fix composition, timing and text with free re-renders: keep generated clips with `<build-record>` +
   `<satisfy>` in the `.svrun`. Re-generate a clip only when the picture itself is wrong, and quote it first.
5. Send the user the video and a `file_link` download URL.

---

## Output

```
Remake complete: {project}
Download: {signed URL, 7 days}

Format match (reference → ours):
  Duration {a}s → {b}s · Shots {a} → {b} · Average shot {a}s → {b}s · First cut {a}s → {b}s · Loudness {a} → {b} LUFS

Ours:
  Brand {name}, palette {hex list}; characters {names}; music {brief}; voice {preset}

Cost: {actual from the balance change} against a quote of {quote} (budget {cap})

Known gaps: {anything not matched, substituted or covered}
```

---

## Error handling and lessons

- **Every window must end inside the timeline.** A window `from` plus a media extent that overruns `end` fails the
  build *after* paid clips have been submitted. Compute end frames before building.
- **A failed build may already have paid for clips.** Before rebuilding, grep the project for job ids
  (`grep -rhoa "gen-vid-[A-Za-z0-9_-]*" .hypit`), read them from OpenRouter (`GET /api/v1/videos/{id}`), download
  finished takes (`/videos/{id}/content`) and reuse them with `<file>`/`<build-record>`. Never resubmit blindly.
  Balances update after jobs finish, so a low charge right after a failure proves nothing.
- **Generated text misspells.** Phone screens, signs and packaging come out garbled even with "no readable text".
  Cover them with designed text-fine graphics placed over the measured screen area, or frame them out.
- **Seedance:** reference audio needs a visual reference beside it; audio and video references travel as HTTPS
  links (the server stages them at `/staged`); photoreal faces in reference images are refused; durations are whole
  seconds from 4 to 15; Mini at 720p is $0.0756 per second.
- **text-fine:** plain text in more than one paragraph collides on generated run ids; wrap each run in
  `<typo:Span id="...">`. Long lines can wrap inside a word; split them into explicit paragraphs.
- **Recipes:** `film:Film` needs `appearance={look.film.main}`; text recipes reject `stack-order`.
- **Downloads:** YouTube refuses server and sandbox downloads ("Sign in to confirm you're not a bot"); use an upload
  link. Stock photos, when the spec allows them, must be CC0, public domain or CC BY (not share-alike), with a
  credits file.
- **OpenRouter balance:** audio analysis needs at least $0.50; a negative balance blocks all generation.

## Change log

| Date | Changes |
| --- | --- |
| 2026-10-20 | Initial version, from the Budapest reel, Pepper Lane ad and couple-formula builds: measured-format spec, paraphrased content summary, grouped multi-shot Seedance clips, verification against measured targets, and the failure lessons above. |
