use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SLOW_BEFORE: f64 = 0.6;
const SLOW_AFTER: f64 = 0.9;

pub type Progress<'a> = &'a (dyn Fn(f64) + Send + Sync);

/// The bundled binary next to the app, or whatever is on PATH.
pub fn bin(name: &str) -> PathBuf {
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let p = dir.join(format!("{name}.exe"));
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(name)
}

struct Args(Vec<OsString>);

impl Args {
    fn new() -> Self {
        Args(Vec::new())
    }
    fn add(&mut self, items: &[&str]) -> &mut Self {
        self.0.extend(items.iter().map(OsString::from));
        self
    }
    fn arg(&mut self, item: impl Into<OsString>) -> &mut Self {
        self.0.push(item.into());
        self
    }
}

async fn run(name: &str, args: Vec<OsString>, cwd: Option<&Path>, mut on_line: impl FnMut(&str) + Send) -> Result<String, String> {
    let mut cmd = Command::new(bin(name));
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {name}: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let errors = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    let mut out = String::new();
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        on_line(&line);
        out.push_str(&line);
        out.push('\n');
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let err = errors.await.unwrap_or_default();
    if status.success() {
        return Ok(out);
    }
    let lines: Vec<&str> = err.trim().lines().collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" | ");
    Err(if tail.is_empty() { format!("{name} failed ({status})") } else { tail })
}

/// Runs ffmpeg, turning its `-progress` output into 0..1 of `total` seconds.
async fn run_ffmpeg(mut args: Vec<OsString>, cwd: Option<&Path>, total: f64, on: Progress<'_>) -> Result<(), String> {
    let mut full: Vec<OsString> = ["-v", "error", "-nostats", "-progress", "pipe:1"].iter().map(OsString::from).collect();
    full.append(&mut args);
    run("ffmpeg", full, cwd, |line| {
        let value = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms="));
        if let Some(us) = value.and_then(|v| v.trim().parse::<f64>().ok()) {
            on((us / 1e6 / total).clamp(0.0, 1.0));
        }
    })
    .await
    .map(|_| ())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: String,
    pub audio_tracks: u32,
}

