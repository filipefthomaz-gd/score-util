# MuseScore Video Exporter

Converts `.mscz` files to video with a scrolling playback cursor.

## How it works

1. **`modifyScore`** (`lib/modify-score.js`) — repackages the `.mscz` (a zip) before export:
   - Single-page mode: rewrites `score_style.mss` to force one system per page (`minSystemDistance = maxSystemDistance = 4096`), disable vertical spread, hide headers/footers; strips `VBox` (title frames) from `.mscx`
   - Dual-page mode: copies `.mscx` and `score_style.mss` byte-for-byte — **zero modifications** — so layout is identical to MuseScore/musescore.com
   - Always rewrites `audiosettings.json` if `--audio` volumes are specified

2. **`mscore --score-media`** (`lib/utils.js`) — runs MuseScore CLI on the modified score to produce a JSON blob containing base64 SVGs (one per page), position XMLs (`spos`/`mpos`), and audio metadata

3. **`createVideo`** (`lib/create-video.js`) — renders frames:
   - Parses `mpos`/`spos` to build keyframes (cursor x position over time)
   - **Single-page**: crops each SVG to a 16:9 viewport around the current system + margin; renders via `resvg`
   - **Dual-page**: renders full page pairs side-by-side; cursor is a vertical line drawn in pixel space
   - Pipes raw RGBA frames to `ffmpeg`

## Key lessons

- Manual element offsets in `.mscx` are **relative** to auto-layout positions — any style change that triggers re-layout (system distances, vertical spread, header/footer) shifts elements away from where the user placed them
- For dual-page, the only safe approach is to pass the score through unmodified so MuseScore produces the exact same SVGs as the app
- The XML re-serialization (`modifyXml`) can subtly corrupt `.mscx` even with no intentional changes — avoid it unless actually needed
- `mscore --score-media` handles multi-page SVG export correctly; `--export-to .svg` does not (MuseScore 4 regression)
