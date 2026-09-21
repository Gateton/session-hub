# session-hub installer for Windows.
#
#   irm https://raw.githubusercontent.com/<owner>/session-hub/main/install.ps1 | iex
#
# or, from a checkout:
#
#   .\install.ps1
#
# This script only finds Node and the hub itself. The questions (which agents you
# have, which ones to install into) are asked by install.mjs, so behaviour is the
# same as on Linux and macOS.
#
# Nothing here needs Administrator: it installs into your own user profile.

$ErrorActionPreference = 'Stop'

$minMajor = 22
$minMinor = 5

function Write-Say([string]$message) { Write-Host $message }
function Stop-Fail([string]$message) {
    Write-Error $message -ErrorAction Continue
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Stop-Fail @"
session-hub needs Node $minMajor.$minMinor or newer, and no 'node' was found on PATH.

Install it first, then run this again:
  winget install OpenJS.NodeJS.LTS
  # or: https://nodejs.org
"@
}

$nodeVersion = (& node -p "process.versions.node").Trim()
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt $minMajor -or ([int]$parts[0] -eq $minMajor -and [int]$parts[1] -lt $minMinor)) {
    Stop-Fail "session-hub needs Node $minMajor.$minMinor or newer and found $nodeVersion. It uses node:sqlite with FTS5, which ships inside Node."
}

# $PSScriptRoot is empty when the script is piped into Invoke-Expression, so a
# local checkout is only detectable when this file is run from disk.
$selfDir = $PSScriptRoot
$installer = $null
if ($env:SESSION_HUB_SOURCE -and (Test-Path (Join-Path $env:SESSION_HUB_SOURCE 'install.mjs'))) {
    $installer = Join-Path $env:SESSION_HUB_SOURCE 'install.mjs'
} elseif ($selfDir -and (Test-Path (Join-Path $selfDir 'install.mjs'))) {
    $installer = Join-Path $selfDir 'install.mjs'
}

if ($installer) {
    Write-Say "session-hub: node $nodeVersion found, running the installer"
    & node $installer @args
    exit $LASTEXITCODE
}

Write-Say "session-hub: node $nodeVersion found, fetching the repository"
if (-not $env:SESSION_HUB_REPO) {
    Stop-Fail @"
This one-liner needs to know where the repository is:

  `$env:SESSION_HUB_REPO='https://github.com/<owner>/session-hub'; irm <url>/install.ps1 | iex

or clone it yourself and run .\install.ps1 from inside the checkout.
"@
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Stop-Fail "git is required to fetch session-hub. Install it (winget install Git.Git), or clone the repository yourself and run .\install.ps1."
}

$target = if ($env:SESSION_HUB_DIR) { $env:SESSION_HUB_DIR } else { Join-Path $HOME '.session-hub\src' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null

if (Test-Path (Join-Path $target '.git')) {
    Write-Say "updating $target"
    git -C $target pull --ff-only
} else {
    Write-Say "cloning into $target"
    git clone --depth 1 $env:SESSION_HUB_REPO $target
}

& node (Join-Path $target 'install.mjs') @args
exit $LASTEXITCODE
