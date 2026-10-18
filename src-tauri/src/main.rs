#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analyze;
mod detect;
mod ffmpeg;
mod library;
mod store;
mod streamable;

use ffmpeg::{ExportJob, ExportOut, Fx, Meta, Segment};
use library::Clip;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::Store;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Untrimmed clips contribute their final seconds to a reel, where the action usually is.
const REEL_DEFAULT_SECONDS: f64 = 15.0;
const KEYRING_SERVICE: &str = "ReplayStrike";
const KEYRING_USER: &str = "streamable";

struct AppState {
    config: Store,
    meta: Store,
    /// %APPDATA%\ReplayStrike: settings, caches, the speech model.
    data: PathBuf,
    /// Only one transcription runs at a time; it already uses every core.
    analysis_lock: tokio::sync::Mutex<()>,
    thumbs: PathBuf,
    exports: PathBuf,
    temp: PathBuf,
    /// Lowercased path -> clip, for everything found by the last scan.
    clips: Mutex<HashMap<String, Clip>>,
    /// Audio files the user chose through the picker.
    music: Mutex<HashSet<String>>,
    watcher: Mutex<Option<(RecommendedWatcher, Vec<PathBuf>)>>,
    /// Bumped by every scan so an older thumbnail queue stops early.
    scan_gen: AtomicU64,
    /// Opt-in isolated source root for synthetic native-window previews.
    capture_root: Option<PathBuf>,
}

type State = Arc<AppState>;

fn state(app: &AppHandle) -> State {
    app.state::<State>().inner().clone()
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/* ---------- library ---------- */

#[derive(Serialize)]
struct ScanResult {
    sources: Vec<detect::Source>,
    clips: Vec<Clip>,
}

fn capture_sources(root: &Path) -> Vec<detect::Source> {
    let clips = root.join("clips");
    vec![detect::Source {
        label: "Synthetic clips".into(),
        exists: clips.is_dir(),
        path: clips.to_string_lossy().into_owned(),
        kind: "user",
        count: 0,
    }]
}

/// Exports made before records were kept: read the kind and source name back
/// out of "<source name> (<label>)".
fn infer_export(name: &str) -> (Option<String>, Option<String>) {
    let lower = name.to_lowercase();
    if lower.starts_with("montage ") {
        return (Some("Montage".into()), None);
    }
    if lower.starts_with("highlight reel ") {
        return (Some("Reel".into()), None);
    }
    let Some(open) = name.rfind(" (") else { return (None, None) };
    let Some(inner) = name[open + 2..].strip_suffix(')') else { return (None, None) };
    let label = inner.split(' ').next().unwrap_or("").to_lowercase();
    let kind = if label == "youtube" {
        "YouTube".to_string()
    } else if let Some(mb) = label.strip_suffix("mb").filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())) {
        format!("Discord {mb} MB")
    } else if label == "edit" || label == "trim" {
        "Edit".to_string()
    } else {
        return (None, None);
    };
    (Some(kind), Some(name[..open].to_lowercase()))
}

#[tauri::command]
async fn scan(app: AppHandle) -> Result<ScanResult, String> {
    let st = state(&app);
    let capture_root = st.capture_root.clone();
    let videos = if capture_root.is_none() { Some(app.path().video_dir().map_err(err)?) } else { None };
    let folders: Vec<String> = if capture_root.is_none() { st.config.get_as("folders") } else { Vec::new() };
    let (sources, mut clips) = tauri::async_runtime::spawn_blocking(move || {
        let mut sources = match capture_root {
            Some(root) => capture_sources(&root),
            None => detect::detect_sources(videos.as_ref().expect("normal video directory"), &folders),
        };
        let clips = library::scan_files(&mut sources);
        (sources, clips)
    })
    .await
    .map_err(err)?;

    let uploads = st.config.get("uploads");
    let edits = st.config.get("edits");
    let made = st.config.get("exports");
    let mine_root = format!("{}\\", st.exports.to_string_lossy().to_lowercase());
    let by_name: HashMap<String, String> = clips.iter().map(|c| (c.name.to_lowercase(), c.game.clone())).collect();
    let by_path: HashMap<String, String> = clips.iter().map(|c| (c.path.to_lowercase(), c.game.clone())).collect();

    for clip in clips.iter_mut() {
        let id = clip.path.to_lowercase();
        clip.meta = serde_json::from_value(st.meta.get(&clip.key)).ok();
        let thumb = st.thumbs.join(format!("{}.jpg", clip.key));
        if clip.meta.is_some() && thumb.exists() {
            clip.thumb = Some(thumb.to_string_lossy().into_owned());
        }
        clip.hype = load_analysis(&st, &clip.key).map(|a| a.moments.len());
        clip.upload = uploads.get(&id).cloned();
        clip.edit = edits.get(&id).cloned();
        // Anything in the exports folder is one of the user's own edits.
        if id.starts_with(&mine_root) {
            let info = made.get(&id);
            let recorded_kind = info.and_then(|i| i["kind"].as_str()).map(str::to_string);
            let (guess_kind, guess_source) = if recorded_kind.is_some() { (None, None) } else { infer_export(&clip.name) };
            let from_game = info
                .and_then(|i| i["from"].as_str())
                .and_then(|p| by_path.get(&p.to_lowercase()))
                .or_else(|| guess_source.as_ref().and_then(|n| by_name.get(n)))
                .cloned();
            clip.mine = true;
            clip.kind = Some(recorded_kind.or(guess_kind).unwrap_or_else(|| "Edit".into()));
            clip.game = from_game.unwrap_or_else(|| "My edits".into());
        }
    }

    // Let the webview load media from the folders we just scanned.
    let scope = app.asset_protocol_scope();
    for source in sources.iter().filter(|s| s.exists) {
        let _ = scope.allow_directory(&source.path, true);
    }
    watch(&st, &sources);

    *st.clips.lock().unwrap() = clips.iter().map(|c| (c.path.to_lowercase(), c.clone())).collect();
    spawn_meta_queue(&app, &st, &clips);
    Ok(ScanResult { sources, clips })
}

