$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsArchitecture
whoami /all

foreach ($command in @("docker", "wsl", "wslconfig", "qemu-system-x86_64")) {
    $resolved = Get-Command $command -ErrorAction SilentlyContinue
    Write-Host "$command=$($resolved.Source)"
}

foreach ($feature in @("Containers", "Microsoft-Hyper-V-All", "VirtualMachinePlatform", "Microsoft-Windows-Subsystem-Linux", "Containers-DisposableClientVM")) {
    try {
        $state = (Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction Stop).State
        Write-Host "feature:$feature=$state"
    } catch {
        Write-Host "feature:$feature=unavailable ($($_.Exception.Message))"
    }
}

try {
    docker version
} catch {
    Write-Host "docker-version=failed ($($_.Exception.Message))"
}
try {
    wsl --status
} catch {
    Write-Host "wsl-status=failed ($($_.Exception.Message))"
}

$probeUser = "pi_probe_$($env:GITHUB_RUN_ID)_$($env:GITHUB_RUN_ATTEMPT)"
$passwordText = "Aa1!$([Guid]::NewGuid().ToString('N'))"
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$credential = [pscredential]::new("$env:COMPUTERNAME\$probeUser", $password)
$workspace = Join-Path $env:RUNNER_TEMP "pi-windows-probe-workspace"
$sentinelDir = Join-Path $env:RUNNER_TEMP "pi-windows-probe-host-only"
$sentinel = Join-Path $sentinelDir "sentinel.txt"
$childScript = Join-Path $workspace "probe-child.ps1"
$stdoutPath = Join-Path $workspace "stdout.txt"
$stderrPath = Join-Path $workspace "stderr.txt"
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$probePrincipal = "$env:COMPUTERNAME\$probeUser"
$systemPrincipal = "*S-1-5-18"

try {
    New-LocalUser -Name $probeUser -Password $password -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    $usersGroup = ([System.Security.Principal.SecurityIdentifier]"S-1-5-32-545").Translate([System.Security.Principal.NTAccount]).Value.Split("\")[-1]
    Add-LocalGroupMember -Group $usersGroup -Member $probeUser

    New-Item -ItemType Directory -Force -Path $workspace, $sentinelDir | Out-Null
    Set-Content -Path (Join-Path $workspace "visible.txt") -Value "workspace-visible"
    Set-Content -Path $sentinel -Value "host-inaccessible"

    & icacls.exe $workspace /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" "${probePrincipal}:(OI)(CI)M" "${systemPrincipal}:(OI)(CI)F"
    if ($LASTEXITCODE -ne 0) { throw "Could not set workspace ACL" }
    & icacls.exe $sentinelDir /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" "${systemPrincipal}:(OI)(CI)F"
    if ($LASTEXITCODE -ne 0) { throw "Could not set sentinel ACL" }

    @'
param(
    [string]$Workspace,
    [string]$Sentinel,
    [string]$CommandFile
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Get-Content (Join-Path $Workspace "visible.txt")

$sentinelReadable = $false
try {
    Get-Content $Sentinel | Out-Null
    $sentinelReadable = $true
} catch [System.UnauthorizedAccessException] {
    Write-Host "host-sentinel=denied"
}
if ($sentinelReadable) {
    Write-Error "restricted user read the host sentinel"
    exit 20
}

$leaked = @(@("GH_TOKEN", "GITHUB_TOKEN", "PI_AUTH_JSON", "PI_CODING_AGENT_DIR", "ACTIONS_RUNTIME_TOKEN", "GITHUB_ENV", "GITHUB_PATH") |
    Where-Object { [Environment]::GetEnvironmentVariable($_) })
if ($leaked.Count -gt 0) {
    Write-Error "inherited-sensitive-environment=$($leaked -join ',')"
    exit 21
}
Write-Host "sensitive-environment=absent"

$commandFileWritable = $false
try {
    $stream = [System.IO.File]::Open($CommandFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $stream.Dispose()
    $commandFileWritable = $true
} catch [System.UnauthorizedAccessException] {
    Write-Host "github-env-write=denied"
}
if ($commandFileWritable) {
    Write-Error "restricted user can write GITHUB_ENV"
    exit 22
}
'@ | Set-Content -Path $childScript

    $arguments = @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$childScript`"",
        "-Workspace", "`"$workspace`"",
        "-Sentinel", "`"$sentinel`"",
        "-CommandFile", "`"$env:GITHUB_ENV`""
    )
    $process = Start-Process -FilePath "powershell.exe" -Credential $credential -UseNewEnvironment -WorkingDirectory $workspace -ArgumentList $arguments -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    Get-Content $stdoutPath
    if (Test-Path $stderrPath) { Get-Content $stderrPath }
    if ($process.ExitCode -ne 0) {
        throw "Restricted-user probe exited with $($process.ExitCode)"
    }
} finally {
    Remove-LocalUser -Name $probeUser -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $workspace, $sentinelDir -ErrorAction SilentlyContinue
}
