# setup-binaries.ps1
# Automates downloading and setting up required sidecar binaries for Aurales development on Windows.

$ErrorActionPreference = 'Stop'

# 1. Create binaries directory
$BinDir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
if (!(Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Write-Host "Created binaries directory: $BinDir" -ForegroundColor Green
}

# Helper to find 7z
function Find-7Zip {
    $Paths = @(
        "7z.exe",
        "C:\Program Files\7-Zip\7z.exe",
        "C:\Program Files (x86)\7-Zip\7z.exe"
    )
    foreach ($Path in $Paths) {
        if (Get-Command $Path -ErrorAction SilentlyContinue) {
            return $Path
        }
    }
    return $null
}

$7zPath = Find-7Zip
if ($null -eq $7zPath) {
    Write-Warning "7-Zip (7z.exe) was not found in your PATH or standard install directories."
    Write-Warning "Please install 7-Zip (https://7-zip.org/) or add it to your PATH, then re-run this script."
    Write-Warning "Alternatively, download the binaries manually and place them in: src-tauri/binaries/"
    Exit 1
}

$TempDir = Join-Path $env:TEMP "aurales-bin-setup"
if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir | Out-Null
}
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

Write-Host "Fetching latest shinchiro mpv release information..." -ForegroundColor Cyan
$MpvRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest" -Headers @{ "User-Agent" = "aurales-setup" }

# --- 2. Download and Extract mpv ---
$MpvAsset = $MpvRelease.assets | Where-Object { $_.name -match '^mpv-x86_64-\d' } | Select-Object -First 1
if ($null -eq $MpvAsset) {
    Write-Error "Could not find latest mpv-x86_64 asset."
}

Write-Host "Downloading mpv from: $($MpvAsset.browser_download_url)..." -ForegroundColor Cyan
$MpvArchive = Join-Path $TempDir "mpv.7z"
Invoke-WebRequest -Uri $MpvAsset.browser_download_url -OutFile $MpvArchive -UserAgent "aurales-setup"

Write-Host "Extracting mpv..." -ForegroundColor Cyan
& $7zPath x $MpvArchive -o"$TempDir\mpv" -y | Out-Null

# Copy mpv.exe and d3dcompiler_43.dll
Copy-Item (Join-Path $TempDir "mpv\mpv.exe") (Join-Path $BinDir "mpv-x86_64-pc-windows-msvc.exe") -Force
if (Test-Path (Join-Path $TempDir "mpv\d3dcompiler_43.dll")) {
    Copy-Item (Join-Path $TempDir "mpv\d3dcompiler_43.dll") (Join-Path $BinDir "d3dcompiler_43.dll") -Force
}
Write-Host "Successfully configured mpv sidecar." -ForegroundColor Green

# --- 3. Download and Extract libmpv ---
$LibMpvAsset = $MpvRelease.assets | Where-Object { $_.name -match '^mpv-dev-x86_64-\d' } | Select-Object -First 1
if ($null -eq $LibMpvAsset) {
    Write-Error "Could not find latest mpv-dev-x86_64 asset."
}

Write-Host "Downloading libmpv from: $($LibMpvAsset.browser_download_url)..." -ForegroundColor Cyan
$LibMpvArchive = Join-Path $TempDir "libmpv.7z"
Invoke-WebRequest -Uri $LibMpvAsset.browser_download_url -OutFile $LibMpvArchive -UserAgent "aurales-setup"

Write-Host "Extracting libmpv..." -ForegroundColor Cyan
& $7zPath x $LibMpvArchive -o"$TempDir\libmpv" -y libmpv-2.dll | Out-Null

Copy-Item (Join-Path $TempDir "libmpv\libmpv-2.dll") (Join-Path $BinDir "libmpv-2.dll") -Force
Write-Host "Successfully configured libmpv-2.dll." -ForegroundColor Green

# --- 4. Download yt-dlp ---
Write-Host "Downloading latest yt-dlp binary..." -ForegroundColor Cyan
$YtdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
Invoke-WebRequest -Uri $YtdlpUrl -OutFile (Join-Path $BinDir "yt-dlp-x86_64-pc-windows-msvc.exe") -UserAgent "aurales-setup"
Write-Host "Successfully configured yt-dlp sidecar." -ForegroundColor Green

# --- 5. Download ffmpeg (Optional but recommended) ---
Write-Host "Downloading latest ffmpeg-release-essentials zip..." -ForegroundColor Cyan
$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$FfmpegArchive = Join-Path $TempDir "ffmpeg.zip"
Invoke-WebRequest -Uri $FfmpegUrl -OutFile $FfmpegArchive -UserAgent "aurales-setup"

Write-Host "Extracting ffmpeg..." -ForegroundColor Cyan
Expand-Archive -Path $FfmpegArchive -DestinationPath "$TempDir\ffmpeg" -Force

$FfmpegExe = Get-ChildItem -Path "$TempDir\ffmpeg" -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
if ($null -ne $FfmpegExe) {
    Copy-Item $FfmpegExe.FullName (Join-Path $BinDir "ffmpeg.exe") -Force
    Write-Host "Successfully configured ffmpeg.exe." -ForegroundColor Green
} else {
    Write-Warning "Could not locate ffmpeg.exe inside the downloaded zip."
}

# Clean up
Write-Host "Cleaning up temporary files..." -ForegroundColor Cyan
Remove-Item -Recurse -Force $TempDir | Out-Null

Write-Host "`nAll binaries successfully installed in src-tauri/binaries/!" -ForegroundColor Green
Get-ChildItem $BinDir | Format-Table Name, Length -AutoSize
