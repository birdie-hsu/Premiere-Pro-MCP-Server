# Canonical project bootstrap for the local-livestream-premiere skill.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VideoRoot,

    [string]$RepoRoot,

    [string]$HermesRoot = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'hermes' } else { '' }),

    [string]$FfmpegBin,

    [string]$FfprobeBin,

    [ValidatePattern('^[A-Za-z0-9._/-]+$')]
    [string]$AsrModel = 'Xenova/whisper-base.en',

    [switch]$Apply,

    [switch]$InstallPremiereCep
)

$ErrorActionPreference = 'Stop'

function Resolve-RequiredPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [ValidateSet('File', 'Directory')][string]$Type = 'File'
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "$Name is required."
    }
    $absolute = [System.IO.Path]::GetFullPath($Path)
    $pathType = if ($Type -eq 'Directory') { 'Container' } else { 'Leaf' }
    if (!(Test-Path -LiteralPath $absolute -PathType $pathType)) {
        throw "$Name was not found: $absolute"
    }
    if ([System.IO.Path]::GetPathRoot($absolute) -eq $absolute) {
        return $absolute
    }
    return $absolute.TrimEnd('\')
}

function ConvertTo-TomlBasicString {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    foreach ($character in $Value.ToCharArray()) {
        if ([int]$character -lt 0x20) {
            throw "$Name contains a control character and cannot be written to TOML."
        }
    }
    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    return '"' + $escaped + '"'
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Get-Item -LiteralPath $PSScriptRoot).Parent.Parent.Parent.Parent.FullName
}

$repo = Resolve-RequiredPath -Path $RepoRoot -Name 'RepoRoot' -Type Directory
$video = Resolve-RequiredPath -Path $VideoRoot -Name 'VideoRoot' -Type Directory
$hermes = Resolve-RequiredPath -Path $HermesRoot -Name 'HermesRoot' -Type Directory
$node = Resolve-RequiredPath -Path (Join-Path $hermes 'node\node.exe') -Name 'Hermes Node' -Type File
$entry = Resolve-RequiredPath -Path (Join-Path $repo 'src\index.js') -Name 'highlight_local entrypoint' -Type File
$nodeVersion = (& $node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Hermes Node exists but could not be executed.'
}
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) {
    throw "Node.js 22 or newer is required by video_context; Hermes Node is $nodeVersion."
}

if ([string]::IsNullOrWhiteSpace($FfmpegBin)) {
    $FfmpegBin = Join-Path $repo 'tools\bin\ffmpeg.exe'
}
if ([string]::IsNullOrWhiteSpace($FfprobeBin)) {
    $FfprobeBin = Join-Path $repo 'tools\bin\ffprobe.exe'
}
$ffmpeg = Resolve-RequiredPath -Path $FfmpegBin -Name 'FFmpeg' -Type File
$ffprobe = Resolve-RequiredPath -Path $FfprobeBin -Name 'FFprobe' -Type File
$ytdlp = Resolve-RequiredPath -Path (Join-Path $repo 'tools\bin\yt-dlp.exe') -Name 'yt-dlp' -Type File

$nodeModules = Join-Path $hermes 'node\node_modules'
$videoContextPackage = Resolve-RequiredPath -Path (Join-Path $nodeModules '@smallthinkingmachines\video-context-mcp') -Name 'video_context package' -Type Directory
$videoContextEntry = Resolve-RequiredPath -Path (Join-Path $videoContextPackage 'dist\index.js') -Name 'video_context entrypoint' -Type File
$videoContextPackageJson = Resolve-RequiredPath -Path (Join-Path $videoContextPackage 'package.json') -Name 'video_context package manifest' -Type File
$premierePackage = Resolve-RequiredPath -Path (Join-Path $nodeModules 'adobe-premiere-pro-mcp') -Name 'premiere_cep package' -Type Directory
$premiereEntry = Resolve-RequiredPath -Path (Join-Path $premierePackage 'dist\index.js') -Name 'premiere_cep entrypoint' -Type File
$premiereCli = Resolve-RequiredPath -Path (Join-Path $premierePackage 'dist\cli.js') -Name 'premiere_cep CLI' -Type File
$premiereInstallScript = Resolve-RequiredPath -Path (Join-Path $premierePackage 'scripts\install-windows.ps1') -Name 'premiere_cep Windows installer' -Type File
$premierePackageJson = Resolve-RequiredPath -Path (Join-Path $premierePackage 'package.json') -Name 'premiere_cep package manifest' -Type File
$transformersRuntime = Resolve-RequiredPath -Path (Join-Path $nodeModules '@smallthinkingmachines\video-context-mcp\vendor\transformers.node.min.mjs') -Name 'local Transformers runtime' -Type File
$videoContextVersion = (Get-Content -LiteralPath $videoContextPackageJson -Raw | ConvertFrom-Json).version
$premiereVersion = (Get-Content -LiteralPath $premierePackageJson -Raw | ConvertFrom-Json).version

