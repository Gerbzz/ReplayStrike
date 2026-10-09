# ClipDeck

Find, watch, trim and share the game clips already on your PC.

ClipDeck looks for clips from NVIDIA Instant Replay / Highlights, Xbox Game Bar, AMD ReLive, Medal and Outplayed, plus anything in your Videos folder. You can add other folders in **Folders & accounts**. Nothing is recorded or changed; it only reads the clips your recorder already saved.

## Sharing

| Button | What it does | Plays inline in Discord |
| --- | --- | --- |
| Upload to Streamable | Uploads the selection and copies the link | Yes |
| Copy for Discord | Compresses the selection to 10, 50 or 500 MB and copies the file, ready to paste | Yes |
| Send to YouTube | Prepares the file and opens YouTube's upload page | Yes, once uploaded |

Streamable needs a free account (email and password, entered once in **Folders & accounts**). Free accounts allow 250 MB and 10 minutes per video and Streamable deletes free videos after about 90 days. Bigger selections are compressed to fit automatically.

YouTube is a hand-off rather than a direct upload because YouTube locks videos uploaded through its API by unaudited apps to private.

## Trimming

Drag the purple handles under the video, or press `I` and `O` to set the start and end at the current position. Every share button uses the selected range.

## Run from source

```bash
npm install
npm approve-scripts ffmpeg-static
npm rebuild ffmpeg-static
npm start
```

## Build the portable .exe

```bash
npm run dist
```

The result is `dist/ClipDeck 0.1.0.exe`: a single file with ffmpeg included that runs on any 64-bit Windows 10/11 PC without installing anything.
