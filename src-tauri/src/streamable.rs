use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio_util::io::ReaderStream;

/// Free-plan limits. Clips over these are trimmed/compressed before upload.
pub const LIMIT_MB: f64 = 250.0;
pub const LIMIT_SECONDS: f64 = 600.0;

/// Streams a file to Streamable's upload API so large clips never sit in
/// memory, reporting byte progress as it goes. Returns the share URL.
pub async fn upload(file: &Path, email: &str, password: &str, title: &str, on: Arc<dyn Fn(f64) + Send + Sync>) -> Result<String, String> {
    let handle = tokio::fs::File::open(file).await.map_err(|e| e.to_string())?;
    let size = handle.metadata().await.map_err(|e| e.to_string())?.len().max(1);
    let sent = Arc::new(AtomicU64::new(0));
    let stream = ReaderStream::with_capacity(handle, 256 * 1024).map(move |chunk| {
        if let Ok(bytes) = &chunk {
            let total = sent.fetch_add(bytes.len() as u64, Ordering::Relaxed) + bytes.len() as u64;
            on(total as f64 / size as f64);
        }
        chunk
    });
    let name: String = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "clip.mp4".into())
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || ".- ()_".contains(c) { c } else { '_' })
        .collect();
    let part = Part::stream_with_length(reqwest::Body::wrap_stream(stream), size)
        .file_name(name)
        .mime_str("video/mp4")
        .map_err(|e| e.to_string())?;

    let res = reqwest::Client::new()
        .post("https://api.streamable.com/upload")
        .query(&[("title", title)])
        .basic_auth(email, Some(password))
        .header("User-Agent", "ReplayStrike/0.3")
        .multipart(Form::new().part("file", part))
        .send()
        .await
        .map_err(|e| format!("Could not reach Streamable: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("Streamable rejected the login. Check the email and password in Folders & accounts.".into());
    }
    let shortcode = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["shortcode"].as_str().map(str::to_string))
        .filter(|_| status.is_success());
    match shortcode {
        Some(code) => Ok(format!("https://streamable.com/{code}")),
        None => Err(format!("Streamable upload failed ({}): {}", status.as_u16(), body.chars().take(200).collect::<String>())),
    }
}