$cacheRoot = Join-Path $repo '.cache'
$videoCache = Join-Path $cacheRoot 'video-context-mcp'
$highlightCache = Join-Path $cacheRoot 'highlight-mcp'
$asrCache = Join-Path $videoCache 'transformers'
if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw 'APPDATA is required to locate the per-user Adobe CEP extension directory.'
}
$tempRoot = if ([string]::IsNullOrWhiteSpace($env:TEMP)) { [System.IO.Path]::GetTempPath() } else { $env:TEMP }
$premiereTemp = [System.IO.Path]::GetFullPath((Join-Path $tempRoot 'premiere-mcp-bridge')).TrimEnd('\')
$premiereCepTarget = Join-Path $env:APPDATA 'Adobe\CEP\extensions\MCPBridgeCEP'
$premiereCepManifest = Join-Path $premiereCepTarget 'CSXS\manifest.xml'
$configPath = Join-Path $repo '.codex\config.toml'

if ($InstallPremiereCep -and !$Apply) {
    throw '-InstallPremiereCep requires -Apply because it changes the per-user Adobe CEP installation.'
}

$tomlNode = ConvertTo-TomlBasicString -Value $node -Name 'Hermes Node'
$tomlVideoContextEntry = ConvertTo-TomlBasicString -Value $videoContextEntry -Name 'video_context entrypoint'
$tomlPremiereEntry = ConvertTo-TomlBasicString -Value $premiereEntry -Name 'premiere_cep entrypoint'
$tomlHighlightEntry = ConvertTo-TomlBasicString -Value $entry -Name 'highlight_local entrypoint'
$tomlRepo = ConvertTo-TomlBasicString -Value $repo -Name 'RepoRoot'
$tomlFfmpeg = ConvertTo-TomlBasicString -Value $ffmpeg -Name 'FFmpeg'
$tomlFfprobe = ConvertTo-TomlBasicString -Value $ffprobe -Name 'FFprobe'
$tomlYtdlp = ConvertTo-TomlBasicString -Value $ytdlp -Name 'yt-dlp'
$tomlVideoCache = ConvertTo-TomlBasicString -Value $videoCache -Name 'video_context cache'
$tomlHighlightCache = ConvertTo-TomlBasicString -Value $highlightCache -Name 'highlight_local cache'
$tomlAsrCache = ConvertTo-TomlBasicString -Value $asrCache -Name 'ASR cache'
$tomlAsrModel = ConvertTo-TomlBasicString -Value $AsrModel -Name 'ASR model'
$tomlAllowedRoots = ConvertTo-TomlBasicString -Value "$repo;$video" -Name 'highlight allowlist'
$tomlTransformersRuntime = ConvertTo-TomlBasicString -Value $transformersRuntime -Name 'Transformers runtime'
$tomlPremiereTemp = ConvertTo-TomlBasicString -Value $premiereTemp -Name 'Premiere temp directory'

$managedBlock = @"
# BEGIN local-livestream-premiere managed MCP block
# Generated by .agents/skills/local-livestream-premiere/scripts/ensure-hermes-config.ps1

[mcp_servers.video_context]
command = $tomlNode
args = [$tomlVideoContextEntry]
cwd = $tomlRepo
startup_timeout_sec = 30
tool_timeout_sec = 900
default_tools_approval_mode = 'writes'

[mcp_servers.video_context.env]
VCM_TOOLCHAIN_MODE = 'system'
VCM_FFMPEG_BIN = $tomlFfmpeg
VCM_FFPROBE_BIN = $tomlFfprobe
VCM_YTDLP_BIN = $tomlYtdlp
VCM_CACHE_DIR = $tomlVideoCache
VCM_OCR_BACKEND = 'wasm'
VCM_ASR_BACKEND = 'transformers'
VCM_ASR_MODEL = $tomlAsrModel

[mcp_servers.highlight_local]
command = $tomlNode
args = [$tomlHighlightEntry]
cwd = $tomlRepo
startup_timeout_sec = 30
tool_timeout_sec = 3600
default_tools_approval_mode = 'writes'

[mcp_servers.highlight_local.env]
HIGHLIGHT_PROJECT_ROOT = $tomlRepo
HIGHLIGHT_ALLOWED_ROOTS = $tomlAllowedRoots
HIGHLIGHT_FFMPEG_BIN = $tomlFfmpeg
HIGHLIGHT_FFPROBE_BIN = $tomlFfprobe
HIGHLIGHT_CACHE_DIR = $tomlHighlightCache
HIGHLIGHT_ASR_MODE = 'auto'
HIGHLIGHT_ASR_MODEL = $tomlAsrModel
HIGHLIGHT_ASR_CACHE_DIR = $tomlAsrCache
HIGHLIGHT_TRANSFORMERS_RUNTIME = $tomlTransformersRuntime
HIGHLIGHT_MOTION_ENABLED = 'true'
HIGHLIGHT_MOTION_SAMPLE_RATE = '1'
HIGHLIGHT_MOTION_DIFF_THRESHOLD = '0.08'

[mcp_servers.premiere_cep]
command = $tomlNode
args = [$tomlPremiereEntry]
cwd = $tomlRepo
startup_timeout_sec = 30
tool_timeout_sec = 300
default_tools_approval_mode = 'writes'

[mcp_servers.premiere_cep.env]
PREMIERE_TEMP_DIR = $tomlPremiereTemp

# END local-livestream-premiere managed MCP block
"@.Trim()

function Remove-ManagedServerSections {
    param([string]$Text)

    $lines = $Text -split "`r?`n"
    $kept = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($line in $lines) {
        if ($line -match '^\s*\[mcp_servers\.(video_context|highlight_local|premiere_cep)(?:\.|\])') {
            $skip = $true
            continue
        }
        if ($skip -and $line -match '^\s*\[') {
            $skip = $false
        }
        if (!$skip) {
            [void]$kept.Add($line)
        }
    }
    return ($kept -join "`r`n").Trim()
}

$existing = ''
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $existing = Get-Content -LiteralPath $configPath -Raw
}
$withoutManaged = Remove-ManagedServerSections -Text $existing
$withoutManaged = [regex]::Replace($withoutManaged, '(?ms)^# BEGIN local-livestream-premiere managed MCP block\r?\n.*?^# END local-livestream-premiere managed MCP block\s*', '').Trim()
$finalConfig = if ($withoutManaged) { "$withoutManaged`r`n`r`n$managedBlock`r`n" } else { "$managedBlock`r`n" }

