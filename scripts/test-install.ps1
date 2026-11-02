# Run packages/web/public/install.ps1 against archives built by GoReleaser
# (.goreleaser.yaml), served from a local directory instead of GitHub Releases.
# The counterpart of test-install.sh; it runs on Windows, in Windows PowerShell
# and in PowerShell 7 (the one that runs this script is the one it tests).
#
#   test-install.ps1 VERSION RELEASE_DIRECTORY
#
# Each case installs into its own $work\<name>\bin and keeps the installer's
# output in $work\<name>\{out,err}, plus what the gh mock saw in gh.log. The
# installer runs through `Get-Content -Raw | Invoke-Expression` in a child
# process, the way `irm | iex` runs it.
#
# The installer edits the user PATH, which lives in the registry. This test
# saves it first and puts it back at the end, and it only runs on CI (or with
# PEDIT_TEST_TOUCH_USER_PATH=1) so a developer's PATH is not touched by chance.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$ReleaseDirectory
)
$ErrorActionPreference = 'Stop'

if ($env:CI -ne 'true' -and $env:PEDIT_TEST_TOUCH_USER_PATH -ne '1') {
  throw 'This test edits the user PATH (and restores it). Run it on CI, or set PEDIT_TEST_TOUCH_USER_PATH=1.'
}

$release = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'packages\web\public\install.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ('pedit-install-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$engine = (Get-Process -Id $PID).Path
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$archive = "pedit_${Version}_windows_$arch.zip"

# --- Helpers ---------------------------------------------------------------

function Fail([string]$Message) {
  throw "FAIL: $Message"
}

# CI archives have no published attestation, so gh is mocked at the process
# boundary: INSTALL_TEST_GH_AUTH_EXIT is the `gh auth status` result and
# INSTALL_TEST_GH_EXIT the `gh attestation verify` result. The arguments gh was
# called with go to INSTALL_TEST_GH_LOG, which the cases check.
function Initialize-Mocks {
  $mocks = Join-Path $work 'mocks'
  New-Item -ItemType Directory -Path $mocks | Out-Null
  $lines = @(
    '@echo off',
    'echo %* >>"%INSTALL_TEST_GH_LOG%"',
    'if "%1"=="auth" exit /b %INSTALL_TEST_GH_AUTH_EXIT%',
    'exit /b %INSTALL_TEST_GH_EXIT%'
  )
  Set-Content -LiteralPath (Join-Path $mocks 'gh.cmd') -Value $lines -Encoding ASCII
  $env:Path = "$mocks;$env:Path"
}

function Get-Text([string]$Name, [string]$File) {
  $path = Join-Path $work "$Name\$File"
  if (Test-Path -LiteralPath $path) { return (Get-Content -Raw -LiteralPath $path) }
  return ''
}

# Try-Install NAME [-Env @{...}] [-Release DIR]: run the installer into
# $work\NAME\bin. Variables in -Env reach the installer; a $null value removes
# the variable. Returns the exit code.
function Try-Install([string]$Name, [hashtable]$Env = @{}, [string]$Source = $release, [bool]$SetDir = $true, [string]$Prelude = '') {
  $dir = Join-Path $work $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $wrapper = Join-Path $dir 'run.ps1'
  $check = ''
  if ($SetDir) { $check = "Write-Host ('session-path-has-dir=' + ((`$env:Path -split ';') -contains `$env:PEDIT_INSTALL_DIR))" }
  Set-Content -LiteralPath $wrapper -Encoding ASCII -Value @(
    "`$ErrorActionPreference = 'Stop'",
    $Prelude,
    # PowerShell 7 formats a thrown error with colors and line breaks; print the plain message.
    "try { Get-Content -Raw -LiteralPath '$script' | Invoke-Expression } catch { [Console]::Error.WriteLine(`$_.Exception.Message); exit 1 }",
    "Write-Host 'shell-still-alive'",
    $check
  )
  $vars = @{
    INSTALL_TEST_GH_LOG = Join-Path $dir 'gh.log'
    INSTALL_TEST_GH_AUTH_EXIT = '0'
    INSTALL_TEST_GH_EXIT = '0'
    PEDIT_VERSION = $Version
    PEDIT_DOWNLOAD_URL = ([Uri]$Source).AbsoluteUri
    PEDIT_NO_MODIFY_PATH = $null
  }
  if ($SetDir) { $vars.PEDIT_INSTALL_DIR = Join-Path $dir 'bin' } else { $vars.PEDIT_INSTALL_DIR = $null }
  foreach ($key in $Env.Keys) { $vars[$key] = $Env[$key] }
  $saved = @{}
  foreach ($key in $vars.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key)
    [Environment]::SetEnvironmentVariable($key, $vars[$key])
  }
  try {
    $p = Start-Process -FilePath $engine -Wait -PassThru -NoNewWindow -WorkingDirectory (Get-Location).Path `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $wrapper) `
      -RedirectStandardOutput (Join-Path $dir 'out') -RedirectStandardError (Join-Path $dir 'err')
    return $p.ExitCode
  } finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
  }
}

