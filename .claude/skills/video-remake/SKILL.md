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
| Where text sits and what role it plays, and whether it is overlaid or part of the scene | Every word on screen, every prompt |
| People per slot (featured and background), which slots share a recurring character, whose hands a close-up shows, which slots repeat one camera setup | Who those characters are and where the set is |
| Framing of the main subject per slot: facing, position, how much of the body, expression; focus depth; brightness and saturation | Poses, gestures, palette and hue |
| Medium per slot (animation, live action, graphics), phone and screen inserts and held props, end-card layout by zone | The product, the app screens, the props themselves |
| Voice phrase timing and word count per phrase, voice type and delivery, music tempo and beat sync | Every voice line (same word count, our words) |

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
- `template.json`, `template.md` (`shot-list.template@2`): the slot structure with an empty `prompt` per slot, the
  frames of each slot at the timeline rate, a **Hold constant** list (featured people and extras per slot, framing
  and expression of the main subject, recurring characters and whose hands each close-up shows, repeated setups,
  medium changes, focus depth, phone motif, screen and end-card layouts, overlay versus in-scene text and its kinds,
  brightness and saturation per slot, voice phrases with their roles, tempo), empty `castMap` and `setupMap` entries
  for every recurring character and setup, and a voice phrase table with an empty `line` per phrase
- Labels are voted: each shot is labelled twice from different frames and a third time when the two disagree
  (`--passes`, `label_agreement` per shot); continuity is labelled twice and only agreed pairings are kept, with a
  thumbnail check that splits off a "repeat" whose frame looks different; speech is transcribed from two encodings
  and only words both hear are counted
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
   - Script: one line of our own per voice phrase in `template.json` (`voiceover.phrases[].line`), with the same
     word count (plus or minus one) so it lands on the same slots. If the reference has a voiceover, ours has one.
   - Music brief: genre, tempo and energy may follow part 4; the track is generated new.
   - Text system: a font, size, colour and position for each text role in part 3; all copy is ours.
   - Fill `castMap` (our character for each recurring id, for example `"C1": "Pip"`) and `setupMap` (one
     description of our set per repeated setup). `--svml` then names the same character and describes the same set in
     every slot that repeats it, and writes each slot's framing, expression, extras, prop, setting and focus.
   - Slot prompts: write `prompt` for every slot in `template.json`. Keep each slot's timing, grammar and every
     Hold constant line: the same number of people, our recurring character in the same slots, one set and camera
     position for slots that repeat a setup, the same medium (a live-action food macro stays live action), a phone
     held up where theirs is, and text in the scene where theirs is in the scene. Add a template-level `"style"`
     line (or `"styleByMedium"`) and `"references"` for character and set sheets (see Phase 3).
   - Screen inserts: when the reference shows a hand holding a phone, generate that hand (the same character's
     sleeve when the template names an owner) holding a phone with a solid green screen (`--svml` asks for that), then
     key the green and lay our designed screen into it, so a tapping finger stays in front. A flat graphic card is a
     different shot.
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

For a template@2 reference (repeated setups, recurring cast), generate by setup and assemble:

```bash
node /app/tools/shot-list.mjs --svml template.json --group 15 --group-by setup --margin 0.25 --out .
# build clips.svrun (paid, 3d), export each clip to assets/takes/<clip id>.mp4, then:
node /app/tools/assemble.mjs --plan clips-plan.json --template template.json --takes assets/takes --out assets/slots
```

`--group-by setup` puts every slot of a repeated setup in one clip (same set, light and camera), never mixes media,
and writes `clips-plan.json`. `assemble.mjs` finds each clip's cuts (a cut between two shots of one setup scores
low; it searches for that weaker peak), cuts each slot from inside its shot, slows a short shot by up to 1.35x with
motion-interpolated frames, grades each slot into the template's brightness and saturation, and writes
`assembly-sheet.jpg` (first, middle and last frame per slot). Read the sheet and the warnings before going on.
A slot whose shot came out too short or wrong can be regenerated in a small replacement clip: append it to the plan
and mark the original shot `"skip": true`. Regenerate the whole setup group, not one slot of it, or the repeat is
lost. Put the longest shot first in a multi-shot clip; the last shots tend to come out short.

Phone screens: generate them solid green, cut with `--no-grade` into a second folder, run
`python3 /app/tools/key-screen.py <cut> <before.png> <after.png> <out> --mode track --button x0,y0,x1,y1` for
close-ups and `--mode all` for phones held up in wider shots, with our designed screens (drawn, never generated, so
every word is spelled right), then apply the slot's grade from `assembly.json`. Track mode follows the phone body,
not the visible green, so a thumb over a corner no longer squashes the screen, and it replaces only each pixel's
screen share, so a fast fingertip stays a finger instead of a ghost; the button flips when the finger reaches it.
`--glow` removes the green light a screen throws on a face that looks at it. Better still, when there is budget:
ask for a plain light-grey screen (a real phone's glow, no green on faces or fingers) and pass one phone reference
image so the case is the same in every shot.

For a template@1 reference, or a single-clip-per-group build:

```bash
node /app/tools/shot-list.mjs --svml analysis/reference/template.json --group 15 --out .
```

`--svml` writes `main.svml`, `main.svrun` and `look.svs` with one Seedance clip per group, each cut to its slots'
frames at the template's `timelineFps` (24 for 23.976 fps references, so 24 fps Seedance footage needs no repeated
frames). Each shot line carries its people count, hands and phone instructions; a change of medium starts a new clip. Then extend `main.svml` from part 5 of the spec: music (`asset:Audio` → `mediaop:Normalize` → `audio:Clip`
with `gain` and `fade-out`), voiceover, titles, captions, deal callouts and the end card (`@hypit/text-fine`).