Write-Output "RepoRoot: $repo"
Write-Output "VideoRoot: $video"
Write-Output "Hermes config: $configPath"
Write-Output "Hermes Node: $nodeVersion"
Write-Output "MCP packages: video_context=$videoContextVersion, premiere_cep=$premiereVersion"
Write-Output "Premiere temp: $premiereTemp"
Write-Output "Premiere CEP: $(if (Test-Path -LiteralPath $premiereCepManifest -PathType Leaf) { "installed at $premiereCepTarget" } else { "missing at $premiereCepTarget" })"
Write-Output "Servers: video_context, highlight_local, premiere_cep"
Write-Output "Mode: $(if ($Apply) { 'apply' } else { 'preview' })"

if (!$Apply) {
    Write-Output 'Preview only. Re-run with -Apply to back up and write the project-scoped config.'
    if (!(Test-Path -LiteralPath $premiereCepManifest -PathType Leaf)) {
        Write-Output 'CEP extension is missing. After approval, re-run with -Apply -InstallPremiereCep.'
    }
    Write-Output $finalConfig
    exit 0
}

$configDirectory = Split-Path -Parent $configPath
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $premiereTemp -Force | Out-Null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $backupPath = "$configPath.bak-$stamp"
    Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
    Write-Output "Backup: $backupPath"
}

if ($InstallPremiereCep) {
    if (Test-Path -LiteralPath $premiereCepTarget -PathType Container) {
        $cepStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $cepBackupRoot = Join-Path $hermes 'backups\premiere-cep'
        New-Item -ItemType Directory -Path $cepBackupRoot -Force | Out-Null
        $cepBackupPath = Join-Path $cepBackupRoot "MCPBridgeCEP-$cepStamp"
        Copy-Item -LiteralPath $premiereCepTarget -Destination $cepBackupPath -Recurse
        Write-Output "CEP backup: $cepBackupPath"
    }

    $previousPath = $env:PATH
    try {
        $hermesNodeDirectory = Split-Path -Parent $node
        $env:PATH = "$hermesNodeDirectory;$previousPath"
        & $premiereInstallScript -TempDir $premiereTemp -SkipBuild -SkipCopilotConfig -SkipClaudeDesktopConfig
    } finally {
        $env:PATH = $previousPath
    }

    if (!(Test-Path -LiteralPath $premiereCepManifest -PathType Leaf)) {
        throw "Premiere CEP installer completed but the extension manifest is missing: $premiereCepManifest"
    }
    Write-Output "Installed Premiere CEP extension: $premiereCepTarget"
}

[System.IO.File]::WriteAllText($configPath, $finalConfig, [System.Text.UTF8Encoding]::new($false))
Write-Output "Wrote: $configPath"
Write-Output "Premiere doctor: & '$node' '$premiereCli' --doctor"
Write-Output 'Restart Hermes or start a new session, then run: hermes mcp list'
Write-Output "In Premiere, open Window > Extensions > MCP Bridge (CEP), set Temp Directory to '$premiereTemp', then click Save Configuration, Start Bridge, and Test Connection."
