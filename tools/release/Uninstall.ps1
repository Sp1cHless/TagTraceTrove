[CmdletBinding()]
param([string]$InstallRoot, [switch]$DeleteData)
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
if (-not $InstallRoot) {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installed.json')) {
        $InstallRoot = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installed.json') -Raw -Encoding UTF8 | ConvertFrom-Json).installRoot
    } elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json')) { $InstallRoot = $PSScriptRoot }
    else { throw 'Run Uninstall from an installed T3 directory or specify -InstallRoot.' }
}
$root = Get-T3FullPath $InstallRoot
$statePath = Join-Path $root 'installation.json'
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($state.product -ne 'T3' -or (Get-T3FullPath $state.dataDirectory) -ne (Join-Path $root 'data')) { throw 'Not a managed T3 installation.' }
$lock = [IO.File]::Open((Join-Path $root '.maintenance.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    Assert-T3Stopped $root
    # A shell launched inside versions/ must release its directory handle before deletion.
    [Environment]::CurrentDirectory = $root
    Set-Location -LiteralPath $root
    if ($DeleteData -and (Read-Host 'Delete ALL library data and backups? Type DELETE T3 DATA') -cne 'DELETE T3 DATA') { throw 'Data deletion cancelled.' }
    $shortcutName = if ($state.PSObject.Properties['shortcutName']) { [string]$state.shortcutName } else { 'T3.lnk' }
    if ($shortcutName -notmatch '^T3[\p{L}\p{N} _-]*\.lnk$') { throw 'Invalid instance shortcut name.' }
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName
    if (Test-Path -LiteralPath $shortcutPath) {
        $shell = New-Object -ComObject WScript.Shell
        if ($shell.CreateShortcut($shortcutPath).TargetPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $shortcutPath }
    }
    $versions = Assert-T3Child (Join-Path $root 'versions') $root
    if (Test-Path -LiteralPath $versions) { Assert-T3Tree $versions $root; Remove-Item -LiteralPath $versions -Recurse -Force }
    if ($DeleteData) {
        foreach ($name in @('data', 'backups')) {
            $path = Assert-T3Child (Join-Path $root $name) $root
            if (Test-Path -LiteralPath $path) { Assert-T3Tree $path $root; Remove-Item -LiteralPath $path -Recurse -Force }
        }
    }
    # Keep the management marker so reinstall can recognize retained data.
    Write-Host "Program removed. Retained data/backups: $root (unless DeleteData was selected)."
} finally { $lock.Dispose() }
