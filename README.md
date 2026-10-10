# ReplayStrike

Find the game clips already on your PC, make them look great, and share them in seconds.

ReplayStrike looks for clips from NVIDIA Instant Replay / Highlights, Xbox Game Bar, AMD ReLive, Medal and Outplayed, plus anything in your Videos folder. You can add other folders in **Folders & accounts**. It never records anything and never changes your original clips; edits are saved as new files in `Videos\ReplayStrike`.

## Finding things

The sidebar splits the library three ways: **All clips** is your raw recordings, **My edits** is everything you saved, compressed for Discord, sent to YouTube or built as a reel (each labelled with how it was made), and **Shared links** is clips you uploaded to Streamable.

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

ReplayStrike is a Tauri 2 app: a Rust backend in `src-tauri/` and a plain HTML/CSS/JS interface in `renderer/`. You need Rust, the Visual Studio C++ Build Tools and Node (only for the Tauri CLI).

```bash
npm install
powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg.ps1
npm run dev
```

`fetch-ffmpeg.ps1` downloads the ffmpeg and ffprobe binaries the app bundles; they are too large to keep in git.

## Build the installer

```bash
npm run build
```

The result is `src-tauri/target/release/bundle/nsis/ReplayStrike_0.3.0_x64-setup.exe`: a per-user installer with ffmpeg included, for 64-bit Windows 10/11. `npm run icons` regenerates the app icons from `build/icon.png`.

## Layout

| Path | What it holds |
| --- | --- |
| `src-tauri/src/main.rs` | App setup and every command the interface can call |
| `src-tauri/src/ffmpeg.rs` | Probing, thumbnails, the effects filter graph, exports and reels |
| `src-tauri/src/detect.rs` | Finding recorder folders (registry and known locations) |
| `src-tauri/src/library.rs` | Scanning folders into clips |
| `src-tauri/src/streamable.rs` | Streamable upload |
| `src-tauri/src/store.rs` | JSON settings storage |
| `renderer/bridge.js` | The only place the interface talks to Rust |

## Building on Windows

Keep the project at a path without an apostrophe (for example `C:\Dev\ReplayStrike`). Tauri's Windows resource step fails with `RC2135: file not found` when the path contains one, and drive-letter mappings do not work around it.