pub async fn probe(file: &Path) -> Result<Meta, String> {
    let mut args = Args::new();
    args.add(&["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]).arg(file);
    let out = run("ffprobe", args.0, None, |_| {}).await?;
    let info: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let streams = info["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video");
    let audio_tracks = streams.iter().filter(|s| s["codec_type"] == "audio").count() as u32;
    let duration = info["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
    let Some(v) = video.filter(|_| duration > 0.0) else {
        return Err("not a playable video".into());
    };
    let rate = v["avg_frame_rate"].as_str().unwrap_or("0/1");
    let (n, d) = rate.split_once('/').unwrap_or((rate, "1"));
    let (n, d) = (n.parse::<f64>().unwrap_or(0.0), d.parse::<f64>().unwrap_or(1.0));
    Ok(Meta {
        duration,
        width: v["width"].as_u64().unwrap_or(0) as u32,
        height: v["height"].as_u64().unwrap_or(0) as u32,
        fps: if d > 0.0 { (n / d).round() as u32 } else { 0 },
        codec: v["codec_name"].as_str().unwrap_or("").to_string(),
        audio_tracks,
    })
}

pub async fn thumbnail(file: &Path, duration: f64, out: &Path) -> Result<(), String> {
    let at = (duration * 0.3).min((duration - 0.5).max(0.0));
    let mut args = Args::new();
    args.add(&["-v", "error", "-ss", &format!("{at:.2}"), "-i"])
        .arg(file)
        .add(&["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", "-y"])
        .arg(out);
    run("ffmpeg", args.0, None, |_| {}).await.map(|_| ())
}

fn unique_path(dir: &Path, base: &str, label: &str) -> PathBuf {
    let mut n = 0;
    loop {
        let suffix = if n == 0 { String::new() } else { format!(" {n}") };
        let p = dir.join(format!("{base} ({label}{suffix}).mp4"));
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

struct Encode {
    audio_k: u32,
    video_k: u32,
    height: u32,
    fps30: bool,
}

fn encode_settings(target_mb: f64, dur: f64, src_height: u32) -> Encode {
    let total_k = target_mb * 8192.0 * 0.94 / dur;
    let audio_k = if total_k < 600.0 { 64 } else if total_k < 1500.0 { 96 } else { 128 };
    let video_k = ((total_k - audio_k as f64).floor() as i64).max(80) as u32;
    let height = match video_k {
        k if k >= 8000 => src_height,
        k if k >= 3500 => 1080,
        k if k >= 1400 => 720,
        k if k >= 600 => 480,
        _ => 360,
    };
    Encode { audio_k, video_k, height: height.min(src_height.max(2)), fps30: video_k < 1400 }
}

/* ---------- effects ---------- */

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Fx {
    pub style: String,
    pub format: String,
    pub moment: Option<f64>,
    pub title: String,
    pub fades: bool,
    pub music: Option<String>,
    pub game_vol: Option<f64>,
    /// Fixed size and frame rate so reel segments can be joined.
    #[serde(skip)]
    pub uniform: bool,
}

fn style_filters(style: &str) -> &'static [&'static str] {
    match style {
        "cinematic" => &["eq=contrast=1.08:saturation=1.12:gamma=0.96", "colorbalance=rs=0.05:bs=-0.05:rh=0.03:bh=-0.04", "vignette=angle=PI/5"],
        "vibrant" => &["eq=contrast=1.1:saturation=1.38", "unsharp=5:5:0.7:5:5:0"],
        "noir" => &["hue=s=0", "eq=contrast=1.22:brightness=-0.02", "vignette=angle=PI/4.5"],
        _ => &[],
    }
}

/// drawtext text is embedded in the filter graph, so only keep characters
/// that need no escaping there.
fn clean_title(title: &str) -> String {
    let kept: String = title.chars().filter(|c| c.is_alphanumeric() || " -_.!?#@&+".contains(*c)).collect();
    kept.trim().chars().take(60).collect()
}

impl Fx {
    pub fn normalized(&self) -> Fx {
        Fx {
            style: if ["cinematic", "vibrant", "noir"].contains(&self.style.as_str()) { self.style.clone() } else { "none".into() },
            format: if ["vertical", "vertical-fit", "square"].contains(&self.format.as_str()) { self.format.clone() } else { "original".into() },
            moment: self.moment.filter(|m| m.is_finite()),
            title: clean_title(&self.title),
            fades: self.fades,
            music: self.music.clone().filter(|m| !m.is_empty()),
            game_vol: Some(self.vol()),
            uniform: self.uniform,
        }
    }

    fn vol(&self) -> f64 {
        self.game_vol.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0)).unwrap_or(1.0)
    }

    pub fn active(&self) -> bool {
        let f = self.normalized();
        f.style != "none" || f.format != "original" || f.moment.is_some() || !f.title.is_empty() || f.fades || f.music.is_some() || f.vol() != 1.0 || f.uniform
    }
}

fn font_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into())).join("Fonts")
}

fn font_file() -> Option<&'static str> {
    ["segoeuib.ttf", "arialbd.ttf", "arial.ttf"].into_iter().find(|f| font_dir().join(f).exists())
}

fn even(n: f64) -> u32 {
    (((n / 2.0).round() as i64) * 2).max(2) as u32
}

/// The half-speed window around the marked moment, relative to the selection.
fn slow_window(moment: Option<f64>, start: f64, dur: f64) -> Option<(f64, f64)> {
    let m = moment? - start;
    if m < 0.0 || m > dur {
        return None;
    }
    let (a, b) = ((m - SLOW_BEFORE).max(0.0), (m + SLOW_AFTER).min(dur));
    (b - a > 0.2).then_some((a, b))
}

