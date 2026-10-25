# Runs one bash command as the standard test user that this action created, on
# two cores of a loaded machine: the conditions sean-pc tests under (a normal
# user, the test pinned to two cores while 14 busy loops load the others).
#
#   pwsh -File run-as-test-user.ps1 '<bash command>'
#
# The command runs in Git Bash, the way GitHub Actions runs a `shell: bash`
# step, in the current directory, with this step's environment except that its
# profile folders are the test user's. Its output streams into the step log and
# its exit code is this script's.
#
# Load: one busy loop per logical core outside the test's two, at BelowNormal
# priority (sean-pc's load method). A private repository's hosted Windows
# runner has only two cores, so there the loops share the test's two cores and
# take the time the test leaves idle.
# https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.processoraffinity
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

$testCores = [int64]0x3
$cores = [Environment]::ProcessorCount
$allCores = ([int64]1 -shl $cores) - 1
$loadCores = if ($cores -gt 2) { $allCores -band -bnot $testCores } else { $allCores }
$loadCount = if ($cores -gt 2) { $cores - 2 } else { $cores }
Write-Output ("{0} logical cores: the test runs on 0x{1:X} as {2}; {3} BelowNormal busy loops run on 0x{4:X}." -f $cores, $testCores, $env:BRAINSTRIKE_CI_TEST_USER, $loadCount, $loadCores)

$load = @()
try {
  for ($i = 0; $i -lt $loadCount; $i++) {
    $loop = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'while ($true) {}' -WindowStyle Hidden -PassThru
    $loop.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    $loop.ProcessorAffinity = [IntPtr]$loadCores
    $load += $loop
  }

  # The command runs from a script file, as GitHub runs a bash step, so no
  # quoting stands between it and bash. The pin is set by the test user's own
  # first process before it starts bash, so every process inherits it.
  $script = Join-Path $env:RUNNER_TEMP ("run-as-test-user-{0}.sh" -f [guid]::NewGuid())
  [System.IO.File]::WriteAllText($script, "exec 2>&1`n$Command`n")
  $bash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
  $launcher = "[System.Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity = [IntPtr]$testCores; & '$bash' --noprofile --norc -eo pipefail '$($script -replace '\\', '/')'; exit `$LASTEXITCODE"

  $info = [System.Diagnostics.ProcessStartInfo]::new((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  foreach ($argument in '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $launcher) {
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
  $launcherErrors = $errors.GetAwaiter().GetResult()
  if ($launcherErrors) {
    Write-Output $launcherErrors
  }
  Write-Output "Exit code $($process.ExitCode) (as $env:BRAINSTRIKE_CI_TEST_USER)."
  exit $process.ExitCode
} finally {
  foreach ($loop in $load) {
    Stop-Process -Id $loop.Id -Force -ErrorAction SilentlyContinue
  }
}
