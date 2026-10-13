[CmdletBinding()]
param([switch]$Stop, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$state = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$current = [IO.Path]::GetFullPath($state.currentDirectory)
if ($state.product -ne 'T3' -or -not $current.StartsWith($root + '\versions\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid T3 installation.' }
$arguments = @()
if ($Stop) { $arguments += '--exit' }
if ($NoBrowser) { $arguments += '--no-browser' }
if ($arguments.Count) { Start-Process -FilePath (Join-Path $current 'T3.exe') -ArgumentList $arguments -WorkingDirectory $current -WindowStyle Hidden }
else { Start-Process -FilePath (Join-Path $current 'T3.exe') -WorkingDirectory $current -WindowStyle Hidden }
