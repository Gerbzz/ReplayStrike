//! Finds the hype moments in a clip from what is said and how loud it gets.

use crate::ffmpeg::{self, Meta, Progress};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const MODEL_FILE: &str = "ggml-base.en.bin";
pub const MODEL_MB: u32 = 141;
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Loudness is measured in windows this long (seconds).
const WINDOW: f64 = 0.5;
/// Two moments are never closer together than this (seconds).
const MIN_GAP: f64 = 12.0;
const MAX_MOMENTS: usize = 8;
/// Below this score a peak only counts if nothing better was found.
const MIN_SCORE: f64 = 1.5;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Line {
    pub from: f64,
    pub to: f64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Moment {
    pub t: f64,
    pub score: f64,
    /// What was said around the moment, or a plain description.
    pub reason: String,
    pub spoken: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Analysis {
    pub lines: Vec<Line>,
    pub moments: Vec<Moment>,
}

/// The bundled speech-to-text program, if this build includes it.
pub fn whisper_bin() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let mut candidates = vec![exe_dir.join("whisper").join("whisper-cli.exe")];
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("whisper").join("whisper-cli.exe"));
    }
    candidates.into_iter().find(|p| p.exists())
}

pub async fn download_model(dest: &Path, on: Progress<'_>) -> Result<(), String> {
    let e = |x: &dyn std::fmt::Display| format!("Could not download the speech model: {x}");
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|x| e(&x))?;
    }
    let part = dest.with_extension("part");
    let res = reqwest::get(MODEL_URL).await.and_then(|r| r.error_for_status()).map_err(|x| e(&x))?;
    let total = res.content_length().unwrap_or(MODEL_MB as u64 * 1_048_576).max(1);
    let mut file = tokio::fs::File::create(&part).await.map_err(|x| e(&x))?;
    let mut stream = res.bytes_stream();
    let mut got = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|x| e(&x))?;
        file.write_all(&chunk).await.map_err(|x| e(&x))?;
        got += chunk.len() as u64;
        on((got as f64 / total as f64).min(1.0));
    }
    file.flush().await.map_err(|x| e(&x))?;
    drop(file);
    if got < 50 * 1_048_576 {
        let _ = std::fs::remove_file(&part);
        return Err(e(&"the file arrived incomplete"));
    }
    std::fs::rename(&part, dest).map_err(|x| e(&x))
}

