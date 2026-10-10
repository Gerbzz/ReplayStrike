use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

#[derive(Clone, Serialize)]
pub struct Source {
    pub label: String,
    pub path: String,
    pub kind: &'static str,
    pub exists: bool,
    pub count: usize,
}

/// GeForce Experience / NVIDIA App store the recording folder as UTF-16 bytes.
fn nvidia_path() -> Option<PathBuf> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\NVIDIA Corporation\Global\ShadowPlay\NVSPCAPS")
        .ok()?;
    let raw = key.get_raw_value("DefaultPathW").ok()?;
    let units: Vec<u16> = raw.bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
    let text = String::from_utf16_lossy(&units);
    let text = text.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!text.is_empty()).then(|| PathBuf::from(text))
}

/// Returns every place we know to look, whether or not it exists on this PC,
/// so the UI can show what was checked. Order matters: a clip is credited to
/// the first source that contains it, so specific folders come before Videos.
pub fn detect_sources(videos: &Path, user_folders: &[String]) -> Vec<Source> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local"));

    let mut candidates: Vec<(String, PathBuf, &'static str)> = Vec::new();
    for folder in user_folders {
        let p = PathBuf::from(folder);
        let label = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| folder.clone());
        candidates.push((label, p, "user"));
    }
    let mut auto = |label: &str, p: PathBuf| candidates.push((label.to_string(), p, "auto"));
    if let Some(p) = nvidia_path() {
        auto("NVIDIA", p);
    }
    auto("NVIDIA", videos.join("NVIDIA"));
    auto("NVIDIA Highlights", local.join("Temp").join("Highlights"));
    auto("Xbox Game Bar", videos.join("Captures"));
    auto("AMD ReLive", videos.join("Radeon ReLive"));
    auto("Medal", videos.join("Medal"));
    auto("Medal", home.join("Medal"));
    auto("Outplayed", videos.join("Overwolf").join("Outplayed"));
    auto("Outplayed", videos.join("Outplayed"));
    auto("Videos", videos.to_path_buf());

    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for (label, path, kind) in candidates {
        let text = path.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        if text.is_empty() || !seen.insert(text.to_lowercase()) {
            continue;
        }
        sources.push(Source { label, exists: Path::new(&text).is_dir(), path: text, kind, count: 0 });
    }
    sources
}
