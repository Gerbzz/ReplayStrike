use crate::detect::Source;
use crate::ffmpeg::Meta;
use serde::Serialize;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::UNIX_EPOCH;

const VIDEO_EXT: [&str; 6] = ["mp4", "mkv", "mov", "webm", "m4v", "avi"];
const MAX_DEPTH: usize = 4;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: f64,
    pub key: String,
    pub source: String,
    pub game: String,
    pub meta: Option<Meta>,
    /// Path of the cached thumbnail image, once generated.
    pub thumb: Option<String>,
    pub upload: Option<Value>,
    pub edit: Option<Value>,
    pub mine: bool,
    pub kind: Option<String>,
}

/// Cache key that changes whenever the file's contents could have.
fn cache_key(path: &str, size: u64, mtime: f64) -> String {
    let mut h = DefaultHasher::new();
    (path, size, mtime.to_bits()).hash(&mut h);
    format!("{:016x}", h.finish())
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<(String, u64, f64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if depth < MAX_DEPTH {
                walk(&path, depth + 1, out);
            }
            continue;
        }
        let is_video = path
            .extension()
            .map(|e| VIDEO_EXT.contains(&e.to_string_lossy().to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_video {
            continue;
        }
        if let Ok(md) = entry.metadata() {
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            out.push((path.to_string_lossy().into_owned(), md.len(), mtime));
        }
    }
}

/// Walks every existing source and returns one clip per file, credited to the
/// first source that contains it. Fills in each source's clip count.
pub fn scan_files(sources: &mut [Source]) -> Vec<Clip> {
    let mut seen = HashSet::new();
    let mut clips = Vec::new();
    for source in sources.iter_mut() {
        source.count = 0;
        if !source.exists {
            continue;
        }
        let mut files = Vec::new();
        walk(Path::new(&source.path), 0, &mut files);
        for (path, size, mtime) in files {
            if !seen.insert(path.to_lowercase()) {
                continue;
            }
            source.count += 1;
            // Recorders file clips as <root>\<Game>\<clip>.mp4
            let rel = Path::new(&path).strip_prefix(&source.path).unwrap_or(Path::new(&path));
            let parts: Vec<_> = rel.components().collect();
            let game = if parts.len() > 1 { parts[0].as_os_str().to_string_lossy().into_owned() } else { source.label.clone() };
            let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            clips.push(Clip {
                key: cache_key(&path, size, mtime),
                path,
                name,
                size,
                mtime,
                source: source.label.clone(),
                game,
                meta: None,
                thumb: None,
                upload: None,
                edit: None,
                mine: false,
                kind: None,
            });
        }
    }
    clips
}
