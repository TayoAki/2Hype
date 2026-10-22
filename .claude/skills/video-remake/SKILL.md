---
name: video-remake
description: "Study any reference video, document it into VIDEO_SPEC.md, then produce a new video with Hypit. Three-phase workflow: analyze → spec → build. Someone else's video: copy its format only, never its footage, words, music, characters or branding. The user's own video (--own): full transcript, copy and designs, and its material may be reused to make new versions."
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
| Duration, aspect, fps, every cut point and shot length, to the frame | Brand, palette, logo, slogan, end card |
| Shot grammar per slot: size, angle, camera move, beat role | Characters (designed from scratch), settings |
| Beat order and how many shots each beat gets | Every composition, pose, gesture and piece of choreography |
| Pacing curve, first-cut time, motion, brightness, saturation, contrast | Script and voiceover lines, deals and claims |
| Loudness and true peak, voiceover presence and pace, music genre and tempo | Music (generated), voice (licensed preset) |
| Where text sits and what role it plays | Every word on screen, every prompt |

The reference's content is recorded only as a short **paraphrased summary** (message, offers, call to action,
brand positioning, cast archetypes, purpose of each on-screen text) so we understand it and can make ours
clearly different. Never write verbatim transcripts, song lyrics or exact on-screen copy into the spec, never
describe a character in enough detail to recreate it, and never feed reference frames, clips or audio into a
generator. If the user asks for a shot-for-shot or near-identical copy of someone else's video, decline that part and offer
this workflow or a re-edit of footage they own.

### Own content (`--own`)

When the reference is the user's own video (they made it or hold the rights to adapt it), the rules above relax:

- Phase 1 keeps the full transcript with word timings (`transcript.json`, `transcript.srt`), each shot's exact
  on-screen text and a detailed description, and full character and brand designs including the tagline.
- `template.json` starts every slot prompt from its shot description and lists the shot's source frame, so a new
  version only edits what changes.
- Phase 3 may reuse the original material: re-cut its footage, use its frames as Seedance references, reuse its
  music, and clone the user's own voice (with consent) through HypiHub's voice clone.

Take the user's word, within reason: if a file is plainly someone else's (another company's logo and ad, a
celebrity, a well-known character), treat it as third-party whatever it is called. Licensed parts keep their
terms: stock footage, fonts and especially licensed music. A transcript can pick up sung lyrics from licensed
tracks; do not reuse those or paste them anywhere. Every real person shown or voiced must have consented.

## Inputs

