# Sign one Windows artifact with Azure Artifact Signing (SIGNING.md, section 2).
#
# Tauri calls this once per file it would sign - the app's .exe before it is wrapped, then each
# installer - as `bundle.windows.signCommand`, with the file's path as the one argument. The
# command is configured by the release workflow (`--config`, written by its "Azure signing
# tools" step) rather than by a file in this directory, because the bundler runs it from
# whatever the process's working directory is and only an absolute path to this script is safe
# (2026-09-23, the first signed Windows run: a relative path was "failed to run powershell").
#
# The signing itself is Microsoft's own `signtool` with the Artifact Signing dlib plugged in
# (learn.microsoft.com, "Set up SignTool to use Artifact Signing"). The dlib authenticates by
# DefaultAzureCredential, and on the runner the credential that succeeds is the Azure CLI's -
# `azure/login` has already signed in with the workflow's OIDC token, so there is no secret
# anywhere in this: no client secret, no certificate file, nothing to rotate. The certificate
# lives at Microsoft and is valid for three days, which is why the timestamp is not optional.
#
# Degrades rather than fails: with no metadata file in the environment (a build outside the
# release workflow, or one where the Azure variables are not set yet) the file is left unsigned
# and the log says so, the same posture the Mac build takes without Apple credentials.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$File
)

$ErrorActionPreference = "Stop"

# Everything this script says also goes to a transcript, because the bundler that calls it
# reports any failure as `failed to run powershell` and shows the output only when asked
# (--verbose); the workflow prints the transcript on failure.
$transcript = if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP "sign-windows.log" } else { $null }
function Say([string]$line) {
    Write-Host $line
    if ($transcript) { Add-Content -Path $transcript -Value $line }
}
Say "sign-windows.ps1: file=$File cwd=$(Get-Location) script=$PSCommandPath"

if (-not $env:RINGTOME_SIGN_METADATA) {
    Say "unsigned: no Azure Artifact Signing configured for this build ($File)"
    exit 0
}

foreach ($needed in @("RINGTOME_SIGNTOOL", "RINGTOME_SIGN_DLIB")) {
    if (-not (Get-Item "env:$needed" -ErrorAction SilentlyContinue).Value) {
        Say "$needed is not set; the 'Azure signing tools' workflow step sets it"
        exit 1
    }
}
if (-not (Test-Path $File)) {
    Say "nothing to sign at $File"
    exit 1
}
foreach ($tool in @($env:RINGTOME_SIGNTOOL, $env:RINGTOME_SIGN_DLIB, $env:RINGTOME_SIGN_METADATA)) {
    if (-not (Test-Path $tool)) {
        Say "missing: $tool"
        exit 1
    }
}

# Native commands write to stderr freely and `$ErrorActionPreference = Stop` would turn the
# first such line into a terminating error before signtool has said what went wrong - so the
# two calls below run with it relaxed, and their exit codes are the verdict.
$ErrorActionPreference = "Continue"
Say "signing $File"
$out = & $env:RINGTOME_SIGNTOOL sign /v /debug /fd SHA256 `
    /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
    /dlib $env:RINGTOME_SIGN_DLIB /dmdf $env:RINGTOME_SIGN_METADATA `
    $File 2>&1
$out | ForEach-Object { Say "  $_" }
if ($LASTEXITCODE -ne 0) {
    Say "signtool sign failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

# Verify against the Windows trust chain, the same check the user's machine will make - a
# signature that signtool wrote but Windows won't honour (a region mismatch, a stale timestamp
# authority) is caught here rather than by the first person to download it.
$out = & $env:RINGTOME_SIGNTOOL verify /pa /v $File 2>&1
$out | ForEach-Object { Say "  $_" }
if ($LASTEXITCODE -ne 0) {
    Say "signtool verify failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
Say "signed and verified: $File"
