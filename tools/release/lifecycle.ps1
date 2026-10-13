$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-T3FullPath([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Assert-T3Child([string]$Path, [string]$Parent) {
    $full = Get-T3FullPath $Path
    $root = Get-T3FullPath $Parent
    if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside expected directory: $full" }
    # Never follow a junction when moving/deleting installation files.
    $current = $full
    while ($current.Length -ge $root.Length) {
        if (([IO.Directory]::Exists($current) -or [IO.File]::Exists($current)) -and ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse point is not allowed: $current" }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $full
}
function Assert-T3Stopped([string]$Root, [int]$BootstrapPid = 0) {
    if ($BootstrapPid) {
        $bootstrap = Get-Process -Id $BootstrapPid -ErrorAction Stop
        if (-not $bootstrap.Path.Equals((Join-Path $Root 'T3.exe'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid bootstrap process.' }
    }
    foreach ($process in Get-CimInstance Win32_Process) {
        if ($BootstrapPid -and $process.ProcessId -eq $BootstrapPid) { continue }
        if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) -or
            ($process.Name -eq 'node.exe' -and $process.CommandLine -and $process.CommandLine.IndexOf($Root + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            throw 'T3 is running. Exit it from the tray before installing, updating or uninstalling.'
        }
    }
}
function Assert-T3Tree([string]$Path, [string]$Parent) {
    $null = Assert-T3Child $Path $Parent
    foreach ($item in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected file in managed tree: $($item.FullName)" }
    }
}
function Read-T3Manifest([string]$Source) {
    $manifest = Get-Content -LiteralPath (Join-Path $Source 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.product -ne 'T3' -or $manifest.platform -ne 'win-x64' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid T3 release manifest.' }
    foreach ($file in $manifest.files.PSObject.Properties) {
        $path = Assert-T3Child (Join-Path $Source $file.Name) $Source
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Value) { throw "Release file is missing or damaged: $($file.Name)" }
    }
    return $manifest
}
function Copy-T3Payload([string]$Source, [string]$Destination, $Manifest) {
    foreach ($file in $Manifest.files.PSObject.Properties) {
        $from = Assert-T3Child (Join-Path $Source $file.Name) $Source
        $to = Assert-T3Child (Join-Path $Destination $file.Name) $Destination
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
        [IO.File]::Copy($from, $to, $false)
    }
    Copy-Item -LiteralPath (Join-Path $Source 'release-manifest.json') -Destination $Destination
}
function Write-T3Json([string]$Path, $Value) {
    $temporary = $Path + '.new'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, ($Path + '.previous')) }
    else { [IO.File]::Move($temporary, $Path) }
}