### 3c. Sound

- With a template@2 voice map, one command does all of it:
  `node /app/tools/soundtrack.mjs --template template.json --out assets/audio --music-prompt "<brief>"` speaks each
  phrase line with the preset voice, fits it into its measured window (at most 1.25x faster; it warns when a line
  is too long, often because of commas), generates the music at the template's tempo, stretches and shifts it onto
  the reference's beat grid, ducks it under the voice and masters `mix.wav` to -14 LUFS. Reuse a track with `--music`.
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
4. Verify against the reference analysis (about $0.02):
   ```bash
   node /app/tools/shot-list.mjs exports/<name>-vN.mp4 --out analysis/render-vN --compare analysis/reference/shots.json
   ```
   This measures the render on the reference's own slots and writes `DELTA.md`: every cut, frame rate, repeated
   frames, brightness, saturation, loudness, tempo, beat sync, voice, and per slot people, medium, device, prop,
   setting, text layer, size, motion and voice words, plus repeated setups and recurring characters. Fix every miss
   on a Hold constant variable; camera move, prop and setting labels are noisier, so check those misses by eye. Look
   at the contact sheet and a 1 fps sheet for character consistency, misspelled generated text and callouts that
   cross a cut.
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
`continuity`, `phrase_roles`, `audio_labels`, `content_summary`, `own_content`) and `/audio/transcriptions` with a `words` array
exercises the whole `--analyze --spec` and `--compare` paths, with and without `--own`, at no cost.

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
- **OpenRouter balance:** audio analysis needs at least $0.50; a negative balance blocks all generation, and an
  analysis run that hits it mid-way reports every unlabelled check as a miss (HTTP 402 in the log), so its score is
  void. Compare this key's usage (`/api/v1/key`) with the account's (`/api/v1/credits`) before and after a build:
  a gap is another key spending from the same account.
- **Edit tracks:** a `visual:Track` holds one clip per window; overlays (fine print, an end-card logo) go on their
  own track.
- **Labelling:** Gemini sometimes refuses a frame set (HTTP 200 with "blocked the response"); the tool retries that
  shot on `--fallback-model` (default `openai/gpt-4.1-mini`).
- **Template only held timing (Pepper Lane v3).** Matching every cut to the frame still produced a different-feeling
  ad: no voiceover where the reference talks over 15 of 20 slots, singles where it uses a recurring pair, an empty
  store where it shows ten shoppers, flat app cards where it shows a hand holding a phone, clay food where it
  switches to live action, overlays where its text is in the scene, a 30 fps timeline that repeated every fifth
  frame, and music 13% slower. Template@2 records each of these, and `--compare` checks them.
- **Cutting multi-shot clips into slots.** Generated shots drift from the planned spans (Pepper Lane v3: 1 to 2 s),
  and a clip can merge or drop a planned cut. Map slots from the detected cuts, not the plan. Scene detection reports
  a cut up to one frame late, and two shots on the same set score low, so re-run it at `scene>0.12` and check the
  frames on either side. Keep every segment 2 frames clear of a cut, then check each one has no cut inside it. A shot
  shorter than its slot gets a mild slowdown (at most about 1.35x); with ffmpeg, `-t` goes *before* `-i`, or the
  `setpts` stretch is cut back to the source length.

## Change log

| Date | Changes |
| --- | --- |
| 2026-10-22 | Setup-grouped generation (`--group-by setup`, `groupWith`), `assemble.mjs` (cut matching with soft cuts, interpolated slowdown, look grading, replacement clips), `key-screen.py` (green-screen phone UIs, glow removal), `soundtrack.mjs` (phrase-fitted voice, tempo- and beat-matched ducked music, mastering). Pepper Lane v4: 386 of 464 format checks (reference against itself 454 of 463); model-free checks 65 of 66 (v3: 45 of 66). |
| 2026-10-22 | Template@2: Hold constant variables per slot (people, hands, medium, device, prop, setting, text layer, layout), continuity (recurring characters, repeated setups), voice phrase map, measured tempo and beat sync, timeline fps; `--compare` writes DELTA.md; `--svml` uses the new fields; fallback labelling model. |
| 2026-10-22 | Framing, expression, extras, focus, kinds of text, per-slot look, hands owner and phrase roles in the template; voted labels, agreed continuity with a thumbnail check, two-encoding transcription; `castMap`/`setupMap` in `--svml`; green-screen phone inserts. |
| 2026-10-22 | Lessons for cutting multi-shot generated clips into measured slots (Pepper Lane v3 madlib build). |
| 2026-10-22 | Two-stage builds (`hypit-stage.mjs clips`/`final`), preflight `lint` and `doctor`, failure protocol with `recover`, the provider job ledger, and frame-exact format matching with all compositions, poses, choreography and characters our own. |
| 2026-10-20 | Own-content mode (`--own`): transcript, exact on-screen text, shot descriptions, full designs, prefilled prompts, rights checklist. Dropped connections are retried; `OPENROUTER_BASE_URL` for mock testing. |
| 2026-10-20 | Initial version, from the Budapest reel, Pepper Lane ad and couple-formula builds: measured-format spec, paraphrased content summary, grouped multi-shot Seedance clips, verification against measured targets, and the failure lessons above. |