/// Probes clips and renders thumbnails in the background, newest first.
fn spawn_meta_queue(app: &AppHandle, st: &State, clips: &[Clip]) {
    let gen = st.scan_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let mut pending: Vec<Clip> = clips.iter().filter(|c| c.meta.is_none() || c.thumb.is_none()).cloned().collect();
    pending.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    let (app, st) = (app.clone(), st.clone());
    tauri::async_runtime::spawn(async move {
        let slots = Arc::new(tokio::sync::Semaphore::new(2));
        for clip in pending {
            let Ok(permit) = slots.clone().acquire_owned().await else { break };
            if st.scan_gen.load(Ordering::SeqCst) != gen {
                break;
            }
            let (app, st) = (app.clone(), st.clone());
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                // Unreadable or still being written: a later rescan retries it.
                let _ = process_clip(&app, &st, clip).await;
            });
        }
    });
}

async fn process_clip(app: &AppHandle, st: &State, clip: Clip) -> Result<(), String> {
    let path = Path::new(&clip.path);
    let meta = match clip.meta {
        Some(m) => m,
        None => {
            let m = ffmpeg::probe(path).await?;
            st.meta.set(&clip.key, serde_json::to_value(&m).map_err(err)?);
            m
        }
    };
    let thumb = st.thumbs.join(format!("{}.jpg", clip.key));
    if !thumb.exists() {
        ffmpeg::thumbnail(path, meta.duration, &thumb).await?;
    }
    let thumb = thumb.to_string_lossy().into_owned();
    if let Some(c) = st.clips.lock().unwrap().get_mut(&clip.path.to_lowercase()) {
        c.meta = Some(meta.clone());
        c.thumb = Some(thumb.clone());
    }
    let _ = app.emit("clip:update", json!({ "path": clip.path, "meta": meta, "thumb": thumb }));
    Ok(())
}

fn watch(st: &State, sources: &[detect::Source]) {
    let mut guard = st.watcher.lock().unwrap();
    let Some((watcher, watched)) = guard.as_mut() else { return };
    for old in watched.drain(..) {
        let _ = watcher.unwatch(&old);
    }
    for source in sources.iter().filter(|s| s.exists) {
        let p = PathBuf::from(&source.path);
        // A folder that can't be watched still works with manual rescan.
        if watcher.watch(&p, RecursiveMode::Recursive).is_ok() {
            watched.push(p);
        }
    }
}

fn clip_for(st: &State, file: &str) -> Result<(Clip, Meta), String> {
    let clip = st
        .clips
        .lock()
        .unwrap()
        .get(&file.to_lowercase())
        .cloned()
        .ok_or("That clip is no longer in the library. Rescan and try again.")?;
    let meta = clip.meta.clone().ok_or("Still reading this clip. Try again in a moment.")?;
    Ok((clip, meta))
}

/* ---------- folders, settings, small actions ---------- */