#[allow(clippy::too_many_arguments)]
fn build_graph(meta: &Meta, dur: f64, out_dur: f64, slow: Option<(f64, f64)>, fx: &Fx, limit_h: u32, fps: u32, font: Option<&str>) -> String {
    let mut g: Vec<String> = Vec::new();
    let n = meta.audio_tracks;

    // Audio base: silence if the clip has none, otherwise every track mixed
    // (recorders often put the mic on its own track).
    if n == 0 {
        g.push(format!("anullsrc=r=48000:cl=stereo,atrim=end={dur:.3}[a0]"));
    } else {
        let ins: String = (0..n).map(|i| format!("[0:a:{i}]")).collect();
        let mix = if n > 1 { format!("amix=inputs={n}:normalize=0,") } else { String::new() };
        g.push(format!("{ins}{mix}aresample=48000,aformat=channel_layouts=stereo[a0]"));
    }
    let mut v = "[0:v:0]".to_string();
    let mut a = "[a0]".to_string();

    if let Some((s0, s1)) = slow {
        let mut segs: Vec<(f64, f64, f64)> = Vec::new();
        if s0 > 0.05 {
            segs.push((0.0, s0, 1.0));
        }
        segs.push((s0, s1, 0.5));
        if s1 < dur - 0.05 {
            segs.push((s1, dur, 1.0));
        }
        let k = segs.len();
        let labels = |p: &str| (0..k).map(|i| format!("[{p}{i}]")).collect::<String>();
        g.push(format!("{v}split={k}{}", labels("sv")));
        g.push(format!("{a}asplit={k}{}", labels("sa")));
        for (i, (s, e, speed)) in segs.iter().enumerate() {
            g.push(format!("[sv{i}]trim=start={s:.3}:end={e:.3},setpts={}*(PTS-STARTPTS)[tv{i}]", 1.0 / speed));
            let tempo = if *speed != 1.0 { format!(",atempo={speed}") } else { String::new() };
            g.push(format!("[sa{i}]atrim=start={s:.3}:end={e:.3},asetpts=PTS-STARTPTS{tempo}[ta{i}]"));
        }
        let pairs: String = (0..k).map(|i| format!("[tv{i}][ta{i}]")).collect();
        g.push(format!("{pairs}concat=n={k}:v=1:a=1[cv][ca]"));
        v = "[cv]".into();
        a = "[ca]".into();
    }

    // Geometry
    let short = if fx.uniform { 1080 } else { even(1080f64.min(limit_h as f64).min(meta.height as f64)) };
    let (out_w, out_h);
    match fx.format.as_str() {
        "vertical" => {
            out_w = short;
            out_h = even(short as f64 * 16.0 / 9.0);
            g.push(format!("{v}crop='min(iw,ih*9/16)':ih,scale={out_w}:{out_h}[geo]"));
        }
        "vertical-fit" => {
            out_w = short;
            out_h = even(short as f64 * 16.0 / 9.0);
            g.push(format!("{v}split=2[bg0][fg0]"));
            g.push(format!("[bg0]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},boxblur=20:4[bg1]"));
            g.push(format!("[fg0]scale={out_w}:-2[fg1]"));
            g.push("[bg1][fg1]overlay=(W-w)/2:(H-h)/2[geo]".into());
        }
        "square" => {
            out_w = short;
            out_h = short;
            g.push(format!("{v}crop='min(iw,ih)':'min(iw,ih)',scale={out_w}:{out_h}[geo]"));
        }
        _ if fx.uniform => {
            out_w = 1920;
            out_h = 1080;
            g.push(format!("{v}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[geo]"));
        }
        _ => {
            out_h = even(meta.height.min(limit_h) as f64);
            out_w = even(out_h as f64 * meta.width as f64 / meta.height.max(1) as f64);
            g.push(format!("{v}scale={out_w}:{out_h}[geo]"));
        }
    }

    let mut chain: Vec<String> = vec!["setsar=1".into(), format!("fps={fps}")];
    chain.extend(style_filters(&fx.style).iter().map(|s| s.to_string()));
    let letterbox = fx.style == "cinematic" && fx.format == "original";
    if letterbox {
        chain.push("drawbox=x=0:y=0:w=iw:h=ih*0.11:color=black:t=fill".into());
        chain.push("drawbox=x=0:y=ih*0.89:w=iw:h=ih*0.11:color=black:t=fill".into());
    }
    if let (false, Some(font)) = (fx.title.is_empty(), font) {
        let size = (out_w.min(out_h) as f64 / 12.0).round();
        let y = (out_h as f64 * if letterbox { 0.86 } else { 0.93 }).round();
        let x = (out_w as f64 * 0.05).round();
        chain.push(format!(
            "drawtext=fontfile={font}:text='{}':fontcolor=white:fontsize={size}:x={x}:y={y}-text_h:shadowcolor=black@0.65:shadowx=3:shadowy=3:alpha='if(lt(t,0.3),t/0.3,if(lt(t,2.6),1,if(lt(t,3.1),(3.1-t)/0.5,0)))'",
            fx.title
        ));
    }
    let fades = fx.fades && out_dur > 1.5;
    if fades {
        chain.push("fade=t=in:st=0:d=0.35".into());
        chain.push(format!("fade=t=out:st={:.3}:d=0.45", out_dur - 0.45));
    }
    chain.push("format=yuv420p".into());
    g.push(format!("[geo]{}[vout]", chain.join(",")));

    let vol = fx.vol();
    if vol != 1.0 {
        g.push(format!("{a}volume={vol}[ag]"));
        a = "[ag]".into();
    }
    if fx.music.is_some() {
        g.push("[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.8[mu]".into());
        g.push(format!("{a}[mu]amix=inputs=2:duration=first:normalize=0[am]"));
        a = "[am]".into();
    }
    let achain = if fades { format!("afade=t=in:st=0:d=0.35,afade=t=out:st={:.3}:d=0.45", out_dur - 0.45) } else { "anull".into() };
    g.push(format!("{a}{achain}[aout]"));
    g.join(";")
}