async fn transcribe(bin: &Path, model: &Path, wav: &Path, out_base: &Path, on: Progress<'_>) -> Result<Vec<Line>, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-m").arg(model).arg("-f").arg(wav).arg("-of").arg(out_base);
    cmd.args(["-oj", "-pp", "-sns", "-t", &threads.to_string()]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = bin.parent() {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the speech engine: {e}"))?;
    let mut lines = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
    let mut last = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(pct) = line.split("progress =").nth(1).and_then(|p| p.trim().trim_end_matches('%').trim().parse::<f64>().ok()) {
            on((pct / 100.0).clamp(0.0, 1.0));
        } else if !line.trim().is_empty() {
            last = line;
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Transcription failed: {last}"));
    }
    let json_path = PathBuf::from(format!("{}.json", out_base.to_string_lossy()));
    let bytes = std::fs::read(&json_path).map_err(|e| format!("Transcription produced no output: {e}"))?;
    let _ = std::fs::remove_file(&json_path);
    let v: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for seg in v["transcription"].as_array().into_iter().flatten() {
        let text = seg["text"].as_str().unwrap_or("").trim().to_string();
        let (from, to) = (seg["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0, seg["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0);
        if !is_noise(&text) && to > from {
            out.push(Line { from, to, text });
        }
    }
    Ok(out)
}

/// Whisper invents filler on silence and tags non-speech; neither is transcript.
fn is_noise(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    let t = t.trim_matches(|c: char| !c.is_alphanumeric());
    if t.is_empty() {
        return true;
    }
    const FILLER: [&str; 7] = ["you", "thank you", "thanks for watching", "bye", "blank_audio", "silence", "music"];
    FILLER.contains(&t) || t.contains("blank_audio") || t.contains("music playing")
}

/// RMS level in dB for each window of a 16-bit mono 16 kHz WAV.
fn loudness(wav: &Path) -> Vec<f64> {
    let Ok(bytes) = std::fs::read(wav) else { return Vec::new() };
    let start = bytes.windows(4).position(|w| w == b"data").map(|p| p + 8).unwrap_or(44).min(bytes.len());
    let per_window = (16000.0 * WINDOW) as usize * 2;
    bytes[start..]
        .chunks(per_window)
        .filter(|c| c.len() >= per_window / 2)
        .map(|chunk| {
            let (mut sum, mut n) = (0.0f64, 0u32);
            for s in chunk.chunks_exact(2) {
                let v = i16::from_le_bytes([s[0], s[1]]) as f64 / 32768.0;
                sum += v * v;
                n += 1;
            }
            10.0 * (sum / n.max(1) as f64).max(1e-10).log10()
        })
        .collect()
}

/// How excited a line of speech sounds, from 0 (nothing) up to 6.
fn text_score(text: &str) -> f64 {
    const PHRASES: [(&str, f64); 46] = [
        ("lets go", 3.0), ("let's go", 3.0), ("here we go", 2.0), ("no way", 3.0), ("oh my god", 3.0), ("oh my gosh", 3.0),
        ("holy", 3.0), ("what the", 2.0), ("wtf", 2.0), ("insane", 3.0), ("crazy", 2.0), ("clutch", 3.0), ("nice shot", 3.0),
        ("headshot", 3.0), ("got him", 2.0), ("got 'em", 2.0), ("got em", 2.0), ("killed", 1.5), ("kill", 1.0), ("kills", 1.0),
        ("dead", 1.0), ("one shot", 2.0), ("sniped", 2.0), ("boom", 2.0), ("yes", 1.0), ("wow", 2.0), ("whoa", 2.0), ("nice", 1.0),
        ("oh shit", 3.0), ("fuck", 1.5), ("fucking", 1.5), ("shit", 1.0), ("damn", 1.5), ("dude", 0.5), ("bro", 0.5),
        ("laughing", 2.0), ("laughs", 2.0), ("laughter", 2.0), ("haha", 2.0), ("screaming", 3.0), ("for real", 1.5),
        ("triple", 2.0), ("double", 1.5), ("ace", 3.0), ("perfect", 1.5), ("down", 0.5),
    ];
    let cleaned: String = text.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' }).collect();
    let padded = format!(" {} ", cleaned.split_whitespace().collect::<Vec<_>>().join(" "));
    let mut score: f64 = PHRASES.iter().filter(|(p, _)| padded.contains(&format!(" {p} "))).map(|(_, w)| w).sum();
    score += text.matches('!').count().min(2) as f64;
    score.min(6.0)
}

fn median(values: &[f64]) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    if v.is_empty() { 0.0 } else { v[v.len() / 2] }
}

/// Scores every window from loudness, sudden jumps in loudness and what is
/// being said, then keeps the strongest well-separated peaks.
pub fn find_moments(db: &[f64], lines: &[Line], duration: f64) -> Vec<Moment> {
    let n = db.len();
    if n < 4 {
        return Vec::new();
    }
    let audible: Vec<f64> = db.iter().copied().filter(|d| *d > -60.0).collect();
    let base = median(&audible);
    let spread = (audible.iter().map(|d| (d - base).powi(2)).sum::<f64>() / audible.len().max(1) as f64).sqrt().max(2.0);

    let mut raw = vec![0.0f64; n];
    for w in 0..n {
        if db[w] <= -60.0 {
            continue;
        }
        let loud = ((db[w] - base) / spread - 0.8).clamp(0.0, 3.0);
        let before = &db[w.saturating_sub(6)..w];
        let onset = if before.is_empty() { 0.0 } else { ((db[w] - before.iter().sum::<f64>() / before.len() as f64) / 5.0).clamp(0.0, 2.0) };
        raw[w] = 0.7 * loud + 0.7 * onset;
    }
    for line in lines {
        let score = text_score(&line.text);
        if score <= 0.0 {
            continue;
        }
        let (a, b) = ((line.from / WINDOW) as usize, ((line.to / WINDOW).ceil() as usize).min(n));
        let span = b.saturating_sub(a).max(1) as f64;
        for slot in raw.iter_mut().take(b).skip(a) {
            *slot += score / span.sqrt();
        }
    }
    let mut smooth: Vec<f64> = (0..n).map(|w| raw[w.saturating_sub(1)..(w + 2).min(n)].iter().sum()).collect();

    let gap = (MIN_GAP / WINDOW) as usize;
    let mut moments = Vec::new();
    while moments.len() < MAX_MOMENTS {
        let Some((w, &score)) = smooth.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)) else { break };
        if score <= 0.0 || (score < MIN_SCORE && !moments.is_empty()) {
            break;
        }
        let t = (w as f64 * WINDOW).clamp(0.0, (duration - 0.5).max(0.0));
        let near = |pad: f64| lines.iter().filter(move |l| l.to >= t - pad && l.from <= t + pad);
        let quote = near(3.0)
            .filter(|l| text_score(&l.text) > 0.0)
            .max_by(|a, b| text_score(&a.text).total_cmp(&text_score(&b.text)))
            .or_else(|| near(1.5).next());
        let (reason, spoken) = match quote {
            Some(l) => (l.text.chars().take(70).collect(), true),
            None => ("Loud moment".to_string(), false),
        };
        moments.push(Moment { t, score: (score * 10.0).round() / 10.0, reason, spoken });
        for slot in smooth.iter_mut().take((w + gap).min(n)).skip(w.saturating_sub(gap)) {
            *slot = 0.0;
        }
    }
    moments
}

/// Transcribes a clip and finds its hype moments. `tmp` is a scratch folder.
pub async fn analyze(clip: &Path, meta: &Meta, bin: &Path, model: &Path, tmp: &Path, on: Progress<'_>) -> Result<Analysis, String> {
    if meta.audio_tracks == 0 {
        return Err("This clip has no audio to analyse.".into());
    }
    std::fs::create_dir_all(tmp).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let wav = tmp.join(format!("a{stamp}.wav"));
    let result = async {
        ffmpeg::extract_wav(clip, meta.audio_tracks, &wav).await?;
        on(0.08);
        let db = loudness(&wav);
        let step = |p: f64| on(0.08 + p * 0.92);
        let lines = transcribe(bin, model, &wav, &wav.with_extension(""), &step).await?;
        let moments = find_moments(&db, &lines, meta.duration);
        Ok(Analysis { lines, moments })
    }
    .await;
    let _ = std::fs::remove_file(&wav);
    result
}
