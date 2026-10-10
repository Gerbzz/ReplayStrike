# Downloads the ffmpeg and ffprobe binaries ReplayStrike bundles as sidecars.
# They are too large for git, so run this once after cloning:
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg.ps1
$ErrorActionPreference = 'Stop'
$release = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'
$dest = Join-Path $PSScriptRoot '..\src-tauri\binaries'
New-Item -ItemType Directory -Force $dest | Out-Null

foreach ($tool in 'ffmpeg', 'ffprobe') {
    $out = Join-Path $dest "$tool-x86_64-pc-windows-msvc.exe"
    if (Test-Path $out) {
        Write-Host "$tool already present"
        continue
    }
    Write-Host "Downloading $tool..."
    curl.exe -L --fail --silent --show-error -o $out "$release/$tool-win32-x64"
    if ($LASTEXITCODE -ne 0) { throw "Could not download $tool" }
}
Write-Host 'Done.'
