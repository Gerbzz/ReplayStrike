# Downloads the programs ReplayStrike bundles: ffmpeg, ffprobe and the
# whisper.cpp speech engine. They are too large for git, so run this once
# after cloning:
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-binaries.ps1
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\src-tauri'

$ffmpegRelease = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'
$binaries = Join-Path $root 'binaries'
New-Item -ItemType Directory -Force $binaries | Out-Null
foreach ($tool in 'ffmpeg', 'ffprobe') {
    $out = Join-Path $binaries "$tool-x86_64-pc-windows-msvc.exe"
    if (Test-Path $out) { Write-Host "$tool already present"; continue }
    Write-Host "Downloading $tool..."
    curl.exe -L --fail --silent --show-error -o $out "$ffmpegRelease/$tool-win32-x64"
    if ($LASTEXITCODE -ne 0) { throw "Could not download $tool" }
}

$whisper = Join-Path $root 'whisper'
if (Test-Path (Join-Path $whisper 'whisper-cli.exe')) {
    Write-Host 'whisper already present'
} else {
    Write-Host 'Downloading whisper.cpp...'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "replaystrike-whisper-$PID"
    New-Item -ItemType Directory -Force $tmp, $whisper | Out-Null
    curl.exe -L --fail --silent --show-error -o "$tmp\whisper.zip" 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
    if ($LASTEXITCODE -ne 0) { throw 'Could not download whisper.cpp' }
    Expand-Archive -LiteralPath "$tmp\whisper.zip" -DestinationPath $tmp -Force
    # Only the command-line transcriber and the libraries it loads.
    foreach ($pattern in 'whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-*.dll') {
        Copy-Item (Join-Path $tmp "Release\$pattern") $whisper
    }
    Remove-Item -Recurse -Force $tmp
}
Write-Host 'Done. The speech model itself is downloaded by the app the first time it is needed.'
