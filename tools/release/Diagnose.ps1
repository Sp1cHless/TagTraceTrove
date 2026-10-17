[CmdletBinding()]
param([string]$Root, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$report = New-Object 'System.Collections.Generic.List[string]'
function Add-Line([string]$Text) { $report.Add($Text) }
function Redact([string]$Text) {
    $Text = $Text -replace '(?i)(Bearer\s+)[A-Za-z0-9_\-]+', '$1[redacted]'
    $Text = $Text -replace '(?i)(["'']?(?:token|password|cookie|authorization|secret)["'']?\s*[:=]\s*)[^\s,}]+', '$1[redacted]'
    return ($Text -replace '(?i)(["'']?code["'']?\s*[:=]\s*["'']?)[A-Za-z0-9_\-]{43}\b', '$1[redacted]')
}
function Section([string]$Name, [scriptblock]$Action) {
    Write-Host ('Checking: ' + $Name)
    Add-Line ''
    Add-Line ('--- ' + $Name + ' ---')
    try { & $Action } catch { Add-Line ('CHECK UNAVAILABLE: ' + $_.Exception.Message) }
}
function Read-Json([string]$Path) {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}
function Inside([string]$Child, [string]$Parent) {
    return $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Probe-Process([string]$Executable, [string]$Arguments, [string]$Directory) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'The process was not created.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'Probe timed out after 10 seconds (only this diagnostic child was stopped).'
        }
        $code = $process.ExitCode
        $hex = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$code), 0).ToString('X8')
        Add-Line ('exit: ' + $code + ' / 0x' + $hex)
        Add-Line (Redact (($stdout.Result + $stderr.Result).Trim()))
        if ($hex -eq 'C0000135') { Add-Line 'Missing native DLL/runtime dependency. This is a Windows loader error.' }
        if ($hex -eq 'C000007B') { Add-Line 'Invalid native image, commonly an architecture mismatch or damaged DLL.' }
        if ($hex -eq 'C000001D') { Add-Line 'Illegal CPU instruction. Check processor/runtime compatibility.' }
    } finally { $process.Dispose() }
}

Add-Line 'T3 independent Windows startup diagnostics'
Add-Line ('Captured: ' + [DateTimeOffset]::Now.ToString('o'))
Add-Line ('Requested folder: ' + $rootPath)
Add-Line 'No T3 launcher, installer, library service or database is started by this tool.'
Add-Line 'Only the bundled Node version and isolated in-memory module checks are executed.'
$programPath = $rootPath
$installationPath = $rootPath
$httpPort = 8765
$tlsPort = 8766