function Invoke-Install([string]$Name, [hashtable]$Env = @{}, [string]$Source = $release, [bool]$SetDir = $true) {
  if ((Try-Install $Name $Env $Source $SetDir) -ne 0) {
    Fail "${Name}: install.ps1 failed: $(Get-Text $Name 'out')$(Get-Text $Name 'err')"
  }
}

function Assert-Failure([string]$Name, [hashtable]$Env = @{}, [string]$Source = $release, [string]$Prelude = '') {
  if ((Try-Install $Name $Env $Source $true $Prelude) -eq 0) { Fail "${Name}: install.ps1 succeeded" }
}

function Assert-Installed([string]$Name) {
  $exe = Join-Path $work "$Name\bin\pedit.exe"
  $got = (& $exe --version)
  if ($got -ne $Version) { Fail "${Name}: pedit $Version is not installed (got '$got')" }
  $stray = @(Get-ChildItem -LiteralPath (Join-Path $work "$Name\bin") -Force -Filter '.pedit-*')
  if ($stray.Count -gt 0) { Fail "${Name}: a staging file was left behind" }
}

# Assert-Contains NAME FILE PATTERN / Assert-Lacks NAME FILE PATTERN, where FILE
# is out, err or gh.log and PATTERN a regular expression.
function Assert-Contains([string]$Name, [string]$File, [string]$Pattern) {
  if ((Get-Text $Name $File) -notmatch $Pattern) {
    Fail "${Name}: $File does not contain '$Pattern'. out: $(Get-Text $Name 'out') err: $(Get-Text $Name 'err')"
  }
}

function Assert-Lacks([string]$Name, [string]$File, [string]$Pattern) {
  if ((Get-Text $Name $File) -match $Pattern) { Fail "${Name}: $File contains '$Pattern'" }
}

# The user PATH as stored: its text and registry kind, without expanding %VAR%.
function Get-RawUserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  try {
    $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = $null
    if ($null -ne $value) { $kind = $key.GetValueKind('Path') }
    return @{ Value = $value; Kind = $kind }
  } finally {
    $key.Close()
  }
}

function Set-RawUserPath($Stored) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    if ($null -eq $Stored.Value) {
      $key.DeleteValue('Path', $false)
    } else {
      $key.SetValue('Path', $Stored.Value, $Stored.Kind)
    }
  } finally {
    $key.Close()
  }
}

function Get-UserPathCount([string]$Dir) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrEmpty($user)) { return 0 }
  return @($user -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }).Count
}

# New-Release NAME TAG: the release directory re-labelled as TAG, so a test can
# present the same archives as an older release.
function New-Release([string]$Name, [string]$Tag) {
  $dir = Join-Path $work $Name
  New-Item -ItemType Directory -Path $dir | Out-Null
  foreach ($file in Get-ChildItem -LiteralPath $release -Filter 'pedit_*') {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $dir $file.Name.Replace($Version, $Tag))
  }
  $sums = (Get-Content -Raw -LiteralPath (Join-Path $release 'checksums.txt')).Replace($Version, $Tag)
  [IO.File]::WriteAllText((Join-Path $dir 'checksums.txt'), $sums)
  return $dir
}