#[tauri::command]
async fn add_folder(app: AppHandle) -> Result<bool, String> {
    let st = state(&app);
    let dialog = app.dialog().clone();
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.file().set_title("Add a clips folder").blocking_pick_folder())
        .await
        .map_err(err)?;
    let Some(folder) = picked.and_then(|p| p.into_path().ok()) else { return Ok(false) };
    let folder = folder.to_string_lossy().into_owned();
    let mut folders: Vec<String> = st.config.get_as("folders");
    if !folders.iter().any(|f| f.eq_ignore_ascii_case(&folder)) {
        folders.push(folder);
        st.config.set("folders", json!(folders));
    }
    Ok(true)
}

#[tauri::command]
fn remove_folder(app: AppHandle, folder: String) -> bool {
    let st = state(&app);
    let norm = |s: &str| s.trim_end_matches(['\\', '/']).to_lowercase();
    let folders: Vec<String> = st.config.get_as("folders");
    let kept: Vec<String> = folders.into_iter().filter(|f| norm(f) != norm(&folder)).collect();
    st.config.set("folders", json!(kept));
    true
}

#[tauri::command]
async fn pick_music(app: AppHandle) -> Result<Option<Value>, String> {
    let st = state(&app);
    let dialog = app.dialog().clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .set_title("Choose a music track")
            .add_filter("Audio", &["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"])
            .blocking_pick_file()
    })
    .await
    .map_err(err)?;
    let Some(file) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let path = file.to_string_lossy().into_owned();
    st.music.lock().unwrap().insert(path.clone());
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some(json!({ "path": path, "name": name })))
}

fn saved_password() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?.get_password().ok().filter(|p| !p.is_empty())
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Value {
    let st = state(&app);
    json!({
        "email": st.config.get("streamableEmail").as_str().unwrap_or(""),
        "hasPassword": saved_password().is_some(),
        "canSavePassword": true,
        "exportDir": st.exports.to_string_lossy(),
        "limitMB": streamable::LIMIT_MB,
        "limitSeconds": streamable::LIMIT_SECONDS,
        "reelSeconds": REEL_DEFAULT_SECONDS,
    })
}

#[tauri::command]
fn set_settings(app: AppHandle, email: String, password: String) -> Result<bool, String> {
    state(&app).config.set("streamableEmail", json!(email.trim()));
    if !password.is_empty() {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .and_then(|e| e.set_password(&password))
            .map_err(|e| format!("Windows could not save the password: {e}"))?;
    }
    Ok(true)
}

#[tauri::command]
fn forget_login(app: AppHandle) -> bool {
    state(&app).config.set("streamableEmail", json!(""));
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.delete_credential();
    }
    true
}

#[derive(Deserialize)]
struct EditInput {
    file: String,
    trim: Option<[f64; 2]>,
    moment: Option<f64>,
}

/// Remembers each clip's trim and slow-mo moment between sessions.
#[tauri::command]
fn save_edit(app: AppHandle, edit: EditInput) -> bool {
    state(&app).config.update_map("edits", |edits| {
        let id = edit.file.to_lowercase();
        if edit.trim.is_some() || edit.moment.is_some() {
            edits.insert(id, json!({ "trim": edit.trim, "moment": edit.moment }));
        } else {
            edits.remove(&id);
        }
    });
    true
}

/// Puts the file itself on the clipboard so it can be pasted into Discord,
/// a browser upload dialog, Explorer, etc.
async fn copy_file_to_clipboard(file: String) -> Result<(), String> {
    let ok = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -LiteralPath $env:REPLAYSTRIKE_FILE"])
            .env("REPLAYSTRIKE_FILE", file)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
    .await
    .map_err(err)?;
    if ok { Ok(()) } else { Err("Could not copy the file to the clipboard.".into()) }
}

#[tauri::command]
fn reveal(app: AppHandle, file: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(file).map_err(err)
}

#[tauri::command]
async fn copy_file(app: AppHandle, file: String) -> Result<(), String> {
    let (clip, _) = clip_for(&state(&app), &file)?;
    copy_file_to_clipboard(clip.path).await
}

#[tauri::command]
async fn trash_clip(app: AppHandle, file: String) -> Result<bool, String> {
    let (clip, _) = clip_for(&state(&app), &file)?;
    tauri::async_runtime::spawn_blocking(move || trash::delete(&clip.path)).await.map_err(err)?.map_err(err)?;
    Ok(true)
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(err)
}

#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<bool, String> {
    let allowed = ["https://streamable.com/", "https://www.youtube.com/", "https://youtu.be/"];
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Ok(false);
    }
    app.opener().open_url(url, None::<&str>).map_err(err)?;
    Ok(true)
}

#[tauri::command]
async fn confirm(app: AppHandle, message: String, action: String) -> Result<bool, String> {
    let dialog = app.dialog().clone();
    tauri::async_runtime::spawn_blocking(move || {
        dialog
            .message(message)
            .title("ReplayStrike")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(action, "Cancel".into()))
            .blocking_show()
    })
    .await
    .map_err(err)
}

