# ReplayStrike

**by PWDS**

**Give your best moments a second look.**

ReplayStrike gathers existing game recordings from common Windows clip folders into a personal library. Trim and style a favorite, combine clips into a reel, or prepare a file or link to share while keeping the original recordings intact.

## Highlights

- Find clips from common recorders and folders you add.
- Trim, style, and combine clips into highlight reels.
- Prepare exports for Discord, Streamable, or YouTube.

## Current status

Windows source prototype. Clip scanning, edit/export, reel, local analysis, and sharing paths exist in source, but this publication has not been built or verified end to end on a clean machine. FFmpeg and the optional local speech engine are fetched separately; no verified installer is included.

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

Streamable needs an account (email and password, entered in **Folders & accounts**). Check its current upload limits and retention terms before sharing; the app can compress larger edits.

The YouTube action prepares a file and opens the upload page; it does not upload directly.

## Hype moments and auto montage

Open a clip and press **Find hype moments**. ReplayStrike transcribes the clip on your PC and scores every moment from what is said (callouts, swearing, "no way", "oh my god") and from loudness spikes, so clips with no voice still get results. The best moments are listed with a quote, marked on the timeline, and **Auto highlight** trims to the top one with slow-mo on it. The transcript is under the list.

Select one or more clips and press **Auto montage** to analyse them all, keep the strongest moments across them and join those into one video, in the order they happened.

The speech model (about 141 MB) is downloaded the first time you use this and is kept in `%APPDATA%\ReplayStrike\models`. Nothing is uploaded; transcription runs locally with whisper.cpp. The model is English-only.

## Run from source

ReplayStrike is a Tauri 2 app: a Rust backend in `src-tauri/` and a plain HTML/CSS/JS interface in `renderer/`. You need Rust, the Visual Studio C++ Build Tools and Node (only for the Tauri CLI).

```bash
npm install
powershell -ExecutionPolicy Bypass -File scripts\fetch-binaries.ps1
npm run dev
```

`fetch-binaries.ps1` downloads ffmpeg, ffprobe and the whisper.cpp speech engine that the app bundles; they are too large to keep in git.

## Build the installer

```bash
npm run build
```

The build is configured for a per-user NSIS installer at `src-tauri/target/release/bundle/nsis/ReplayStrike_0.3.0_x64-setup.exe` on 64-bit Windows 10/11. Its output was not verified in this publication pass. `npm run icons` regenerates the app icons from `build/icon.png`.

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

