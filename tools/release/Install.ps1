[CmdletBinding()]
param([string]$InstallRoot, [string]$LegacyRoot, [switch]$Start, [switch]$NoShortcut,
    [int]$Port, [int]$TlsPort, [string]$InstanceName, [int]$BootstrapPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:installStage = 'Initializing installer'
$script:installLogPath = $null
foreach ($candidate in @((Join-Path $PSScriptRoot 't3-install.log'), (Join-Path $env:LOCALAPPDATA ('T3/diagnostics/install-' + $PID + '.log')), (Join-Path ([IO.Path]::GetTempPath()) ('T3-install-' + $PID + '.log')))) {
    try {
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($candidate))
        [IO.File]::AppendAllText($candidate, ('--- T3 installer ' + [DateTimeOffset]::Now.ToString('o') + ' ---' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
        $script:installLogPath = $candidate
        break
    } catch { }
}
function Write-InstallStage([string]$Message) {
    $script:installStage = $Message
    $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Message
    Write-Host $line
    if ($script:installLogPath) {
        try { [IO.File]::AppendAllText($script:installLogPath, ($line + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) }
        catch { Write-Warning ('Cannot append installation log: ' + $_.Exception.Message) }
    }
}
try {
Write-InstallStage 'Loading installation helpers'
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
# Windows PowerShell 5.1 can evaluate advanced-script parameter defaults
# before PSScriptRoot is populated when invoked with -File (Install.cmd).
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = $PSScriptRoot }
$source = Get-T3FullPath $PSScriptRoot
$root = Get-T3FullPath $InstallRoot
if ($root -ne $source -and ($root.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'The release source and installation must be separate directories, or exactly the same directory.' }
Write-InstallStage ('Checking package at ' + $source)
$verifyProgress = { param($Index, $Total, $Name); Write-InstallStage ("Verifying $Index/$Total : $Name") }
$manifest = Read-T3Manifest $source -Progress $verifyProgress
Write-InstallStage 'Checking destination paths and installation record'
$stagingPrefix = Join-Path $root 'versions/.staging-xxxxxxxxxxxx'
foreach ($file in $manifest.files.PSObject.Properties) {
    $candidate = Join-Path $stagingPrefix $file.Name
    if ($candidate.Length -gt 259 -or ([IO.Path]::GetDirectoryName($candidate)).Length -gt 247) {
        throw 'The installation path is too long for Windows file operations. Choose a shorter installation directory; the existing library has not been changed.'
    }
}
$statePath = Join-Path $root 'installation.json'
if ($root -ne $source -and (Test-Path -LiteralPath $root) -and -not (Test-Path -LiteralPath $statePath) -and @(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) { throw 'Destination is not a T3-managed installation; choose an empty directory.' }
New-Item -ItemType Directory -Force -Path $root | Out-Null
Write-InstallStage 'Acquiring installation lock'
$lock = [IO.File]::Open((Join-Path $root '.maintenance.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if ($BootstrapPid -and $root -ne $source) { throw 'Bootstrap process exemption is only allowed for installing in place.' }
    Write-InstallStage 'Checking process ownership (WMI)'
    Assert-T3Stopped $root $BootstrapPid
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    if ($state -and $state.product -ne 'T3') { throw 'Invalid installation identity.' }
    if ($state -and [version]$manifest.version -lt [version]$state.version) { throw 'Downgrade refused. Restore a backup with its matching version instead.' }
    $savedPort = if ($state -and $state.PSObject.Properties['port']) { [int]$state.port } else { 8765 }
    $savedTlsPort = if ($state -and $state.PSObject.Properties['tlsPort']) { [int]$state.tlsPort } else { 8766 }
    $savedName = if ($state -and $state.PSObject.Properties['instanceName']) { [string]$state.instanceName } else { '' }
    if (-not $PSBoundParameters.ContainsKey('Port')) { $Port = $savedPort }
    if (-not $PSBoundParameters.ContainsKey('TlsPort')) { $TlsPort = $savedTlsPort }
    if (-not $PSBoundParameters.ContainsKey('InstanceName')) { $InstanceName = $savedName }
    if ($Port -lt 1024 -or $Port -gt 65535 -or $TlsPort -lt 1024 -or $TlsPort -gt 65535 -or $Port -eq $TlsPort) { throw 'Choose two distinct ports between 1024 and 65535.' }
    if ($InstanceName -and $InstanceName -notmatch '^[\p{L}\p{N} _-]{1,24}$') { throw 'InstanceName must contain 1-24 letters, digits, spaces, underscores or hyphens.' }
    if ($state -and ($Port -ne $savedPort -or $TlsPort -ne $savedTlsPort -or $InstanceName -cne $savedName)) { throw 'Existing instance name and ports are fixed. Use a separate installation root for a new instance.' }
    $displayName = if ($InstanceName) { 'T3 ' + $InstanceName } else { 'T3' }
    $shortcutName = $displayName + '.lnk'
    if (-not $state) { Write-T3Json $statePath @{ product = 'T3'; version = '0.0.0'; currentDirectory = $null; dataDirectory = (Join-Path $root 'data'); port = $Port; tlsPort = $TlsPort; instanceName = $InstanceName; shortcutName = $shortcutName } }
    $data = Assert-T3Child (Join-Path $root 'data') $root
    $backup = $null
    if (Test-Path -LiteralPath $data) {
        Write-InstallStage 'Backing up existing data'
        Assert-T3Tree $data $root
        $backup = Assert-T3Child (Join-Path $root ('backups/pre-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))) $root
        Copy-Item -LiteralPath $data -Destination $backup -Recurse
        Write-Host "Full user-data backup: $backup"
    } elseif ($LegacyRoot) {
        $legacy = Get-T3FullPath $LegacyRoot
        Assert-T3Stopped $legacy
        if (-not (Test-Path -LiteralPath (Join-Path $legacy 'apps/server/src/http/server-cli.ts'))) { throw 'LegacyRoot must point to the old T3 folder.' }
        $legacyData = Assert-T3Child (Join-Path $legacy 'apps/server/.data') $legacy
        if (-not (Test-Path -LiteralPath $legacyData)) { throw 'Legacy default data directory is missing. Custom data paths must be migrated separately.' }
        Assert-T3Tree $legacyData $legacy
        Copy-Item -LiteralPath $legacyData -Destination $data -Recurse
        Write-Host 'Copied the legacy data folder; the original remains unchanged.'
    }
    $destination = Assert-T3Child (Join-Path $root ('versions/' + $manifest.version)) $root
    $manifestHash = (Get-FileHash -LiteralPath (Join-Path $source 'release-manifest.json')).Hash
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath (Join-Path $destination 'release-manifest.json')).Hash -ne $manifestHash) { throw 'This version already exists with different bytes. Increase the release version.' }
        $null = Read-T3Manifest $destination -Progress $verifyProgress
    } else {
        $stage = Assert-T3Child (Join-Path $root ('versions/.staging-' + [guid]::NewGuid().ToString('N').Substring(0,12))) $root
        New-Item -ItemType Directory -Force -Path $stage | Out-Null
        Write-InstallStage ('Copying program to ' + $stage)
        Copy-T3Payload $source $stage $manifest -Progress { param($Index, $Total, $Name); Write-InstallStage ("Copying $Index/$Total : $Name") }
        Write-InstallStage 'Checking copied program'
        $null = Read-T3Manifest $stage -Progress $verifyProgress
        Move-Item -LiteralPath $stage -Destination $destination
    }
    Write-InstallStage 'Committing installed version'
    Write-T3Json (Join-Path $destination 'installed.json') @{ dataDirectory = $data; installRoot = $root; port = $Port; tlsPort = $TlsPort; displayName = $displayName }
    # Only switch the current version after copy, integrity check and backup succeed.
    Write-T3Json $statePath @{ product = 'T3'; version = $manifest.version; currentDirectory = $destination; dataDirectory = $data; previousDirectory = $(if ($state) { $state.currentDirectory } else { $null }); preUpdateBackup = $backup; port = $Port; tlsPort = $TlsPort; instanceName = $InstanceName; shortcutName = $shortcutName }
    Write-InstallStage 'Updating installation entry points'
    Copy-Item -LiteralPath (Join-Path $destination 'Uninstall.cmd') -Destination $root -Force
    Copy-Item -LiteralPath (Join-Path $destination 'Uninstall.ps1') -Destination $root -Force
    Copy-Item -LiteralPath (Join-Path $destination 'WindowsPathPolicy.cs') -Destination $root -Force
    Copy-Item -LiteralPath (Join-Path $destination 'lifecycle.ps1') -Destination $root -Force
    # Stable per-instance entry: upgrades update installation.json, not the user's bookmark.
    Copy-Item -LiteralPath (Join-Path $destination 'Start.ps1') -Destination $root -Force
    Copy-Item -LiteralPath (Join-Path $destination 'Start.cmd') -Destination $root -Force
    foreach ($name in @('Diagnose.ps1', 'Diagnose.cmd', 'DIAGNOSE.zh.txt')) {
        if (Test-Path -LiteralPath (Join-Path $destination $name)) { Copy-Item -LiteralPath (Join-Path $destination $name) -Destination $root -Force }
    }
    if (-not $NoShortcut) {
        Write-InstallStage 'Creating desktop shortcut'
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName))
            $shortcut.TargetPath = Join-Path $destination 'T3.exe'
            $shortcut.WorkingDirectory = $destination
            $shortcut.Save()
        } catch { Write-InstallStage ('WARNING: shortcut could not be created; use T3.exe or Start.cmd. ' + $_.Exception.Message) }
    }
    Write-Host "Installed T3 $($manifest.version). Data: $data"
} finally { $lock.Dispose() }
if ($Start) { Write-InstallStage 'Starting installed T3'; Start-Process -FilePath (Join-Path $destination 'T3.exe') -WorkingDirectory $destination -WindowStyle Hidden }
Write-InstallStage 'Installation completed'
} catch {
    Write-InstallStage ('FAILED during ' + $script:installStage + ': ' + $_.Exception.Message)
    throw
} finally {
    if ($script:installLogPath) { Write-Host ('Installation log: ' + $script:installLogPath) }
}