#[tauri::command]
fn win_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_maximize(window: tauri::WebviewWindow) {
    let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
}

#[tauri::command]
fn win_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

/* ---------- rendering and sharing ---------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipJob {
    job_id: String,
    file: String,
    start: f64,
    end: f64,
    #[serde(default, rename = "targetMB")]
    target_mb: f64,
    #[serde(default)]
    fx: Option<Fx>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReelJob {
    job_id: String,
    files: Vec<String>,
    #[serde(default)]
    fx: Option<Fx>,
}

/// Effects arrive from the webview; music must be a file the user picked.
fn clean_fx(st: &State, fx: Option<Fx>) -> Fx {
    let mut fx = fx.unwrap_or_default();
    fx.uniform = false;
    let picked = st.music.lock().unwrap();
    fx.music = fx.music.filter(|m| picked.contains(m));
    fx
}

fn progress(app: &AppHandle, job_id: &str, stage: &str) -> impl Fn(f64) + Send + Sync + 'static {
    let (app, job_id, stage) = (app.clone(), job_id.to_string(), stage.to_string());
    move |pct| {
        let _ = app.emit("job:progress", json!({ "jobId": job_id, "stage": stage, "pct": pct }));
    }
}

fn is_whole(meta: &Meta, start: f64, end: f64) -> bool {
    start < 0.05 && end > meta.duration - 0.05
}

/// Remembers how an exported file was made so My edits can label it.
fn record_export(st: &State, file: &str, kind: &str, from: Option<&str>) {
    let at = chrono::Local::now().timestamp_millis();
    st.config.update_map("exports", |m| {
        m.insert(file.to_lowercase(), json!({ "kind": kind, "from": from, "at": at }));
    });
}

/// Renders the selection (trim + effects, optionally to a size limit) into
/// the exports folder and copies the file to the clipboard ready to paste.
#[tauri::command]
async fn export_run(app: AppHandle, job: ClipJob) -> Result<ExportOut, String> {
    let st = state(&app);
    let (clip, meta) = clip_for(&st, &job.file)?;
    let fx = clean_fx(&st, job.fx);
    let sized = job.target_mb > 0.0;
    let stage = if sized || fx.active() { "Rendering" } else { "Trimming" };
    let label = if sized { format!("{}MB", job.target_mb) } else { "edit".to_string() };
    let on = progress(&app, &job.job_id, stage);
    let out = ffmpeg::export_clip(
        ExportJob { src: Path::new(&clip.path), start: job.start, end: job.end, target_mb: job.target_mb, out_dir: &st.exports, label: &label, meta: &meta, src_size: clip.size, fx: &fx, out_name: None },
        &on,
    )
    .await?;
    let kind = if sized { format!("Discord {} MB", job.target_mb) } else { "Edit".to_string() };
    record_export(&st, &out.path, &kind, Some(&clip.path));
    let _ = copy_file_to_clipboard(out.path.clone()).await;
    Ok(out)
}

#[tauri::command]
async fn upload_streamable(app: AppHandle, job: ClipJob) -> Result<Value, String> {
    let st = state(&app);
    let (clip, meta) = clip_for(&st, &job.file)?;
    let fx = clean_fx(&st, job.fx);
    let email = st.config.get("streamableEmail").as_str().unwrap_or("").to_string();
    let Some(password) = saved_password().filter(|_| !email.is_empty()) else {
        return Err("NEEDS_LOGIN".into());
    };
    if job.end - job.start > streamable::LIMIT_SECONDS {
        return Err(format!("Streamable's free plan allows {} minutes per video. Trim the clip first.", streamable::LIMIT_SECONDS / 60.0));
    }

    let fits_as_is = is_whole(&meta, job.start, job.end)
        && !fx.active()
        && clip.size as f64 <= streamable::LIMIT_MB * 1_048_576.0
        && meta.audio_tracks <= 1
        && clip.path.to_lowercase().ends_with(".mp4");
    let mut upload_file = PathBuf::from(&clip.path);
    let mut temp = None;
    if !fits_as_is {
        let on = progress(&app, &job.job_id, "Rendering");
        let out = ffmpeg::export_clip(
            ExportJob { src: Path::new(&clip.path), start: job.start, end: job.end, target_mb: streamable::LIMIT_MB, out_dir: &st.temp, label: "upload", meta: &meta, src_size: clip.size, fx: &fx, out_name: None },
            &on,
        )
        .await?;
        upload_file = PathBuf::from(&out.path);
        temp = Some(upload_file.clone());
    }
    let on = Arc::new(progress(&app, &job.job_id, "Uploading"));
    let result = streamable::upload(&upload_file, &email, &password, &clip.name, on).await;
    if let Some(t) = temp {
        let _ = std::fs::remove_file(t);
    }
    let url = result?;
    let upload = json!({ "url": url, "at": chrono::Local::now().timestamp_millis() });
    st.config.update_map("uploads", |m| {
        m.insert(clip.path.to_lowercase(), upload.clone());
    });
    let _ = copy_text(url);
    Ok(upload)
}

/// YouTube forces API uploads from unaudited apps to private, so we hand
/// off instead: prepare the file, put it on the clipboard, open the uploader.
#[tauri::command]
async fn upload_youtube(app: AppHandle, job: ClipJob) -> Result<Value, String> {
    let st = state(&app);
    let (clip, meta) = clip_for(&st, &job.file)?;
    let fx = clean_fx(&st, job.fx);
    let mut target = clip.path.clone();
    if !is_whole(&meta, job.start, job.end) || fx.active() || meta.audio_tracks > 1 {
        let on = progress(&app, &job.job_id, "Rendering");
        let out = ffmpeg::export_clip(
            ExportJob { src: Path::new(&clip.path), start: job.start, end: job.end, target_mb: 0.0, out_dir: &st.exports, label: "youtube", meta: &meta, src_size: clip.size, fx: &fx, out_name: None },
            &on,
        )
        .await?;
        record_export(&st, &out.path, "YouTube", Some(&clip.path));
        target = out.path;
    }
    let _ = copy_file_to_clipboard(target.clone()).await;
    let _ = app.opener().reveal_item_in_dir(&target);
    app.opener().open_url("https://www.youtube.com/upload", None::<&str>).map_err(err)?;
    Ok(json!({ "path": target }))
}

/// Joins several clips into one highlight reel. Each clip contributes its
/// saved trim, or its last few seconds if it has never been trimmed.
#[tauri::command]
async fn reel_run(app: AppHandle, job: ReelJob) -> Result<ExportOut, String> {
    let st = state(&app);
    if job.files.len() < 2 {
        return Err("Pick at least two clips for a reel.".into());
    }
    let edits = st.config.get("edits");
    let mut segments = Vec::new();
    for file in &job.files {
        let (clip, meta) = clip_for(&st, file)?;
        let edit = edits.get(clip.path.to_lowercase());
        let trim = edit.and_then(|e| serde_json::from_value::<[f64; 2]>(e["trim"].clone()).ok());
        let [start, end] = trim.unwrap_or([(meta.duration - REEL_DEFAULT_SECONDS).max(0.0), meta.duration]);
        let moment = edit.and_then(|e| e["moment"].as_f64());
        segments.push(Segment { src: PathBuf::from(&clip.path), start, end, meta, src_size: clip.size, moment });
    }
    let fx = clean_fx(&st, job.fx);
    let tmp = st.temp.join(format!("reel-{}", chrono::Local::now().timestamp_millis()));
    let on = progress(&app, &job.job_id, "Building reel");
    let out = ffmpeg::make_reel(&segments, &fx, "Highlight Reel", &st.exports, &tmp, &on).await?;
    record_export(&st, &out.path, "Reel", None);
    Ok(out)
}

/* ---------- hype moments ---------- */

