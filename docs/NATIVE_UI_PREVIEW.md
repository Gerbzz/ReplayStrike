# Native UI preview — 15 October 2026

The [README image](../assets/screenshots/replaystrike-native-current.png) is a 1416 × 889 PNG of ReplayStrike's actual Tauri/WebView2 window on the Office PC. It shows the library after scanning one original synthetic clip, with its generated thumbnail. No user recordings or local filesystem paths appear in the image.

- Preview source: draft PR [#1](https://github.com/Gerbzz/ReplayStrike/pull/1), commit `e7f4f2a1c071be95d25dc89807d3f86d6d9415c6`. Its opt-in capture mode restricts scanning and app data to one isolated synthetic root. That hook is not in this main revision.
- Hosted Windows verification: [Actions run 38705051223](https://github.com/Gerbzz/ReplayStrike/actions/runs/38705051223) passed `preview_scans_only_its_synthetic_clips_folder`, built the native executable, checked its size, and uploaded a one-day artifact. The source-only preview build omitted absent production packaging sidecars and Whisper resources through a CI configuration override. This was not an installer build.
- Executable SHA-256: `30C66A4C259A94F66F5FB90E0BC4FEC1860E81A16506706E56546B098B88D191` (19,175,936 bytes); the downloaded executable matched the hosted manifest.
- Synthetic input: a locally generated six-second, 960 × 540 H.264 MP4 named `Synthetic Motion Study.mp4`, SHA-256 `78DDD2F622EAD7C149331E1E40B368363C61DD1285B701B3B28513D83756BB7D` (1,764,864 bytes). It was generated from FFmpeg test patterns and is not committed.
- Runtime: the executable launched with `REPLAYSTRIKE_CAPTURE_ROOT` set to an isolated folder containing only that clip. Installed FFmpeg tools supplied clip metadata and the thumbnail. A Windows native-window capture recorded the app; the image was visually checked before publication.
- Published PNG SHA-256: `BD1E7AAF352C030F0F6E9BBAF010CD36C7758CCC6D2179B1E975EE6E98726D07` (55,910 bytes).

This preview verifies launch, isolated clip discovery, metadata/thumbnail generation, and the visible native library state for that draft executable. It does not verify editing, exports, speech analysis, sharing, installer packaging, or clean-machine operation. The executable and synthetic input are not included in this repository.