Section 'Windows and process architecture' {
    $windows = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    try { $caption = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption } catch { $caption = $windows.ProductName }
    Add-Line ('Windows: ' + $caption + ' / ' + $windows.DisplayVersion + ' / build ' + $windows.CurrentBuildNumber + '.' + $windows.UBR)
    Add-Line ('64-bit OS: ' + [Environment]::Is64BitOperatingSystem + '; 64-bit diagnostic process: ' + [Environment]::Is64BitProcess)
    Add-Line ('Processor: ' + $env:PROCESSOR_IDENTIFIER + '; architecture: ' + $env:PROCESSOR_ARCHITECTURE)
    Add-Line ('PowerShell: ' + $PSVersionTable.PSVersion)
    if (-not [Environment]::Is64BitOperatingSystem) { Add-Line 'UNSUPPORTED: T3 Windows releases contain x64 executables.' }
    if ([int]$windows.CurrentBuildNumber -lt 10240) { Add-Line 'UNSUPPORTED: this release requires Windows 10/11 x64.' }
    Add-Line ('TEMP: ' + [IO.Path]::GetTempPath())
    Add-Line ('DOTNET_BUNDLE_EXTRACT_BASE_DIR: ' + $env:DOTNET_BUNDLE_EXTRACT_BASE_DIR)
    Add-Line ('vcruntime140.dll in System32: ' + [IO.File]::Exists((Join-Path $env:WINDIR 'System32/vcruntime140.dll')))
    Add-Line ('ucrtbase.dll in System32: ' + [IO.File]::Exists((Join-Path $env:WINDIR 'System32/ucrtbase.dll')))
}
Section 'Temporary directory write access' {
    $probe = Join-Path ([IO.Path]::GetTempPath()) ('t3-diagnostic-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($probe, 'T3 temporary directory probe')
        Add-Line 'Temporary directory write: OK'
    } finally { if ([IO.File]::Exists($probe)) { [IO.File]::Delete($probe) } }
}
Section 'Installation record' {
    $statePath = Join-Path $rootPath 'installation.json'
    $profilePath = Join-Path $rootPath 'installed.json'
    if ([IO.File]::Exists($statePath)) {
        $state = Read-Json $statePath
        Add-Line ('Installed version: ' + $state.version)
        if ($state.product -ne 'T3' -or [string]::IsNullOrWhiteSpace($state.currentDirectory)) {
            throw 'Installation is incomplete or invalid: currentDirectory is empty. Run Install.cmd to see its error; keep existing data.'
        }
        $current = [IO.Path]::GetFullPath([string]$state.currentDirectory).TrimEnd('\')
        if (-not (Inside $current (Join-Path $rootPath 'versions'))) { throw 'Installation record points outside this installation versions folder.' }
        $script:programPath = $current
        if ($state.PSObject.Properties['port']) { $script:httpPort = [int]$state.port }
        if ($state.PSObject.Properties['tlsPort']) { $script:tlsPort = [int]$state.tlsPort }
    } elseif ([IO.File]::Exists($profilePath)) {
        $profile = Read-Json $profilePath
        $parent = [IO.Path]::GetFullPath([string]$profile.installRoot).TrimEnd('\')
        if (-not (Inside $rootPath (Join-Path $parent 'versions'))) { throw 'Invalid installed version root.' }
        $script:installationPath = $parent
        if ($profile.PSObject.Properties['port']) { $script:httpPort = [int]$profile.port }
        if ($profile.PSObject.Properties['tlsPort']) { $script:tlsPort = [int]$profile.tlsPort }
        Add-Line 'Running diagnostics from an installed version directory.'
    } else {
        Add-Line 'No installation record: this may be a freshly extracted release.'
    }
    Add-Line ('Program folder: ' + $programPath)
    Add-Line ('Installation folder: ' + $installationPath)
}
Section 'Requested launcher executable' {
    $exe = Join-Path $rootPath 'T3.exe'
    if (-not [IO.File]::Exists($exe)) { throw 'T3.exe is missing from the selected folder.' }
    Add-Line ('SHA256: ' + (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant())
    Add-Line ('File version: ' + [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileVersion)
    Add-Line ('Windows Authenticode: ' + (Get-AuthenticodeSignature -LiteralPath $exe).Status)
}
Section 'Required files and selected release hashes' {
    $manifestPath = Join-Path $programPath 'release-manifest.json'
    $manifest = if ([IO.File]::Exists($manifestPath)) { Read-Json $manifestPath } else { $null }
    if ($manifest) { Add-Line ('Release manifest version: ' + $manifest.version) }
    else { Add-Line 'Release manifest missing: incomplete extraction or wrong folder.' }
    foreach ($relative in @('T3.exe', 'Install.ps1', 'tools/node/node.exe', 'apps/server/node_modules/tsx/dist/cli.mjs', 'apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'apps/web/dist/index.html')) {
        $file = Join-Path $programPath $relative
        if (-not [IO.File]::Exists($file)) { Add-Line ('MISSING: ' + $relative); continue }
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        $expected = if ($manifest) { $manifest.files.PSObject.Properties[$relative] } else { $null }
        $status = if (-not $expected) { 'not in manifest' } elseif ($actual -eq [string]$expected.Value) { 'OK' } else { 'HASH MISMATCH' }
        Add-Line ($status + ': ' + $relative + ' / ' + $actual)
    }
    if ($manifest) {
        $missing = New-Object 'System.Collections.Generic.List[string]'
        $invalid = 0
        $maxLength = 0
        foreach ($entry in $manifest.files.PSObject.Properties) {
            $candidate = [IO.Path]::GetFullPath((Join-Path $programPath $entry.Name))
            if (-not (Inside $candidate $programPath)) { $invalid++; continue }
            $maxLength = [Math]::Max($maxLength, $candidate.Length)
            if (-not [IO.File]::Exists($candidate)) { $missing.Add($entry.Name) }
        }
        Add-Line ('Manifest files: ' + @($manifest.files.PSObject.Properties).Count + '; missing: ' + $missing.Count + '; invalid paths: ' + $invalid + '; longest path: ' + $maxLength)
        foreach ($name in $missing | Select-Object -First 80) { Add-Line ('Missing manifest file: ' + $name) }
    }
}
Section 'Original installer preflight (read-only)' {
    $helper = Join-Path $programPath 'lifecycle.ps1'
    if (-not [IO.File]::Exists($helper)) { throw 'Installer helper lifecycle.ps1 is missing.' }
    # Load functions only, not Install.ps1. Reuse the exact shipped guards.
    . $helper
    Write-Host 'Verifying every release file hash and path. This can take time on a slow disk.'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $verified = Read-T3Manifest $programPath
    $timer.Stop()
    Add-Line ('Original installer package check: PASS / ' + @($verified.files.PSObject.Properties).Count + ' files / ' + [Math]::Round($timer.Elapsed.TotalSeconds, 2) + ' seconds')
    foreach ($file in $verified.files.PSObject.Properties) {
        $candidate = Join-Path (Join-Path $installationPath 'versions/.staging-xxxxxxxxxxxx') $file.Name
        if ($candidate.Length -gt 259 -or ([IO.Path]::GetDirectoryName($candidate)).Length -gt 247) {
            throw 'The installation path is too long for Windows file operations. Choose a shorter directory; no installation was attempted.'
        }
    }
    Add-Line 'Original installer destination path budget: PASS'
    Write-Host 'Checking WMI/process ownership. No process will be stopped.'
    Assert-T3Stopped $installationPath
    Add-Line 'Original installer process/WMI check: PASS'
    $desktop = [Environment]::GetFolderPath('Desktop')
    Add-Line ('Desktop shortcut folder: ' + $desktop + '; exists: ' + [IO.Directory]::Exists($desktop))
    $null = New-Object -ComObject WScript.Shell
    Add-Line 'Desktop shortcut COM object: available (no shortcut was written).'
}
Section 'Download blocking metadata' {
    $paths = @((Join-Path $rootPath 'T3.exe'), (Join-Path $programPath 'T3.exe'), (Join-Path $programPath 'tools/node/node.exe'), (Join-Path $programPath 'Install.ps1')) | Select-Object -Unique
    foreach ($path in $paths) {
        if (-not [IO.File]::Exists($path)) { continue }
        $zone = Get-Content -LiteralPath $path -Stream Zone.Identifier -ErrorAction SilentlyContinue
        Add-Line ($path + ': ' + $(if ($zone) { ($zone | Where-Object { $_ -match '^ZoneId=' }) -join '; ' } else { 'no Zone.Identifier' }))
    }
    Add-Line 'A download marker is not proof of blocking. Check any Windows Security/SmartScreen prompt.'
}
Section 'Bundled Node executable' {
    $node = Join-Path $programPath 'tools/node/node.exe'
    if (-not [IO.File]::Exists($node)) { throw 'Bundled node.exe is missing.' }
    Probe-Process $node '--version' $programPath
}
Section 'Native dependency (in-memory only)' {
    $node = Join-Path $programPath 'tools/node/node.exe'
    $server = Join-Path $programPath 'apps/server'
    if (-not [IO.File]::Exists($node) -or -not [IO.Directory]::Exists($server)) { throw 'Bundled Node/server folder is missing.' }
    Probe-Process $node '-e "const D=require(''better-sqlite3'');const d=new D('':memory:'');console.log(''isolated native module OK'',d.prepare(''select 1 as value'').get().value);d.close()"' $server
}
Section 'Instance listening ports' {
    if ($httpPort -lt 1024 -or $httpPort -gt 65535 -or $tlsPort -lt 1024 -or $tlsPort -gt 65535) { throw 'Invalid ports in the installation record.' }
    foreach ($port in @($httpPort, $tlsPort)) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if (-not $listeners.Count) { Add-Line ('Port ' + $port + ': no listener'); continue }
        foreach ($listener in $listeners) {
            $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            Add-Line ('Port ' + $port + ': listening / PID ' + $listener.OwningProcess + ' / ' + $owner.ProcessName)
        }
    }
}
Section 'Recent Windows crash/side-by-side records (T3/Node only)' {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000,1001,1026,33; StartTime = (Get-Date).AddDays(-3) } -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match '(?i)T3(?:Launcher)?\.exe|T3Launcher|better_sqlite3|node\.exe' } | Select-Object -First 12)
    if (-not $events.Count) { Add-Line 'No matching readable events in the last 3 days. This does not rule out OS blocking.' }
    foreach ($event in $events) { Add-Line ($event.TimeCreated.ToString('o') + ' / ' + $event.ProviderName + ' / ' + $event.Id); Add-Line (Redact $event.Message) }
}
Section 'Recent Windows security records (T3 path only)' {
    foreach ($log in @('Microsoft-Windows-Windows Defender/Operational', 'Microsoft-Windows-CodeIntegrity/Operational')) {
        try {
            $events = @(Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = (Get-Date).AddDays(-3) } -MaxEvents 100 -ErrorAction Stop | Where-Object { $_.Message -match '(?i)TagTraceTrove|T3(?:Launcher)?\.exe' } | Select-Object -First 8)
            Add-Line ($log + ': matching events ' + $events.Count)
            foreach ($event in $events) { Add-Line ($event.TimeCreated.ToString('o') + ' / ' + $event.Id); Add-Line (Redact $event.Message) }
        } catch { Add-Line ($log + ': unavailable / ' + $_.Exception.Message) }
    }
}
Section 'Existing launcher/server log tails' {
    $paths = @((Join-Path $programPath 't3-server.log'), (Join-Path $programPath 't3-startup.log'), (Join-Path $installationPath 't3-startup.log'), (Join-Path $rootPath 't3-install.log')) | Select-Object -Unique
    foreach ($path in $paths) {
        Add-Line ('Log: ' + $path)
        if ([IO.File]::Exists($path)) { Add-Line (Redact ((Get-Content -LiteralPath $path -Tail 160 -Encoding UTF8 -ErrorAction Stop) -join [Environment]::NewLine)) }
        else { Add-Line 'No existing log. An EXE/installation failure before server startup may produce none.' }
    }
}
Add-Line ''
Add-Line 'Send this report with the visible error (if any). Keep your current data and pairing.'
Add-Line 'This tool does not unblock files, install runtimes, change firewall rules or repair an installation.'
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $name = 'T3-startup-diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt'
    $destinations = @($rootPath, [Environment]::GetFolderPath('Desktop'), [IO.Path]::GetTempPath()) | Where-Object { $_ }
} else {
    $name = [IO.Path]::GetFileName($OutputPath)
    $destinations = @([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath)))
}
$saved = $null
foreach ($directory in $destinations) {
    try {
        $candidate = Join-Path $directory $name
        if ([IO.File]::Exists($candidate)) { throw 'Report destination already exists; choose another path.' }
        [IO.File]::WriteAllLines($candidate, $report.ToArray(), (New-Object Text.UTF8Encoding($true)))
        $saved = $candidate
        break
    } catch { Write-Host ('Cannot save report there: ' + $_.Exception.Message) }
}
if (-not $saved) { $report | ForEach-Object { Write-Host $_ }; throw 'Could not save a report; copy the console output.' }
Write-Host ''
Write-Host ('REPORT SAVED: ' + $saved)
Write-Host 'Send this text file. T3 itself was not started.'