/// Seconds kept before and after a hype moment when cutting it out.
const MOMENT_BEFORE: f64 = 6.0;
const MOMENT_AFTER: f64 = 3.0;

fn analysis_path(st: &State, key: &str) -> PathBuf {
    st.data.join("analysis").join(format!("{key}.json"))
}

fn load_analysis(st: &State, key: &str) -> Option<analyze::Analysis> {
    serde_json::from_str(&std::fs::read_to_string(analysis_path(st, key)).ok()?).ok()
}

fn model_path(st: &State) -> PathBuf {
    st.data.join("models").join(analyze::MODEL_FILE)
}

#[tauri::command]
fn hype_status(app: AppHandle) -> Value {
    let st = state(&app);
    json!({ "engine": analyze::whisper_bin().is_some(), "model": model_path(&st).exists(), "modelMB": analyze::MODEL_MB })
}

#[tauri::command]
fn get_analysis(app: AppHandle, file: String) -> Option<analyze::Analysis> {
    let st = state(&app);
    let key = st.clips.lock().unwrap().get(&file.to_lowercase())?.key.clone();
    load_analysis(&st, &key)
}

/// Returns the clip's cached analysis, or transcribes it now. The speech
/// model is downloaded the first time it is needed.
async fn ensure_analysis(app: &AppHandle, st: &State, clip: &Clip, meta: &Meta, job_id: &str, label: &str) -> Result<analyze::Analysis, String> {
    if let Some(found) = load_analysis(st, &clip.key) {
        return Ok(found);
    }
    let bin = analyze::whisper_bin().ok_or("This build does not include the speech engine.")?;
    let _turn = st.analysis_lock.lock().await;
    let model = model_path(st);
    if !model.exists() {
        analyze::download_model(&model, &progress(app, job_id, "Downloading speech model")).await?;
    }
    let found = analyze::analyze(Path::new(&clip.path), meta, &bin, &model, &st.temp, &progress(app, job_id, label)).await?;
    let path = analysis_path(st, &clip.key);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, serde_json::to_string(&found).map_err(err)?);
    if let Some(c) = st.clips.lock().unwrap().get_mut(&clip.path.to_lowercase()) {
        c.hype = Some(found.moments.len());
    }
    Ok(found)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeJob {
    job_id: String,
    file: String,
}