pub struct ExportJob<'a> {
    pub src: &'a Path,
    pub start: f64,
    pub end: f64,
    /// Size limit in MB; 0 means no limit.
    pub target_mb: f64,
    pub out_dir: &'a Path,
    pub label: &'a str,
    pub meta: &'a Meta,
    pub src_size: u64,
    pub fx: &'a Fx,
    /// Exact output file name; otherwise one is derived from the source and label.
    pub out_name: Option<&'a str>,
}

#[derive(Clone, Serialize)]
pub struct ExportOut {
    pub path: String,
    pub size: u64,
    pub reencoded: bool,
    pub duration: f64,
}

fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Cuts [start, end] out of the source, optionally applying effects.
/// With no effects it stream-copies when the result already fits the target
/// (or no target is given); otherwise it re-encodes, to the target size if
/// one is set.
pub async fn export_clip(job: ExportJob<'_>, on: Progress<'_>) -> Result<ExportOut, String> {
    let fx = job.fx.normalized();
    let meta = job.meta;
    let dur = (job.end - job.start).max(0.1);
    std::fs::create_dir_all(job.out_dir).map_err(|e| e.to_string())?;
    let base = job.src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "clip".into());
    let out = match job.out_name {
        Some(name) => job.out_dir.join(name),
        None => unique_path(job.out_dir, &base, job.label),
    };
    let target_bytes = job.target_mb * 1_048_576.0;
    let est_copy_mb = job.src_size as f64 / meta.duration.max(0.1) * dur / 1_048_576.0;
    let done = |reencoded: bool, duration: f64| ExportOut { path: out.to_string_lossy().into_owned(), size: file_size(&out), reencoded, duration };

    if !fx.active() && (job.target_mb <= 0.0 || est_copy_mb <= job.target_mb * 0.97) {
        let mut args = Args::new();
        args.add(&["-ss", &format!("{:.3}", job.start), "-t", &format!("{dur:.3}"), "-i"]).arg(job.src);
        if meta.audio_tracks > 1 {
            let ins: String = (0..meta.audio_tracks).map(|i| format!("[0:a:{i}]")).collect();
            let mix = format!("{ins}amix=inputs={}:normalize=0[a]", meta.audio_tracks);
            args.add(&["-filter_complex", &mix, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k"]);
        } else {
            args.add(&["-map", "0:v:0", "-map", "0:a?", "-c", "copy"]);
        }
        args.add(&["-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "-y"]).arg(&out);
        run_ffmpeg(args.0, None, dur, on).await?;
        return Ok(done(false, dur));
    }

    let slow = slow_window(fx.moment, job.start, dur);
    let out_dur = dur + slow.map(|(a, b)| b - a).unwrap_or(0.0);
    let enc = (job.target_mb > 0.0).then(|| encode_settings(job.target_mb, out_dur, meta.height));
    let src_fps = if meta.fps > 0 { meta.fps } else { 60 };
    let fps = if fx.uniform { 60 } else { src_fps.min(if enc.as_ref().is_some_and(|e| e.fps30) { 30 } else { 60 }) };
    let font = if fx.title.is_empty() { None } else { font_file() };
    let limit_h = enc.as_ref().map(|e| e.height).unwrap_or(meta.height);
    let graph = build_graph(meta, dur, out_dur, slow, &fx, limit_h, fps, font);
    // drawtext resolves the font relative to the working directory, which
    // avoids escaping a Windows path inside the filter graph.
    let fonts = font_dir();
    let cwd = font.map(|_| fonts.as_path());

    let build = |video_k: Option<u32>| {
        let mut args = Args::new();
        args.add(&["-ss", &format!("{:.3}", job.start), "-t", &format!("{dur:.3}"), "-i"]).arg(job.src);
        if let Some(music) = &fx.music {
            args.add(&["-stream_loop", "-1", "-i"]).arg(music);
        }
        args.add(&["-filter_complex", &graph, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]);
        match video_k {
            Some(k) => args.add(&["-b:v", &format!("{k}k"), "-maxrate", &format!("{k}k"), "-bufsize", &format!("{}k", k * 2)]),
            None => args.add(&["-crf", "18"]),
        };
        let audio_k = enc.as_ref().map(|e| e.audio_k).unwrap_or(192);
        args.add(&["-c:a", "aac", "-b:a", &format!("{audio_k}k"), "-ac", "2", "-ar", "48000", "-t", &format!("{out_dur:.3}"), "-movflags", "+faststart", "-y"])
            .arg(&out);
        args.0
    };

    run_ffmpeg(build(enc.as_ref().map(|e| e.video_k)), cwd, out_dur, on).await?;

    // Rate control can overshoot on short clips: one corrective pass.
    if let Some(e) = &enc {
        let size = file_size(&out) as f64;
        if size > target_bytes {
            on(0.0);
            let k = ((e.video_k as f64 * (target_bytes / size) * 0.93).floor() as u32).max(60);
            run_ffmpeg(build(Some(k)), cwd, out_dur, on).await?;
        }
    }
    Ok(done(true, out_dur))
}

pub struct Segment {
    pub src: PathBuf,
    pub start: f64,
    pub end: f64,
    pub meta: Meta,
    pub src_size: u64,
    pub moment: Option<f64>,
}

/// Renders each segment to matching 60fps files, then joins them without a
/// second video encode. Music, if any, is laid over the whole reel.
pub async fn make_reel(segments: &[Segment], fx: &Fx, out_dir: &Path, tmp_dir: &Path, on: Progress<'_>) -> Result<ExportOut, String> {
    let fx = fx.normalized();
    std::fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let result = build_reel(segments, &fx, out_dir, tmp_dir, on).await;
    let _ = std::fs::remove_dir_all(tmp_dir);
    result
}

async fn build_reel(segments: &[Segment], fx: &Fx, out_dir: &Path, tmp_dir: &Path, on: Progress<'_>) -> Result<ExportOut, String> {
    let count = segments.len() as f64;
    let mut total = 0.0;
    for (i, seg) in segments.iter().enumerate() {
        let seg_fx = Fx {
            style: fx.style.clone(),
            format: fx.format.clone(),
            fades: true,
            title: if i == 0 { fx.title.clone() } else { String::new() },
            moment: seg.moment,
            uniform: true,
            ..Fx::default()
        };
        let name = format!("seg{i}.mp4");
        let step = move |p: f64| on((i as f64 + p) / count * 0.94);
        let out = export_clip(
            ExportJob { src: &seg.src, start: seg.start, end: seg.end, target_mb: 0.0, out_dir: tmp_dir, label: "seg", meta: &seg.meta, src_size: seg.src_size, fx: &seg_fx, out_name: Some(&name) },
            &step,
        )
        .await?;
        total += out.duration;
    }
    let list: Vec<String> = (0..segments.len()).map(|i| format!("file 'seg{i}.mp4'")).collect();
    std::fs::write(tmp_dir.join("list.txt"), list.join("\n")).map_err(|e| e.to_string())?;

    let stamp = chrono::Local::now().format("%Y.%m.%d - %H.%M").to_string();
    let out = unique_path(out_dir, &format!("Highlight Reel {stamp}"), &format!("{} clips", segments.len()));
    let mut args = Args::new();
    args.add(&["-f", "concat", "-safe", "0", "-i", "list.txt"]);
    if let Some(music) = &fx.music {
        let mix = format!(
            "[0:a]volume={}[g];[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.8[m];[g][m]amix=inputs=2:duration=first:normalize=0,afade=t=out:st={:.2}:d=1[a]",
            fx.vol(),
            (total - 1.0).max(0.0)
        );
        args.add(&["-stream_loop", "-1", "-i"]).arg(music);
        args.add(&["-filter_complex", &mix, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", &format!("{total:.3}")]);
    } else {
        args.add(&["-c", "copy"]);
    }
    args.add(&["-movflags", "+faststart", "-y"]).arg(&out);
    run_ffmpeg(args.0, Some(tmp_dir), total, &|_| {}).await?;
    on(1.0);
    Ok(ExportOut { path: out.to_string_lossy().into_owned(), size: file_size(&out), reencoded: true, duration: total })
}
