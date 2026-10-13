[CmdletBinding()]
param([string]$AdbPath, [string]$Serial)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$release = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$apk = Join-Path $PSScriptRoot ('T3-' + $release.version + '.apk')
if ((Get-FileHash -LiteralPath $apk).Hash.ToLowerInvariant() -ne $release.apkSha256) { throw 'APK checksum mismatch.' }
if (-not $AdbPath) {
    $command = Get-Command adb -ErrorAction SilentlyContinue
    if ($command) { $AdbPath = $command.Source }
}
if (-not $AdbPath) { throw 'ADB not found. Use -AdbPath, or install the APK directly on Android.' }
$devices = & $AdbPath devices
if ($LASTEXITCODE -ne 0) { throw 'ADB device detection failed.' }
$ready = @($devices | Where-Object { $_ -match '^\S+\s+device$' } | ForEach-Object { ($_ -split '\s+')[0] })
if (-not $Serial) { if ($ready.Count -ne 1) { throw 'Connect/unlock exactly one authorized phone, or specify -Serial.' }; $Serial = $ready[0] }
if ($Serial -notin $ready) { throw 'Requested phone is not authorized and ready.' }
$installed = & $AdbPath -s $Serial shell dumpsys package $release.androidApplicationId
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect installed package.' }
if (($installed -join "`n") -match 'versionCode=(\d+)' -and [int]$Matches[1] -ge $release.androidVersionCode) { throw 'Installed version is the same or newer; Android update requires a higher versionCode.' }
& $AdbPath -s $Serial install -r $apk
if ($LASTEXITCODE -ne 0) { throw 'Android installation failed. Old data is retained. A debug/release signature mismatch requires a deliberate migration after pending work is synced; this script never uninstalls.' }
& $AdbPath -s $Serial shell am start -W -n ($release.androidApplicationId + '/.MainActivity')
if ($LASTEXITCODE -ne 0) { throw 'APK installed, but launching failed.' }
Write-Host "Installed T3 $($release.version); existing app data retained by cover-install."