#[tauri::command]
async fn analyze_run(app: AppHandle, job: AnalyzeJob) -> Result<analyze::Analysis, String> {
    let st = state(&app);
    let (clip, meta) = clip_for(&st, &job.file)?;
    ensure_analysis(&app, &st, &clip, &meta, &job.job_id, "Listening for hype moments").await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MontageJob {
    job_id: String,
    files: Vec<String>,
    count: usize,
    #[serde(default)]
    fx: Option<Fx>,
}

/// Analyses the chosen clips, keeps the strongest moments across all of
/// them and joins those into one montage, in the order they happened.
#[tauri::command]
async fn montage_run(app: AppHandle, job: MontageJob) -> Result<ExportOut, String> {
    let st = state(&app);
    if job.files.is_empty() {
        return Err("Pick at least one clip.".into());
    }
    let total = job.files.len();
    let mut found: Vec<(Clip, Meta, analyze::Moment)> = Vec::new();
    for (i, file) in job.files.iter().enumerate() {
        let (clip, meta) = clip_for(&st, file)?;
        let label = format!("Listening to clip {} of {total}", i + 1);
        let analysis = ensure_analysis(&app, &st, &clip, &meta, &job.job_id, &label).await?;
        found.extend(analysis.moments.into_iter().map(|m| (clip.clone(), meta.clone(), m)));
    }
    if found.is_empty() {
        return Err("No hype moments were found in those clips.".into());
    }
    found.sort_by(|a, b| b.2.score.total_cmp(&a.2.score));
    found.truncate(job.count.clamp(1, 20));
    let best = found[0].2.score;
    found.sort_by(|a, b| a.0.mtime.total_cmp(&b.0.mtime).then(a.2.t.total_cmp(&b.2.t)));

    let segments: Vec<Segment> = found
        .iter()
        .map(|(clip, meta, m)| Segment {
            src: PathBuf::from(&clip.path),
            start: (m.t - MOMENT_BEFORE).max(0.0),
            end: (m.t + MOMENT_AFTER).min(meta.duration),
            meta: meta.clone(),
            src_size: clip.size,
            // Slow-mo is saved for the single biggest moment.
            moment: (m.score >= best).then_some(m.t),
        })
        .collect();
    let fx = clean_fx(&st, job.fx);
    let tmp = st.temp.join(format!("montage-{}", chrono::Local::now().timestamp_millis()));
    let on = progress(&app, &job.job_id, "Building montage");
    let out = ffmpeg::make_reel(&segments, &fx, "Montage", &st.exports, &tmp, &on).await?;
    record_export(&st, &out.path, "Montage", None);
    Ok(out)
}

/* ---------- startup ---------- */

/// `--selftest <clips dir> <out dir>` renders a set of effect combinations
/// with the real engine and writes the results to <out dir>\selftest.txt.
async fn selftest(clips_dir: PathBuf, out_dir: PathBuf) -> Result<String, String> {
    let mut sources = vec![detect::Source { label: "test".into(), path: clips_dir.to_string_lossy().into_owned(), kind: "user", exists: true, count: 0 }];
    let mut clips = library::scan_files(&mut sources);
    clips.retain(|c| c.size > 50_000_000);
    let mut log = format!("ffmpeg: {}\nclips: {}\n", ffmpeg::bin("ffmpeg").display(), clips.len());
    let first = clips.first().ok_or("no clips to test with")?;
    let src = Path::new(&first.path);
    let meta = ffmpeg::probe(src).await?;
    log += &format!("src: {} {:?}\n", first.name, meta);
    ffmpeg::thumbnail(src, meta.duration, &out_dir.join("thumb.jpg")).await?;

    let cases: Vec<(&str, f64, Fx)> = vec![
        ("trim", 0.0, Fx::default()),
        ("10MB", 10.0, Fx::default()),
        ("cine", 0.0, Fx { style: "cinematic".into(), title: "Ace! #1 it's 100% <b>".into(), fades: true, moment: Some(25.0), ..Fx::default() }),
        ("vert", 10.0, Fx { style: "vibrant".into(), format: "vertical".into(), moment: Some(20.2), ..Fx::default() }),
        ("fit", 0.0, Fx { format: "vertical-fit".into(), game_vol: Some(0.4), ..Fx::default() }),
        ("square", 10.0, Fx { style: "noir".into(), format: "square".into(), fades: true, ..Fx::default() }),
    ];
    for (label, target_mb, fx) in cases {
        let out = ffmpeg::export_clip(
            ExportJob { src, start: 20.0, end: 30.0, target_mb, out_dir: &out_dir, label, meta: &meta, src_size: first.size, fx: &fx, out_name: None },
            &|_| {},
        )
        .await?;
        let m = ffmpeg::probe(Path::new(&out.path)).await?;
        log += &format!(
            "{label:<7} {:>7.2}MB {}x{}@{} {:.2}s expected {:.2}s audio={} reencoded={}\n",
            out.size as f64 / 1_048_576.0, m.width, m.height, m.fps, m.duration, out.duration, m.audio_tracks, out.reencoded
        );
    }

    let mut segments = Vec::new();
    for c in clips.iter().take(3) {
        let m = ffmpeg::probe(Path::new(&c.path)).await?;
        segments.push(Segment { src: PathBuf::from(&c.path), start: (m.duration - 6.0).max(0.0), end: m.duration, meta: m, src_size: c.size, moment: None });
    }
    let fx = Fx { style: "cinematic".into(), title: "Reel test".into(), ..Fx::default() };
    let reel = ffmpeg::make_reel(&segments, &fx, "Highlight Reel", &out_dir, &out_dir.join("tmp"), &|_| {}).await?;
    let m = ffmpeg::probe(Path::new(&reel.path)).await?;
    log += &format!("reel    {:>7.2}MB {}x{}@{} {:.2}s expected {:.2}s\n", reel.size as f64 / 1_048_576.0, m.width, m.height, m.fps, m.duration, reel.duration);

    let model = PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("ReplayStrike").join("models").join(analyze::MODEL_FILE);
    match analyze::whisper_bin().filter(|_| model.exists()) {
        None => log += "hype    skipped (speech engine or model missing)\n",
        Some(bin) => {
            for c in clips.iter().take(2) {
                let m = ffmpeg::probe(Path::new(&c.path)).await?;
                let started = std::time::Instant::now();
                let a = analyze::analyze(Path::new(&c.path), &m, &bin, &model, &out_dir, &|_| {}).await?;
                log += &format!("hype    {} ({:.0}s clip, {:.1}s to analyse): {} lines, {} moments\n", c.name, m.duration, started.elapsed().as_secs_f64(), a.lines.len(), a.moments.len());
                for mo in &a.moments {
                    log += &format!("          {:>6.1}s score {:>4.1} {} {}\n", mo.t, mo.score, if mo.spoken { "said:" } else { "" }, mo.reason);
                }
            }
        }
    }
    Ok(log)
}

/// CI-only capture of the actual WebView2 compositor, independent of the runner desktop.
fn request_native_webview_capture(app: AppHandle, output: PathBuf) {
    use base64::Engine as _;

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        let Some(window) = app.get_webview_window("main") else {
            eprintln!("native capture: main webview unavailable");
            app.exit(1);
            return;
        };
        let callback_app = app.clone();
        let invocation_app = app.clone();
        let scheduled = window.with_webview(move |platform| {
            let callback = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(
                Box::new(move |status, response| {
                    let saved = (|| -> Result<(), String> {
                        status.map_err(|error| format!("WebView2 capture failed: {error}"))?;
                        let response: Value = serde_json::from_str(&response).map_err(err)?;
                        let encoded = response.get("data").and_then(Value::as_str)
                            .ok_or("WebView2 returned no screenshot data")?;
                        let png = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(err)?;
                        if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
                            return Err("WebView2 returned a non-PNG screenshot".into());
                        }
                        std::fs::write(&output, png).map_err(err)?;
                        eprintln!("native WebView2 screenshot saved to {}", output.display());
                        Ok(())
                    })();
                    if let Err(error) = saved {
                        eprintln!("native capture: {error}");
                        callback_app.exit(1);
                    } else {
                        callback_app.exit(0);
                    }
                    Ok(())
                }),
            );
            let started = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }.map_err(err)?;
                let method = webview2_com::CoTaskMemPWSTR::from("Page.captureScreenshot");
                let args = webview2_com::CoTaskMemPWSTR::from(
                    r#"{"format":"png","fromSurface":true,"captureBeyondViewport":false}"#,
                );
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *args.as_ref().as_pcwstr(),
                        &callback,
                    )
                }.map_err(err)?;
                Ok(())
            })();
            if let Err(error) = started {
                eprintln!("native capture: {error}");
                invocation_app.exit(1);
            }
        });
        if let Err(error) = scheduled {
            eprintln!("native capture could not access WebView2: {error}");
            app.exit(1);
        }
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--selftest") {
        let (clips, out) = (PathBuf::from(&args[i + 1]), PathBuf::from(&args[i + 2]));
        let _ = std::fs::create_dir_all(&out);
        let log = match tauri::async_runtime::block_on(selftest(clips, out.clone())) {
            Ok(log) => format!("{log}PASS\n"),
            Err(e) => format!("FAIL {e}\n"),
        };
        let _ = std::fs::write(out.join("selftest.txt"), &log);
        print!("{log}");
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let capture_root = std::env::var_os("REPLAYSTRIKE_CAPTURE_ROOT").map(PathBuf::from);
            if capture_root.as_ref().is_some_and(|root| !root.is_absolute()) {
                return Err(std::io::Error::other("REPLAYSTRIKE_CAPTURE_ROOT must be absolute").into());
            }
            if let Some(root) = &capture_root {
                std::fs::create_dir_all(root.join("clips"))?;
            }
            let data = match &capture_root {
                Some(root) => root.join("data"),
                None => app.path().data_dir()?.join("ReplayStrike"),
            };
            let thumbs = data.join("thumbs-v2");
            let exports = match &capture_root {
                Some(root) => root.join("exports"),
                None => app.path().video_dir()?.join("ReplayStrike"),
            };
            std::fs::create_dir_all(&thumbs)?;
            let scope = app.asset_protocol_scope();
            let _ = scope.allow_directory(&thumbs, false);
            let _ = scope.allow_directory(&exports, true);

            // New clips: wait for the recorder to go quiet, then tell the UI to rescan.
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
            let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if matches!(res, Ok(ref e) if e.kind.is_create() || e.kind.is_modify() || e.kind.is_remove()) {
                    let _ = tx.send(());
                }
            })
            .ok();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while rx.recv().await.is_some() {
                    while let Ok(Some(())) = tokio::time::timeout(Duration::from_millis(2500), rx.recv()).await {}
                    let _ = handle.emit("library:changed", ());
                }
            });

            app.manage(Arc::new(AppState {
                config: Store::open(data.join("config.json")),
                meta: Store::open(data.join("meta-v2.json")),
                data,
                analysis_lock: tokio::sync::Mutex::new(()),
                thumbs,
                exports,
                temp: capture_root.as_ref().map(|root| root.join("temp"))
                    .unwrap_or_else(|| std::env::temp_dir().join("ReplayStrike")),
                clips: Mutex::new(HashMap::new()),
                music: Mutex::new(HashSet::new()),
                watcher: Mutex::new(watcher.map(|w| (w, Vec::new()))),
                scan_gen: AtomicU64::new(0),
                capture_root,
            }));
            if let Some(path) = std::env::var_os("REPLAYSTRIKE_NATIVE_CAPTURE_PATH").map(PathBuf::from) {
                if !path.is_absolute() || capture_root.as_ref().is_none_or(|root| !path.starts_with(root)) {
                    return Err(std::io::Error::other(
                        "REPLAYSTRIKE_NATIVE_CAPTURE_PATH must be inside absolute REPLAYSTRIKE_CAPTURE_ROOT"
                    ).into());
                }
                request_native_webview_capture(app.handle().clone(), path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan,
            add_folder,
            remove_folder,
            pick_music,
            get_settings,
            set_settings,
            forget_login,
            save_edit,
            reveal,
            copy_file,
            trash_clip,
            copy_text,
            open_link,
            confirm,
            win_minimize,
            win_toggle_maximize,
            win_close,
            export_run,
            upload_streamable,
            upload_youtube,
            reel_run,
            hype_status,
            get_analysis,
            analyze_run,
            montage_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running ReplayStrike");
}

#[cfg(test)]
mod capture_tests {
    use super::capture_sources;

    #[test]
    fn preview_scans_only_its_synthetic_clips_folder() {
        let root = std::env::temp_dir().join("replaystrike-preview-test");
        let sources = capture_sources(&root);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].label, "Synthetic clips");
        assert_eq!(std::path::PathBuf::from(&sources[0].path), root.join("clips"));
    }
}
