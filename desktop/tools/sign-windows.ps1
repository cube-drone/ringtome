# Sign one Windows artifact with Azure Artifact Signing (SIGNING.md, section 2).
#
# Tauri calls this once per file it would sign - the app's .exe before it is wrapped, then each
# installer - through `bundle.windows.signCommand` in tauri.windows.conf.json, with the file's
# path as the one argument. The bundler runs it from the `desktop/` directory, which is why the
# config names this file by a relative path.
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

if (-not $env:RINGTOME_SIGN_METADATA) {
    Write-Host "unsigned: no Azure Artifact Signing configured for this build ($File)"
    exit 0
}

foreach ($needed in @("RINGTOME_SIGNTOOL", "RINGTOME_SIGN_DLIB")) {
    if (-not (Get-Item "env:$needed" -ErrorAction SilentlyContinue).Value) {
        Write-Error "$needed is not set; the 'Azure signing tools' workflow step sets it"
        exit 1
    }
}
if (-not (Test-Path $File)) {
    Write-Error "nothing to sign at $File"
    exit 1
}

Write-Host "signing $File"
& $env:RINGTOME_SIGNTOOL sign /v /fd SHA256 `
    /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
    /dlib $env:RINGTOME_SIGN_DLIB /dmdf $env:RINGTOME_SIGN_METADATA `
    $File
if ($LASTEXITCODE -ne 0) {
    Write-Error "signtool sign failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

# Verify against the Windows trust chain, the same check the user's machine will make - a
# signature that signtool wrote but Windows won't honour (a region mismatch, a stale timestamp
# authority) is caught here rather than by the first person to download it.
& $env:RINGTOME_SIGNTOOL verify /pa /v $File
if ($LASTEXITCODE -ne 0) {
    Write-Error "signtool verify failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