# --- Cases -----------------------------------------------------------------

function Install-Fresh {
  Invoke-Install fresh
  Assert-Installed fresh
  Assert-Contains fresh out "Downloading pedit $([regex]::Escape($Version)) \(windows/$arch\)\.\.\. DONE"
  Assert-Contains fresh out 'Installed pedit .* to .*pedit\.exe'
  Assert-Contains fresh out 'shell-still-alive'
  # The current session got the directory, and so did the user PATH.
  Assert-Contains fresh out 'session-path-has-dir=True'
  Assert-Contains fresh out 'Added .* to your user PATH'
  if ((Get-UserPathCount (Join-Path $work 'fresh\bin')) -ne 1) { Fail 'fresh: the user PATH lacks the install directory' }
}

function Path-Is-Added-Once {
  Invoke-Install twice
  Invoke-Install twice
  Assert-Installed twice
  if ((Get-UserPathCount (Join-Path $work 'twice\bin')) -ne 1) { Fail 'twice: the install directory is not on the user PATH exactly once' }
  Assert-Lacks twice out 'Added'
}

function Path-Keeps-Expandable-Entries {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $key.SetValue('Path', '%SystemRoot%\pedit-test-entry', [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } finally {
    $key.Close()
  }
  Invoke-Install expandable
  $stored = Get-RawUserPath
  if ($stored.Kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { Fail "expandable: the user PATH is now $($stored.Kind)" }
  if (-not $stored.Value.StartsWith('%SystemRoot%\pedit-test-entry;')) { Fail "expandable: an existing entry was rewritten: $($stored.Value)" }
  if ((Get-UserPathCount (Join-Path $work 'expandable\bin')) -ne 1) { Fail 'expandable: the install directory is not on the user PATH' }
}

function Resolve-A-Relative-Install-Directory {
  $dir = Join-Path $work 'relative'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Push-Location $dir
  try {
    Invoke-Install relative @{ PEDIT_INSTALL_DIR = 'rel-bin' }
  } finally {
    Pop-Location
  }
  $full = Join-Path $dir 'rel-bin'
  if ((& (Join-Path $full 'pedit.exe') --version) -ne $Version) { Fail 'relative: pedit is not under the resolved directory' }
  if ((Get-UserPathCount $full) -ne 1) { Fail 'relative: the user PATH lacks the absolute install directory' }
  if ((Get-UserPathCount 'rel-bin') -ne 0) { Fail 'relative: the relative directory is on the user PATH' }
}

function Path-Is-Left-Alone-When-Asked {
  Invoke-Install nopath @{ PEDIT_NO_MODIFY_PATH = '1' }
  Assert-Installed nopath
  Assert-Contains nopath out 'Add .* to your PATH to run pedit'
  Assert-Lacks nopath out 'Added'
  Assert-Contains nopath out 'session-path-has-dir=False'
  if ((Get-UserPathCount (Join-Path $work 'nopath\bin')) -ne 0) { Fail 'nopath: the user PATH was changed' }
}

function Install-To-The-Default-Directory {
  $local = Join-Path $work 'defaultdir\localappdata'
  Invoke-Install defaultdir @{ LOCALAPPDATA = $local; PEDIT_NO_MODIFY_PATH = '1' } $release $false
  $exe = Join-Path $local 'Programs\pedit\pedit.exe'
  if ((& $exe --version) -ne $Version) { Fail 'defaultdir: pedit is not under %LOCALAPPDATA%\Programs\pedit' }
}

function Upgrade-Over-A-Running-Pedit {
  $bin = Join-Path $work 'running\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  # A long-running program standing in for the old pedit. Windows will not
  # overwrite it while it runs, but it can be renamed.
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\ping.exe') -Destination (Join-Path $bin 'pedit.exe')
  $running = Start-Process -FilePath (Join-Path $bin 'pedit.exe') -ArgumentList '-n', '120', '127.0.0.1' -PassThru -WindowStyle Hidden
  try {
    Invoke-Install running @{ PEDIT_NO_MODIFY_PATH = '1' }
    Assert-Installed running
    if (-not (Test-Path -LiteralPath (Join-Path $bin 'pedit.exe.old'))) { Fail 'running: the old pedit.exe was not kept as pedit.exe.old' }
    # The old one still runs, so it cannot be removed: a second upgrade must not
    # fail on it either.
    Invoke-Install running @{ PEDIT_NO_MODIFY_PATH = '1' }
    Assert-Installed running
  } finally {
    Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue
  }
}

function Upgrade-Over-An-Existing-Pedit {
  $bin = Join-Path $work 'upgrade\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Set-Content -LiteralPath (Join-Path $bin 'pedit.exe') -Value 'first' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $bin 'pedit.exe.old') -Value 'older' -Encoding ASCII
  Invoke-Install upgrade @{ PEDIT_NO_MODIFY_PATH = '1' }
  Assert-Installed upgrade
  if ((Get-Content -Raw -LiteralPath (Join-Path $bin 'pedit.exe.old')).Trim() -ne 'first') { Fail 'upgrade: pedit.exe.old is not the replaced pedit.exe' }
}

function Refuse-A-Checksum-Mismatch {
  $bad = Join-Path $work 'bad-release'
  New-Item -ItemType Directory -Path $bad | Out-Null
  Copy-Item -Path (Join-Path $release '*') -Destination $bad
  $zeros = '0' * 64
  $lines = Get-Content -LiteralPath (Join-Path $release 'checksums.txt') | ForEach-Object { $_ -replace '^[0-9a-f]{64}', $zeros }
  Set-Content -LiteralPath (Join-Path $bad 'checksums.txt') -Value $lines -Encoding ASCII
  $bin = Join-Path $work 'mismatch\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Set-Content -LiteralPath (Join-Path $bin 'pedit.exe') -Value 'untouched' -Encoding ASCII
  Assert-Failure mismatch @{} $bad
  Assert-Contains mismatch err 'checksum mismatch'
  Assert-Contains mismatch out 'FAILED'
  Assert-Lacks mismatch out 'Installed'
  if ((Get-Content -Raw -LiteralPath (Join-Path $bin 'pedit.exe')).Trim() -ne 'untouched') { Fail 'mismatch: pedit.exe was replaced' }
  if (Test-Path -LiteralPath (Join-Path $bin 'pedit.exe.old')) { Fail 'mismatch: pedit.exe was moved aside' }
  Assert-Lacks mismatch gh.log '.'
}

function Refuse-A-Missing-Entry {
  $gap = Join-Path $work 'gap-release'
  New-Item -ItemType Directory -Path $gap | Out-Null
  Copy-Item -Path (Join-Path $release '*') -Destination $gap
  $lines = Get-Content -LiteralPath (Join-Path $release 'checksums.txt') | Where-Object { $_ -notmatch 'windows' }
  Set-Content -LiteralPath (Join-Path $gap 'checksums.txt') -Value $lines -Encoding ASCII
  Assert-Failure missing @{} $gap
  Assert-Contains missing err 'is not listed in checksums\.txt'
  if (Test-Path -LiteralPath (Join-Path $work 'missing\bin\pedit.exe')) { Fail 'missing: pedit was installed' }
}

function Refuse-An-Unsupported-Architecture {
  # Set inside the child: the installer reads the variables of its own process.
  Assert-Failure x86 @{} $release "`$env:PROCESSOR_ARCHITECTURE = 'MIPS'; Remove-Item Env:PROCESSOR_ARCHITEW6432 -ErrorAction SilentlyContinue"
  Assert-Contains x86 err 'unsupported architecture MIPS'
}

function Refuse-A-Directory-Destination {
  $dest = Join-Path $work 'directory\bin\pedit.exe'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Assert-Failure directory
  Assert-Contains directory err 'is a directory'
  Assert-Lacks directory out 'Installed'
  if (-not (Test-Path -LiteralPath $dest -PathType Container)) { Fail 'directory: the existing directory was changed' }
}

function Verify-Provenance-When-Gh-Is-Signed-In {
  Invoke-Install signed @{ PEDIT_NO_MODIFY_PATH = '1' }
  Assert-Installed signed
  Assert-Contains signed out 'Verifying build provenance\.\.\. DONE'
  Assert-Contains signed gh.log 'auth status --active --hostname github\.com'
  Assert-Contains signed gh.log 'attestation verify .*pedit_.*_windows_.*\.zip --repo piconic-ai/pedit --signer-workflow piconic-ai/pedit/\.github/workflows/release-build\.yml --deny-self-hosted-runners'
}

function Verify-Releases-Signed-Under-Older-Names {
  $old = New-Release 'renamed-release' 'v0.0.12'
  Invoke-Install renamed @{ PEDIT_VERSION = 'v0.0.12'; PEDIT_NO_MODIFY_PATH = '1' } $old
  Assert-Contains renamed gh.log ' --repo piconic-ai/edit --signer-workflow piconic-ai/edit/\.github/workflows/tagpr\.yml '
  $tagpr = New-Release 'tagpr-release' 'v0.1.2'
  Invoke-Install tagpr @{ PEDIT_VERSION = 'v0.1.2'; PEDIT_NO_MODIFY_PATH = '1' } $tagpr
  Assert-Contains tagpr gh.log ' --repo piconic-ai/pedit --signer-workflow piconic-ai/pedit/\.github/workflows/tagpr\.yml '
}

function Skip-Provenance-When-Gh-Is-Signed-Out {
  Invoke-Install signedout @{ INSTALL_TEST_GH_AUTH_EXIT = '1'; PEDIT_NO_MODIFY_PATH = '1' }
  Assert-Installed signedout
  Assert-Contains signedout out 'Skipped the build provenance check'
  Assert-Lacks signedout gh.log 'attestation'
}

function Refuse-Failed-Provenance {
  foreach ($code in 1, 2, 127) {
    $name = "rejected-$code"
    $bin = Join-Path $work "$name\bin"
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Set-Content -LiteralPath (Join-Path $bin 'pedit.exe') -Value 'untouched' -Encoding ASCII
    Assert-Failure $name @{ INSTALL_TEST_GH_EXIT = "$code" }
    Assert-Contains $name out 'Verifying build provenance\.\.\. FAILED'
    Assert-Contains $name err 'release provenance verification failed'
    Assert-Lacks $name out 'Installed'
    if ((Get-Content -Raw -LiteralPath (Join-Path $bin 'pedit.exe')).Trim() -ne 'untouched') { Fail "${name}: pedit.exe was replaced" }
    if (@(Get-ChildItem -LiteralPath $bin -Force).Count -ne 1) { Fail "${name}: files were left in the install directory" }
  }
}

# --- Run -------------------------------------------------------------------

$userPath = Get-RawUserPath
$sessionPath = $env:Path
try {
  Initialize-Mocks
  foreach ($case in 'Install-Fresh', 'Path-Is-Added-Once', 'Path-Keeps-Expandable-Entries',
      'Resolve-A-Relative-Install-Directory', 'Path-Is-Left-Alone-When-Asked',
      'Install-To-The-Default-Directory', 'Upgrade-Over-A-Running-Pedit', 'Upgrade-Over-An-Existing-Pedit',
      'Refuse-A-Checksum-Mismatch', 'Refuse-A-Missing-Entry', 'Refuse-An-Unsupported-Architecture',
      'Refuse-A-Directory-Destination', 'Verify-Provenance-When-Gh-Is-Signed-In',
      'Verify-Releases-Signed-Under-Older-Names', 'Skip-Provenance-When-Gh-Is-Signed-Out',
      'Refuse-Failed-Provenance') {
    Write-Host "--- $($case.Replace('-', ' ').ToLower())"
    & $case
  }
  Write-Host 'ok'
} finally {
  Set-RawUserPath $userPath
  $env:Path = $sessionPath
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
