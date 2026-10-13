function Get-T3ReleaseVersionPlan([string]$ConfigPath, [string]$ReleaseRoot, [switch]$KeepVersion) {
    $originalBytes = [IO.File]::ReadAllBytes($ConfigPath)
    $config = [Text.Encoding]::UTF8.GetString($originalBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($config.version -notmatch '^\d+\.\d+\.\d+$' -or $config.androidVersionCode -lt 100) { throw 'Invalid release.json version.' }
    $baseline = [version]$config.version
    $highestCode = [long]$config.androidVersionCode
    $publishedVersion = $null
    $publishedCode = 0L
    if (Test-Path -LiteralPath $ReleaseRoot) {
        foreach ($directory in Get-ChildItem -LiteralPath $ReleaseRoot -Directory) {
            $metadataPath = Join-Path $directory.FullName 'release.json'
            if (-not (Test-Path -LiteralPath $metadataPath)) { continue }
            $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($metadata.version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid prior release version: $metadataPath" }
            $version = [version]$metadata.version
            if ($null -eq $publishedVersion -or $version -gt $publishedVersion) { $publishedVersion = $version }
            $publishedCode = [Math]::Max($publishedCode, [long]$metadata.androidVersionCode)
            if ($version -gt $baseline) { $baseline = $version }
            $highestCode = [Math]::Max($highestCode, [long]$metadata.androidVersionCode)
        }
    }
    if ($KeepVersion) {
        if (($null -ne $publishedVersion -and [version]$config.version -le $publishedVersion) -or
            [long]$config.androidVersionCode -le $publishedCode) {
            throw 'KeepVersion requires a new version and Android versionCode above prior releases.'
        }
    } else {
        $patch = [long]$baseline.Build + 1
        do {
            if ($patch -gt [int]::MaxValue) { throw 'Release patch version overflow.' }
            $nextVersion = '{0}.{1}.{2}' -f $baseline.Major, $baseline.Minor, $patch
            $patch++
        } while (Test-Path -LiteralPath (Join-Path $ReleaseRoot $nextVersion))
        if ($highestCode -ge [int]::MaxValue) { throw 'Android versionCode overflow.' }
        $config.version = $nextVersion
        $config.androidVersionCode = [int]($highestCode + 1)
    }
    return [pscustomobject]@{ Config = $config; OriginalBytes = $originalBytes }
}

function Save-T3ReleaseVersionPlan([string]$ConfigPath, [string]$ReleaseRoot, $Plan) {
    $current = [IO.File]::ReadAllBytes($ConfigPath)
    if ([Convert]::ToBase64String($current) -ne [Convert]::ToBase64String($Plan.OriginalBytes)) {
        throw 'release.json changed while preparing the build; retry from the updated configuration.'
    }
    $temporary = Join-Path $ReleaseRoot ('.release-config-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = Join-Path $ReleaseRoot 'release-config.previous.json'
    try {
        [IO.File]::WriteAllText($temporary, ($Plan.Config | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($temporary, $ConfigPath, $backup)
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}
