# Runs one bash command as the standard test user that this action created:
# a normal user, as the app runs on a user's machine and sean-pc tests it.
#
#   pwsh -File run-as-test-user.ps1 '<bash command>'
#
# The command runs in Git Bash, the way GitHub Actions runs a `shell: bash`
# step, in the current directory, with this step's environment except that its
# profile folders are the test user's. Its output streams into the step log and
# its exit code is this script's.
# https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command
)

$ErrorActionPreference = 'Stop'

foreach ($name in 'BRAINSTRIKE_CI_TEST_USER', 'BRAINSTRIKE_CI_TEST_USER_PASSWORD', 'BRAINSTRIKE_CI_TEST_USER_PROFILE', 'BRAINSTRIKE_CI_TEST_USER_TEMP') {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    throw "$name is not set: run the windows-desktop-test-host action first."
  }
}

# The command runs from a script file, as GitHub runs a bash step, so no
# quoting stands between it and bash.
$script = Join-Path $env:RUNNER_TEMP ("run-as-test-user-{0}.sh" -f [guid]::NewGuid())
[System.IO.File]::WriteAllText($script, "exec 2>&1`n$Command`n")
$info = [System.Diagnostics.ProcessStartInfo]::new((Join-Path $env:ProgramFiles 'Git\bin\bash.exe'))
foreach ($argument in '--noprofile', '--norc', '-eo', 'pipefail', ($script -replace '\\', '/')) {
  $info.ArgumentList.Add($argument)
}
$info.UseShellExecute = $false
$info.WorkingDirectory = (Get-Location).Path
$info.UserName = $env:BRAINSTRIKE_CI_TEST_USER
$info.Domain = $env:COMPUTERNAME
$info.Password = ConvertTo-SecureString $env:BRAINSTRIKE_CI_TEST_USER_PASSWORD -AsPlainText -Force
$info.LoadUserProfile = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true

# Setting any variable passes this step's whole environment on; without it
# the user would get a fresh profile environment without the job's PATH.
$userProfile = $env:BRAINSTRIKE_CI_TEST_USER_PROFILE
$info.Environment.Remove('BRAINSTRIKE_CI_TEST_USER_PASSWORD') | Out-Null
$info.Environment['USERNAME'] = $env:BRAINSTRIKE_CI_TEST_USER
$info.Environment['USERPROFILE'] = $userProfile
$info.Environment['HOME'] = $userProfile
$info.Environment['HOMEDRIVE'] = Split-Path -Qualifier $userProfile
$info.Environment['HOMEPATH'] = Split-Path -NoQualifier $userProfile
$info.Environment['APPDATA'] = Join-Path $userProfile 'AppData\Roaming'
$info.Environment['LOCALAPPDATA'] = Join-Path $userProfile 'AppData\Local'
$info.Environment['TEMP'] = $env:BRAINSTRIKE_CI_TEST_USER_TEMP
$info.Environment['TMP'] = $env:BRAINSTRIKE_CI_TEST_USER_TEMP

$process = [System.Diagnostics.Process]::Start($info)
$errors = $process.StandardError.ReadToEndAsync()
while ($null -ne ($line = $process.StandardOutput.ReadLine())) {
  Write-Output $line
}
$process.WaitForExit()
$bashErrors = $errors.GetAwaiter().GetResult()
if ($bashErrors) {
  Write-Output $bashErrors
}
Write-Output "Exit code $($process.ExitCode) (as $env:BRAINSTRIKE_CI_TEST_USER)."
exit $process.ExitCode
