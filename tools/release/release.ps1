[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$NodePath,
    [string]$NodeLicenseFile,
    [string]$PythonBase,
    [string]$PythonPackages,
    [string]$OpenSslDirectory,
    [string]$JavaHome,
    [string]$AndroidSdk,
    [string]$BrowserDirectory,
    [switch]$KeepVersion
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
. (Join-Path $PSScriptRoot 'version.ps1')
$repo = Get-T3FullPath (Join-Path $PSScriptRoot '../..')
$releaseRoot = Assert-T3Child (Join-Path $repo '.releases') $repo
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
$releaseLock = [IO.File]::Open((Join-Path $releaseRoot '.release.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
$configPath = Join-Path $repo 'release.json'
$versionPlan = Get-T3ReleaseVersionPlan $configPath $releaseRoot -KeepVersion:$KeepVersion
$config = $versionPlan.Config
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ('.releases/' + $config.version) }
$output = Assert-T3Child $OutputDirectory $repo
if (Test-Path -LiteralPath $output) { throw 'Release destination already exists. Choose a new directory or increase release.json version.' }
if (-not $NodePath) {
    $candidates = @((Join-Path $repo 'tools/node/node.exe'), (Join-Path $env:LOCALAPPDATA 'hermes/node/node.exe'), (Get-Command node -ErrorAction SilentlyContinue).Source)
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            Push-Location (Join-Path $repo 'apps/server')
            try { & $candidate -e "const D=require('better-sqlite3');new D(':memory:').close()" 2>$null; if ($LASTEXITCODE -eq 0) { $NodePath = $candidate; break } } finally { Pop-Location }
        }
    }
}
if (-not $NodePath) { throw 'Install a compatible Node runtime and project dependencies first.' }
if (-not $PythonBase) {
    $venv = Get-Content -LiteralPath (Join-Path $repo 'siteprobe/.venv/pyvenv.cfg')
    $PythonBase = (($venv | Where-Object { $_ -match '^home = ' }) -replace '^home = ', '').Trim()
}
if (-not $PythonPackages) { $PythonPackages = Join-Path $repo 'siteprobe/.venv/Lib/site-packages' }
if (-not $OpenSslDirectory) {
    $command = Get-Command openssl -ErrorAction SilentlyContinue
    if ($command) { $OpenSslDirectory = Split-Path -Parent $command.Source }
    else { $OpenSslDirectory = Join-Path (Split-Path -Parent (Split-Path -Parent (Get-Command git).Source)) 'mingw64/bin' }
}
if (-not $JavaHome) { $JavaHome = $env:JAVA_HOME }
if (-not $JavaHome) {
    $jdk = Get-ChildItem -LiteralPath 'C:/Program Files/Eclipse Adoptium' -Directory -ErrorAction SilentlyContinue | Where-Object Name -Like 'jdk-21*' | Select-Object -First 1
    if ($jdk) { $JavaHome = $jdk.FullName }
}
if (-not $AndroidSdk) { $AndroidSdk = $env:ANDROID_HOME }
if (-not $AndroidSdk) { $AndroidSdk = Join-Path $repo 'spikes/001-android-webview-shell/.android-sdk' }
foreach ($required in @($NodePath, (Join-Path $PythonBase 'python.exe'), $PythonPackages, (Join-Path $OpenSslDirectory 'openssl.exe'), (Join-Path $JavaHome 'bin/java.exe'), (Join-Path $AndroidSdk 'build-tools/36.0.0/aapt.exe'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required build tool not found: $required" }
}
if (-not $KeepVersion) {
    Save-T3ReleaseVersionPlan $configPath $releaseRoot $versionPlan
}
Write-Host "Building T3 $($config.version), Android versionCode $($config.androidVersionCode)"
function Invoke-T3Tool([string]$Command, [string[]]$Arguments, [string]$Directory) {
    Push-Location $Directory
    try { & $Command @Arguments; if ($LASTEXITCODE -ne 0) { throw "Build command failed: $Command (exit $LASTEXITCODE)" } } finally { Pop-Location }
}
function Copy-T3Tree([string]$Source, [string]$Destination, [string[]]$Exclude = @()) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($item.Name -in $Exclude -or $item.Name -in @('__pycache__', '.git', '.data', '.env', '.pytest_cache') -or $item.Name -like '*.pyc') { continue }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot distribute a redirected runtime file: $($item.FullName)" }
        $to = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) { Copy-T3Tree $item.FullName $to $Exclude } else { Copy-Item -LiteralPath $item.FullName -Destination $to }
    }
}
function Get-T3InputFingerprint {
    $lines = foreach ($relative in @('release.json', 'pnpm-lock.yaml', 'apps/server/package.json', 'packages/shared/package.json', 'docs/release-installation.md', 'apps/web/src', 'apps/web/public', 'apps/web/index.html', 'apps/web/vite.config.ts', 'apps/server/src', 'packages/shared/src', 'tools/release', 'tools/t3-launcher/Program.cs', 'tools/t3-launcher/LauncherPolicy.cs', 'tools/t3-launcher/T3Launcher.csproj', 'spikes/001-android-webview-shell/android/app/src', 'spikes/001-android-webview-shell/android/app/build.gradle', 'siteprobe/src', 'siteprobe/adapters/builtin')) {
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $repo $relative) -Recurse -File | Sort-Object FullName) {
            if ($file.FullName -match '__pycache__|[\\/]android[\\/]app[\\/]src[\\/]main[\\/]assets[\\/]') { continue }
            $file.FullName.Substring($repo.Length) + ':' + (Get-FileHash -LiteralPath $file.FullName).Hash
        }
    }
    $lines += foreach ($file in Get-ChildItem -LiteralPath (Join-Path $repo 'siteprobe') -File | Sort-Object Name) {
        if (($file.Extension -eq '.py' -and $file.Name -notmatch '^(_|test_|verify_|compare_)') -or $file.Extension -eq '.bat' -or $file.Name -in @('README.md', 'pyproject.toml')) { $file.Name + ':' + (Get-FileHash -LiteralPath $file.FullName).Hash }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
$originalPath = $env:PATH
$originalBuildId = $env:VITE_T3_BUILD_ID
$originalJava = $env:JAVA_HOME
$originalSdk = $env:ANDROID_HOME
$originalBrowsers = $env:PLAYWRIGHT_BROWSERS_PATH
New-Item -ItemType Directory -Path $output | Out-Null
$desktop = Join-Path $output 'TagTraceTrove'
New-Item -ItemType Directory -Path $desktop | Out-Null
$success = $false
try {
    $fingerprint = Get-T3InputFingerprint
    $env:PATH = (Split-Path -Parent $NodePath) + ';' + $originalPath
    $env:JAVA_HOME = $JavaHome
    $env:ANDROID_HOME = $AndroidSdk
    $env:VITE_T3_BUILD_ID = $config.version
    Write-Host '[1/6] Build shared Web bundle and signed Android release'
    Invoke-T3Tool $NodePath @('node_modules/vite/bin/vite.js', 'build') (Join-Path $repo 'apps/web')
    $androidShell = Join-Path $repo 'spikes/001-android-webview-shell'
    Invoke-T3Tool $NodePath @('prepare-web.mjs') $androidShell
    Invoke-T3Tool $NodePath @('node_modules/@capacitor/cli/bin/capacitor', 'copy', 'android') $androidShell
    Invoke-T3Tool (Join-Path $androidShell 'android/gradlew.bat') @('assembleRelease', '--console=plain', ('-Dorg.gradle.java.home=' + $JavaHome)) (Join-Path $androidShell 'android')
    $apk = Join-Path $output ('T3-' + $config.version + '.apk')
    Copy-Item -LiteralPath (Join-Path $androidShell 'android/app/build/outputs/apk/release/app-release.apk') -Destination $apk
    $badging = & (Join-Path $AndroidSdk 'build-tools/36.0.0/aapt.exe') dump badging $apk
    if ($LASTEXITCODE -ne 0 -or ($badging -join "`n") -notmatch "name='$([regex]::Escape($config.androidApplicationId))' versionCode='$($config.androidVersionCode)' versionName='$([regex]::Escape($config.version))'" -or ($badging -join "`n") -match 'application-debuggable') { throw 'APK identity/debuggable check failed.' }
    $signer = & (Join-Path $AndroidSdk 'build-tools/36.0.0/apksigner.bat') verify --print-certs $apk
    if ($LASTEXITCODE -ne 0 -or ($signer -join "`n") -notmatch [regex]::Escape($config.androidSignerSha256)) { throw 'APK signer differs from release.json; release rejected.' }
    Write-Host '[2/6] Build self-contained Windows launcher'
    Invoke-T3Tool 'dotnet' @('publish', 'T3Launcher.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', ('-p:Version=' + $config.version), '-o', (Join-Path $output 'launcher-build')) (Join-Path $repo 'tools/t3-launcher')
    Copy-Item -LiteralPath (Join-Path $output 'launcher-build/T3Launcher.exe') -Destination (Join-Path $desktop 'T3.exe')
    Write-Host '[3/6] Materialize Node runtime and dependencies'
    Invoke-T3Tool $NodePath @((Join-Path $PSScriptRoot 'copy-runtime.mjs'), $repo, $desktop) $repo
    New-Item -ItemType Directory -Force -Path (Join-Path $desktop 'tools/node') | Out-Null
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $desktop 'tools/node/node.exe')
    if (-not $NodeLicenseFile) {
        $NodeLicenseFile = Join-Path (Split-Path -Parent $NodePath) 'LICENSE'
        if (-not (Test-Path -LiteralPath $NodeLicenseFile)) {
            $nodeVersion = (& $NodePath --version).Trim()
            $noticeDirectory = Join-Path $repo ('.releases/runtime-cache/' + $nodeVersion)
            New-Item -ItemType Directory -Force -Path $noticeDirectory | Out-Null
            $NodeLicenseFile = Join-Path $noticeDirectory 'NODE-LICENSE.txt'
            if (-not (Test-Path -LiteralPath $NodeLicenseFile)) {
                Invoke-WebRequest -UseBasicParsing -Uri ('https://raw.githubusercontent.com/nodejs/node/' + $nodeVersion + '/LICENSE') -OutFile $NodeLicenseFile
            }
        }
    }
    Copy-Item -LiteralPath $NodeLicenseFile -Destination (Join-Path $desktop 'tools/node/LICENSE.txt')
    Copy-T3Tree (Join-Path $repo 'apps/web/dist') (Join-Path $desktop 'apps/web/dist')
    Write-Host '[4/6] Bundle portable Python, SiteProbe, browser and OpenSSL'
    $pythonTarget = Join-Path $desktop 'siteprobe/.venv/Scripts'
    New-Item -ItemType Directory -Force -Path $pythonTarget | Out-Null
    foreach ($name in @('python.exe', 'pythonw.exe', 'python3.dll', 'python311.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt')) {
        if (Test-Path -LiteralPath (Join-Path $PythonBase $name)) { Copy-Item -LiteralPath (Join-Path $PythonBase $name) -Destination $pythonTarget }
    }
    Copy-T3Tree (Join-Path $PythonBase 'DLLs') (Join-Path $pythonTarget 'DLLs')
    Copy-T3Tree (Join-Path $PythonBase 'Lib') (Join-Path $pythonTarget 'Lib') @('site-packages', 'test', 'tests', 'idlelib', 'ensurepip')
    Copy-T3Tree $PythonPackages (Join-Path $pythonTarget 'Lib/site-packages') @('_pytest', 'pytest', 'generic_probe-0.1.0.dist-info', '__editable__.generic_probe-0.1.0.pth', '__editable___generic_probe_0_1_0_finder.py', '_virtualenv.pth', '_virtualenv.py')
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $repo 'siteprobe') -File) {
        if (($file.Extension -eq '.py' -and $file.Name -notmatch '^(_|test_|verify_|compare_)') -or $file.Extension -eq '.bat' -or $file.Name -in @('README.md', 'pyproject.toml')) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $desktop 'siteprobe') }
    }
    Copy-T3Tree (Join-Path $repo 'siteprobe/src') (Join-Path $desktop 'siteprobe/src') @('tests')
    Copy-T3Tree (Join-Path $repo 'siteprobe/adapters/builtin') (Join-Path $desktop 'siteprobe/adapters/builtin')
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $desktop 'tools/playwright'
    if ($BrowserDirectory) { Copy-T3Tree $BrowserDirectory $env:PLAYWRIGHT_BROWSERS_PATH @('.links') }
    else { Invoke-T3Tool (Join-Path $pythonTarget 'python.exe') @('-m', 'playwright', 'install', 'chromium') (Join-Path $desktop 'siteprobe') }
    $links = Assert-T3Child (Join-Path $env:PLAYWRIGHT_BROWSERS_PATH '.links') $desktop
    if (Test-Path -LiteralPath $links) { Remove-Item -LiteralPath $links -Recurse -Force }
    $opensslTarget = Join-Path $desktop 'tools/openssl'
    New-Item -ItemType Directory -Force -Path $opensslTarget | Out-Null
    foreach ($name in @('openssl.exe', 'libssl-3-x64.dll', 'libcrypto-3-x64.dll', 'zlib1.dll')) {
        Copy-Item -LiteralPath (Join-Path $OpenSslDirectory $name) -Destination $opensslTarget
    }
    $opensslNotices = Join-Path (Split-Path -Parent $OpenSslDirectory) 'share/licenses'
    foreach ($name in @('openssl', 'zlib', 'gcc-libs')) {
        if (Test-Path -LiteralPath (Join-Path $opensslNotices $name)) { Copy-T3Tree (Join-Path $opensslNotices $name) (Join-Path $opensslTarget ('licenses/' + $name)) }
    }
    # Minimal portable configuration; do not inherit the builder's absolute OpenSSL config path.
    [IO.File]::WriteAllText((Join-Path $opensslTarget 'openssl.cnf'), '[req]' + "`n" + 'distinguished_name=req_distinguished_name' + "`n" + '[req_distinguished_name]' + "`n")
    foreach ($name in @('Install.ps1', 'Install.cmd', 'Install-Demo.cmd', 'Start.ps1', 'Start.cmd', 'Uninstall.ps1', 'Uninstall.cmd', 'lifecycle.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $desktop }
    Copy-Item -LiteralPath (Join-Path $repo 'docs/release-installation.md') -Destination (Join-Path $desktop 'INSTALL.md')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-Android.ps1') -Destination $output
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-Android.cmd') -Destination $output
    Copy-Item -LiteralPath (Join-Path $repo 'docs/release-installation.md') -Destination (Join-Path $output 'INSTALL.md')
    Write-Host '[5/6] Write integrity manifest and check frozen inputs'
    if ((Get-T3InputFingerprint) -ne $fingerprint) { throw 'Release inputs changed during packaging. Rerun from a stable checkout.' }
    $files = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $desktop -Recurse -File -Force | Sort-Object FullName) {
        $relative = $file.FullName.Substring($desktop.Length + 1).Replace('\','/')
        $files[$relative] = (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
    Write-T3Json (Join-Path $desktop 'release-manifest.json') @{ product = 'T3'; platform = 'win-x64'; version = $config.version; sourceSha256 = $fingerprint; files = $files }
    Write-T3Json (Join-Path $output 'release.json') @{ product = 'T3'; version = $config.version; windowsContentDirectory = 'TagTraceTrove'; sourceSha256 = $fingerprint; androidApplicationId = $config.androidApplicationId; androidVersionCode = $config.androidVersionCode; androidSignerSha256 = $config.androidSignerSha256; apkSha256 = (Get-FileHash -LiteralPath $apk).Hash.ToLowerInvariant(); nodeVersion = (& $NodePath --version); createdAtUtc = [DateTime]::UtcNow.ToString('o') }
    Write-Host '[6/6] Create Windows ZIP and SHA256SUMS'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($desktop, (Join-Path $output ('T3-' + $config.version + '-windows-x64.zip')), [IO.Compression.CompressionLevel]::Optimal, $true)
    $checksums = foreach ($file in Get-ChildItem -LiteralPath $output -File | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name) { (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant() + '  ' + $file.Name }
    [IO.File]::WriteAllLines((Join-Path $output 'SHA256SUMS.txt'), [string[]]$checksums)
    $success = $true
    Write-Host "Release ready: $output"
} finally {
    $env:PATH = $originalPath; $env:VITE_T3_BUILD_ID = $originalBuildId; $env:JAVA_HOME = $originalJava; $env:ANDROID_HOME = $originalSdk; $env:PLAYWRIGHT_BROWSERS_PATH = $originalBrowsers
    if (-not $success) { [IO.File]::WriteAllText((Join-Path $output 'RELEASE-FAILED.txt'), 'Incomplete release. Do not distribute. Fix the error and rerun Release.bat; automatic versioning selects a new release.') }
}
} finally { $releaseLock.Dispose() }
