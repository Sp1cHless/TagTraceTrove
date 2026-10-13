$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
. (Join-Path $repo 'tools/release/version.ps1')
function Assert-Equal($Actual, $Expected) { if ($Actual -ne $Expected) { throw "Expected $Expected, got $Actual" } }
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expected version operation to be rejected.' }
}
$workspace = Join-Path $repo ('.hermes/tmp/release-version-check-' + [guid]::NewGuid().ToString('N'))
$releases = Join-Path $workspace '.releases'
$configPath = Join-Path $workspace 'release.json'
New-Item -ItemType Directory -Force -Path $releases | Out-Null
try {
    $config = [ordered]@{ version = '1.0.5'; androidVersionCode = 105; androidApplicationId = 'unchanged-id'; androidSignerSha256 = 'unchanged-signer' }
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json))
    $prior = Join-Path $releases '1.0.5'
    New-Item -ItemType Directory -Path $prior | Out-Null
    [IO.File]::WriteAllText((Join-Path $prior 'release.json'), ($config | ConvertTo-Json))
    $plan = Get-T3ReleaseVersionPlan $configPath $releases
    Assert-Equal $plan.Config.version '1.0.6'
    Assert-Equal $plan.Config.androidVersionCode 106
    Save-T3ReleaseVersionPlan $configPath $releases $plan
    $saved = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Assert-Equal $saved.androidApplicationId 'unchanged-id'
    Assert-Equal $saved.androidSignerSha256 'unchanged-signer'
    Assert-Equal ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $releases 'release-config.previous.json')))) ([Convert]::ToBase64String($plan.OriginalBytes))
    New-Item -ItemType Directory -Path (Join-Path $releases '1.0.6') | Out-Null
    $retry = Get-T3ReleaseVersionPlan $configPath $releases
    Assert-Equal $retry.Config.version '1.0.7'
    Assert-Equal $retry.Config.androidVersionCode 107
    $ahead = Join-Path $releases '1.0.9'
    New-Item -ItemType Directory -Path $ahead | Out-Null
    [IO.File]::WriteAllText((Join-Path $ahead 'release.json'), '{"version":"1.0.9","androidVersionCode":450}')
    New-Item -ItemType Directory -Path (Join-Path $releases '1.0.10') | Out-Null
    $aheadPlan = Get-T3ReleaseVersionPlan $configPath $releases
    Assert-Equal $aheadPlan.Config.version '1.0.11'
    Assert-Equal $aheadPlan.Config.androidVersionCode 451
    Assert-Rejected { Get-T3ReleaseVersionPlan $configPath $releases -KeepVersion }
    $config.version = '2.0.0'; $config.androidVersionCode = 500
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json))
    $explicit = Get-T3ReleaseVersionPlan $configPath $releases -KeepVersion
    Assert-Equal $explicit.Config.version '2.0.0'
    Assert-Equal $explicit.Config.androidVersionCode 500
    $stale = Get-T3ReleaseVersionPlan $configPath $releases
    [IO.File]::AppendAllText($configPath, [Environment]::NewLine)
    Assert-Rejected { Save-T3ReleaseVersionPlan $configPath $releases $stale }
    foreach ($path in @('tools/release/version.ps1', 'tools/release/release.ps1')) {
        $parseErrors = $null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $repo $path), [ref]$null, [ref]$parseErrors)
        Assert-Equal @($parseErrors).Count 0
    }
    Write-Host 'Release versioning check passed: automatic increment, failed-directory retry, monotonic versions/codes, identity retention, recovery copy, explicit version and stale-config rejection.'
} finally {
    $allowedRoot = [IO.Path]::GetFullPath((Join-Path $repo '.hermes/tmp')).TrimEnd('\')
    $resolved = [IO.Path]::GetFullPath($workspace)
    if (-not $resolved.StartsWith($allowedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected test workspace path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
