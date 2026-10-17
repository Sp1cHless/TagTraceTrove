param([string]$Installer, [string]$Destination, [string]$Mode, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ mode=$Mode; failed=$false; error=''; stack=''; version=$null; current=$null }
if ($Mode -eq 'shortcut-denied') { function New-Object { param([string]$ComObject); throw 'SIMULATED: shortcut denied' } }
if ($Mode -eq 'copy-failure') {
    $env:T3_TEST_COPY_DESTINATION = $Destination
    function Write-Host {
        param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Object)
        $text = $Object -join ' '
        Microsoft.PowerShell.Utility\Write-Host $text
        if ($text -match '^\[\d{2}:\d{2}:\d{2}\] Copying program to (.+)$') {
            $stage = [IO.Path]::GetFullPath($Matches[1])
            if (-not $stage.StartsWith([IO.Path]::GetFullPath($env:T3_TEST_COPY_DESTINATION) + '\versions\.staging-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture stage escaped destination.' }
            [IO.File]::WriteAllText((Join-Path $stage 'T3.exe'), 'forced destination collision')
        }
    }
}
try {
    if ($Mode -eq 'shortcut-denied') { & $Installer -InstallRoot $Destination }
    else { & $Installer -InstallRoot $Destination -NoShortcut }
} catch { $result.failed=$true; $result.error=$_.Exception.Message; $result.stack=$_.ScriptStackTrace }
$state = Join-Path $Destination 'installation.json'
if ([IO.File]::Exists($state)) {
    $record = Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json
    $result.version = $record.version
    $result.current = $record.currentDirectory
}
[IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