Ask for these before starting (or take them from the user's message):

1. **Reference video and whose it is**: a URL or a file, and whether it is the user's own (use `--own`) or
   someone else's. Instagram and TikTok usually download on the server; YouTube blocks
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

For the user's own video add `--own`:

```bash
node /app/tools/shot-list.mjs references/source.mp4 --out analysis/reference --analyze --own --spec
```

This writes, under `analysis/reference/`:

- `shots.json`, `shots.csv`: every cut with timecodes, plus per-shot labels, motion and palette
- `frames/`, `contact-sheet.jpg`, `index.html`: one frame per shot, for the human reviewing the analysis
- `template.json`, `template.md`: the slot structure with an empty `prompt` per slot
- `VIDEO_SPEC.md`: parts 1-4 and 4b filled with measured values; parts 5-7 left for us
- with `--own`: `transcript.json` and `transcript.srt`, spec parts 4c (transcript) and 4d (shot descriptions and
  exact on-screen text), and prompts prefilled in `template.json`

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
4. **Part 7, originality checklist** (or, with `--own`, the rights checklist): tick every box before any paid step.

With `--own`, part 5 is "what stays and what changes": list what this version keeps (characters, brand, voice,
music, shots) and what it changes (offer, product, length, aspect, lines, shots to replace), then edit only the
affected slot prompts.

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
```

`--svml` writes `main.svml`, `main.svrun` and `look.svs` with one Seedance clip per group, each cut to its slots'
frames. Then extend `main.svml` from part 5 of the spec: music (`asset:Audio` → `mediaop:Normalize` → `audio:Clip`
with `gain` and `fade-out`), voiceover, titles, captions, deal callouts and the end card (`@hypit/text-fine`).

### 3c. Sound

- Music: Lyria 3 through OpenRouter (`google/lyria-3-clip-preview`, about $0.04 per 30 s), streamed from
  `/chat/completions` with `modalities: ["text","audio"]`. Ask for no vocals unless the spec says otherwise.
- Voice: an ElevenLabs preset through OpenRouter (`/audio/speech`, `elevenlabs/eleven-v3`, a voice from the
  model's `supported_voices`). For captions, get word timings from `/audio/transcriptions` with
  `response_format: "verbose_json"` and `timestamp_granularities: ["word"]`, and place text windows on frames.
- Master to the spec's loudness (−14 LUFS for social is typical) with peaks at or below −1 dBTP.
- Make the sound files before the build, so `lint` can measure them.

### 3d. Build in two stages, verify, fix

Paid generation and the edit never share a Build. An edit mistake then costs a free re-render, never a payment.

0. **Preflight** (every time):
   ```bash
   hypit doctor --endpoint openrouter.default        # key accepted and balance above the quote (+$0.50 for audio)
   node /app/tools/hypit-stage.mjs lint main.svml    # every Window inside its Timeline; must print ✓
   ```
   Fix every lint error before going on. A rejected key (HTTP 401) means the user must update OPENROUTER_API_KEY
   in Railway's service variables; never ask for the key in chat.
1. **Clips stage (paid):**
   ```bash
   node /app/tools/hypit-stage.mjs clips main.svml --keep main.svrun   # targets only videos and images
   hypit check clips.svrun && hypit plan clips.svrun && hypit pricing clips.svrun
   hypit runtime up --endpoint html.local --endpoint media.local && hypit build clips.svrun
   ```
   Compare the quote with the budget cap first; stop and ask if it is over. Poll `hypit status <id> --json`.
   Export and look at every generated clip and image (contact sheets) before the edit stage.
2. **Edit stage (free):**
   ```bash
   node /app/tools/hypit-stage.mjs final main.svml --build <clips build id>
   node /app/tools/hypit-stage.mjs lint main.svml
   hypit pricing main.svrun    # must show every request as "No Provider charge"
   hypit build main.svrun
   ```
3. Export to a **new** filename each time (`hypit get` will not overwrite): `exports/<name>-v<N>.mp4`.
4. Verify against part 8 of the spec:
   ```bash
   node /app/tools/shot-list.mjs exports/<name>-vN.mp4 --out analysis/render-vN --metrics
   ```
   Compare duration, shot count, average shot, first cut and loudness with the targets. Look at the contact
   sheet and a 1 fps sheet for character consistency, misspelled generated text and callouts that cross a cut.
5. Fix composition, timing and text by editing `main.svml` and rebuilding the edit stage. Re-generate a clip only
   when its picture is wrong: change that element, rerun `clips` with `--keep` so the rest are reused, and quote it.
6. Send the user the video and a `file_link` download URL.

### 3e. If a Build fails

1. Stop. Do not rebuild yet, and do not trust the balance: OpenRouter charges when a job finishes.
2. `OPENROUTER_API_KEY=... node /app/tools/hypit-stage.mjs recover --download references/recovered` lists every
   submitted job with status and cost and saves finished ones.
3. Fix the cause (lint again), then rebuild. Projects created or refreshed with `project_create` since the job ledger
   shipped reuse a pending or finished job for an unchanged request automatically; recovered files can also be
   brought in as `<file>` Candidates.

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

## Testing the tool without credits

`OPENROUTER_BASE_URL` points `tools/shot-list.mjs` at any OpenRouter-compatible server. A small local mock that
answers `/chat/completions` by `response_format.json_schema.name` (`shot_labels`, `own_shot_labels`,
`audio_labels`, `content_summary`, `own_content`) and `/audio/transcriptions` with a `words` array exercises the
whole `--analyze --spec` path, with and without `--own`, at no cost.

## Error handling and lessons

- **Every window must end inside the timeline.** A window `from` plus a media extent that overruns `end` fails the
  build *after* paid clips have been submitted (Pepper Lane: a tagline at 822f lasting 85f in a 900f Timeline cost
  a duplicate $2.05). `hypit-stage.mjs lint` catches this; the two-stage build makes it free when it slips through.
- **A failed build may already have paid for clips.** Follow 3e: `recover` first, never resubmit blindly. Balances
  update after jobs finish, so a low charge right after a failure proves nothing. The provider's job ledger reuses
  jobs for unchanged requests; it covers projects whose Profile has `jobLedgerPath` (rerun `project_create`).
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
- **Cutting multi-shot clips into slots.** Generated shots drift from the planned spans (Pepper Lane v3: 1 to 2 s),
  and a clip can merge or drop a planned cut. Map slots from the detected cuts, not the plan. Scene detection reports
  a cut up to one frame late, and two shots on the same set score low, so re-run it at `scene>0.12` and check the
  frames on either side. Keep every segment 2 frames clear of a cut, then check each one has no cut inside it. A shot
  shorter than its slot gets a mild slowdown (at most about 1.35x); with ffmpeg, `-t` goes *before* `-i`, or the
  `setpts` stretch is cut back to the source length.

## Change log

| Date | Changes |
| --- | --- |
| 2026-10-22 | Lessons for cutting multi-shot generated clips into measured slots (Pepper Lane v3 madlib build). |
| 2026-10-22 | Two-stage builds (`hypit-stage.mjs clips`/`final`), preflight `lint` and `doctor`, failure protocol with `recover`, the provider job ledger, and frame-exact format matching with all compositions, poses, choreography and characters our own. |
| 2026-10-20 | Own-content mode (`--own`): transcript, exact on-screen text, shot descriptions, full designs, prefilled prompts, rights checklist. Dropped connections are retried; `OPENROUTER_BASE_URL` for mock testing. |
| 2026-10-20 | Initial version, from the Budapest reel, Pepper Lane ad and couple-formula builds: measured-format spec, paraphrased content summary, grouped multi-shot Seedance clips, verification against measured targets, and the failure lessons above. |
