# ReplayStrike

Find the game clips already on your PC, make them look great, and share them in seconds.

ReplayStrike looks for clips from NVIDIA Instant Replay / Highlights, Xbox Game Bar, AMD ReLive, Medal and Outplayed, plus anything in your Videos folder. You can add other folders in **Folders & accounts**. It never records anything and never changes your original clips; edits are saved as new files in `Videos\ReplayStrike`.

## Make it pop

Open a clip and use the panel on the right. The preview updates live, and every share button uses what you set.

| Control | What it does |
| --- | --- |
| Trim | Drag the handles under the video, or press `I` / `O` at the playhead |
| Look | Cinematic (grade, vignette, letterbox), Vibrant or Noir |
| Shape | Landscape, Vertical crop, Vertical fit (blurred background) or Square |
| Slow-mo | Press `M` at the big moment; about 1.5 seconds around it plays at half speed |
| Title | Text shown for the first 3 seconds |
| Music | Your own audio file, mixed under the game audio |
| Fade | Fade in and out |

Trim and slow-mo are remembered per clip.

## Highlight reels

Hover a clip and tick the circle (or Ctrl+click) to select several, then **Create highlight reel**. Clips play in the order you picked them. Each uses its own trim and slow-mo; clips you have not trimmed contribute their last 15 seconds.

## Sharing

| Button | What it does | Plays inline in Discord |
| --- | --- | --- |
| Upload to Streamable | Uploads the edit and copies the link | Yes |
| Copy for Discord | Compresses the edit to 10, 50 or 500 MB and copies the file, ready to paste | Yes |
| Send to YouTube | Prepares the file and opens YouTube's upload page | Yes, once uploaded |

Streamable needs a free account (email and password, entered once in **Folders & accounts**). Free accounts allow 250 MB and 10 minutes per video and Streamable deletes free videos after about 90 days. Bigger edits are compressed to fit automatically.

YouTube is a hand-off rather than a direct upload because YouTube locks videos uploaded through its API by unaudited apps to private.

## Run from source

```bash
npm install
npm rebuild ffmpeg-static
npm start
```

## Build the portable .exe

```bash
npm run dist
```

The result is `dist/ReplayStrike 0.2.0.exe`: a single file with ffmpeg included that runs on any 64-bit Windows 10/11 PC without installing anything. `npm run icon` regenerates the app icon.
