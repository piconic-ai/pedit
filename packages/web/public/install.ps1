# Install pedit from GitHub Releases on Windows (PowerShell 5.1 or 7):
#
#   irm https://edit.piconic.ai/install.ps1 | iex
#
# PEDIT_VERSION        release tag to install (default: the latest release)
# PEDIT_INSTALL_DIR    where to put pedit.exe (default: %LOCALAPPDATA%\Programs\pedit)
# PEDIT_NO_MODIFY_PATH set to 1 to leave your PATH alone and only print a hint
#
# The archive is checked against checksums.txt, and against its build
# provenance too when the GitHub CLI is installed and signed in.
# It never needs administrator rights. The install directory is added to your
# user PATH (not the machine PATH) unless PEDIT_NO_MODIFY_PATH=1.
# Everything runs from Install-Pedit, called on the last line, so a truncated
# download does nothing. Errors are thrown, never `exit`, so running this with
# iex does not close your shell.

function Install-Pedit {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $repo = 'piconic-ai/pedit'

  function Fail([string]$Message) {
    throw "pedit install: $Message"
  }

  # Steps print "<label>... DONE" (or FAILED, then the error).
  function Invoke-Step([string]$Label, [scriptblock]$Body) {
    Write-Host -NoNewline "$Label... "
    try {
      & $Body
    } catch {
      Write-Host 'FAILED'
      throw
    }
    Write-Host 'DONE'
  }

  function Get-Arch {
    if ($env:OS -ne 'Windows_NT') {
      Fail "unsupported OS; on macOS or Linux use install.sh, or download a binary from https://github.com/$repo/releases"
    }
    # PROCESSOR_ARCHITEW6432 is the real architecture inside a 32-bit process.
    $machine = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrEmpty($machine)) { $machine = $env:PROCESSOR_ARCHITECTURE }
    switch ($machine) {
      'AMD64' { return 'amd64' }
      'ARM64' { return 'arm64' }
      default { Fail "unsupported architecture $machine; download a binary from https://github.com/$repo/releases" }
    }
  }

  function Get-LatestVersion {
    # /releases/latest redirects to /releases/tag/<tag>; this avoids the API rate limit.
    try {
      $request = [System.Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest")
      $request.Method = 'HEAD'
      $response = $request.GetResponse()
      $url = $response.ResponseUri.AbsoluteUri
      $response.Close()
    } catch {
      Fail 'could not look up the latest release'
    }
    $tag = $url.Substring($url.LastIndexOf('/') + 1)
    if (-not $tag.StartsWith('v')) { Fail "could not find the latest release at $url" }
    return $tag
  }

  function Get-File([string]$Url, [string]$Path) {
    $client = New-Object System.Net.WebClient
    try {
      $client.DownloadFile($Url, $Path)
    } catch {
      $reason = $_.Exception.Message
      if ($_.Exception.InnerException) { $reason = $_.Exception.InnerException.Message }
      Fail "could not download ${Url}: $reason"
    } finally {
      $client.Dispose()
    }
  }

  function Test-Checksum([string]$Dir, [string]$Name) {
    $expected = $null
    foreach ($line in Get-Content -LiteralPath (Join-Path $Dir 'checksums.txt')) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2] -eq $Name) {
        $expected = $Matches[1]
      }
    }
    if (-not $expected) { Fail "$Name is not listed in checksums.txt" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Dir $Name)).Hash
    if ($actual -ne $expected) { Fail "checksum mismatch for $Name" }
  }

  # The repository whose workflow signed that release. Releases up to v0.0.12
  # were built before the repository was renamed from piconic-ai/edit, and the
  # signature keeps the name it was made under.
  function Get-Signer([string]$Version) {
    if ($Version -match '^v0\.0\.([0-9]|1[0-2])$') { return 'piconic-ai/edit' }
    return $repo
  }

  # The workflow file that signed that release. Up to v0.1.2 the archives were
  # built in tagpr.yml itself; later releases are built by the reusable
  # release-build.yml, which then is the signer.
  function Get-SignerWorkflow([string]$Version) {
    if ($Version -match '^v0\.0\.([0-9]|1[0-3])$' -or $Version -match '^v0\.1\.[0-2]$') { return 'tagpr.yml' }
    return 'release-build.yml'
  }

  # Run gh and return its exit code and output. Windows PowerShell 5.1 turns a
  # native command's stderr into an error under 'Stop', so relax it here.
  function Invoke-Gh([string[]]$GhArgs) {
    $ErrorActionPreference = 'Continue'
    $text = (& gh @GhArgs 2>&1 | Out-String)
    return @{ Code = $LASTEXITCODE; Text = $text }
  }

  function Test-Provenance([string]$Archive, [string]$Version) {
    # Optional: gh fetches attestations from the GitHub API, which needs a sign-in.
    # --active: without it, any other stored account with an expired token fails.
    if (-not (Get-Command gh -ErrorAction SilentlyContinue) -or
        (Invoke-Gh @('auth', 'status', '--active', '--hostname', 'github.com')).Code -ne 0) {
      Write-Host 'Skipped the build provenance check (needs the GitHub CLI, signed in)'
      return
    }
    $signedBy = Get-Signer $Version
    Write-Host -NoNewline 'Verifying build provenance... '
    $result = Invoke-Gh @('attestation', 'verify', $Archive,
      '--repo', $signedBy,
      '--signer-workflow', "$signedBy/.github/workflows/$(Get-SignerWorkflow $Version)",
      '--deny-self-hosted-runners')
    if ($result.Code -ne 0) {
      Write-Host 'FAILED'
      [Console]::Error.WriteLine($result.Text)
      Fail 'release provenance verification failed; no files were installed'
    }
    Write-Host 'DONE'
  }

  # Move the staged file over the destination. A running pedit.exe cannot be
  # overwritten but can be renamed, so the old one moves aside first, and goes
  # back if the new one cannot take its place.
  function Install-File([string]$Staged, [string]$Dest) {
    $old = "$Dest.old"
    $hadOld = Test-Path -LiteralPath $Dest
    if ($hadOld) {
      if (Test-Path -LiteralPath $old) {
        # Still running from an earlier upgrade? Then pick another name.
        Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $old) {
          $old = "$Dest.old.$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        }
      }
      Move-Item -LiteralPath $Dest -Destination $old -Force
    }
    try {
      Move-Item -LiteralPath $Staged -Destination $Dest
    } catch {
      if ($hadOld) { Move-Item -LiteralPath $old -Destination $Dest -Force }
      throw
    }
  }

  function Test-OnPath([string]$PathValue, [string]$Dir) {
    $want = $Dir.TrimEnd('\')
    foreach ($entry in ($PathValue -split ';')) {
      if ($entry.Trim().TrimEnd('\') -ieq $want) { return $true }
    }
    return $false
  }

  function Update-Path([string]$Dir) {
    $inSession = Test-OnPath $env:Path $Dir
    if ($env:PEDIT_NO_MODIFY_PATH -eq '1') {
      if (-not $inSession) {
        Write-Host "Add $Dir to your PATH to run pedit, for example: [Environment]::SetEnvironmentVariable('Path', `"$Dir;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
      }
      return
    }
    # Read and write the registry value itself, not through [Environment]: that
    # expands %VAR% references and stores the result, which would rewrite the
    # entries of other tools.
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = [Microsoft.Win32.RegistryValueKind]::String
      if ($null -ne $raw) { $kind = $key.GetValueKind('Path') }
      $present = ($null -ne $raw) -and ((Test-OnPath $raw $Dir) -or (Test-OnPath ([Environment]::ExpandEnvironmentVariables($raw)) $Dir))
      if (-not $present) {
        if ([string]::IsNullOrEmpty($raw)) { $new = $Dir } else { $new = $raw.TrimEnd(';') + ';' + $Dir }
        $key.SetValue('Path', $new, $kind)
        # Tell running programs (Explorer, new terminals) that the environment
        # changed. Removing a variable that does not exist broadcasts and
        # changes nothing else.
        [Environment]::SetEnvironmentVariable('PEDIT_INSTALL_BROADCAST', $null, 'User')
        Write-Host "Added $Dir to your user PATH (set PEDIT_NO_MODIFY_PATH=1 to skip this). Open a new terminal to use pedit there."
      }
    } finally {
      $key.Close()
    }
    if (-not $inSession) { $env:Path = $env:Path.TrimEnd(';') + ';' + $Dir }
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {}

  $arch = Get-Arch
  $version = $env:PEDIT_VERSION
  if ([string]::IsNullOrEmpty($version)) { $version = Get-LatestVersion }
  $installDir = $env:PEDIT_INSTALL_DIR
  if ([string]::IsNullOrEmpty($installDir)) { $installDir = Join-Path $env:LOCALAPPDATA 'Programs\pedit' }
  # A relative directory would end up on PATH as written, and mean something else elsewhere.
  $installDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($installDir)
  # PEDIT_DOWNLOAD_URL replaces GitHub in tests (scripts/test-install.ps1).
  $base = $env:PEDIT_DOWNLOAD_URL
  if ([string]::IsNullOrEmpty($base)) { $base = "https://github.com/$repo/releases/download/$version" }
  $base = $base.TrimEnd('/')
  $archive = "pedit_${version}_windows_$arch.zip"

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('pedit-install-' + [guid]::NewGuid().ToString('N'))
  $staged = $null
  try {
    New-Item -ItemType Directory -Path $tmp | Out-Null

    Invoke-Step "Downloading pedit $version (windows/$arch)" {
      Get-File "$base/$archive" (Join-Path $tmp $archive)
      Get-File "$base/checksums.txt" (Join-Path $tmp 'checksums.txt')
      Test-Checksum $tmp $archive
    }
    Test-Provenance (Join-Path $tmp $archive) $version

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $tmp $archive))
    try {
      $entry = $zip.Entries | Where-Object { $_.FullName -eq 'pedit.exe' } | Select-Object -First 1
      if (-not $entry) { Fail "$archive has no pedit.exe" }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $tmp 'pedit.exe'))
    } finally {
      $zip.Dispose()
    }

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $dest = Join-Path $installDir 'pedit.exe'
    # Move-Item would move the binary into a directory instead of replacing it.
    if (Test-Path -LiteralPath $dest -PathType Container) { Fail "$dest is a directory" }
    # Stage next to the destination so the final move is a rename on one volume.
    $staged = Join-Path $installDir ('.pedit-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp')
    Copy-Item -LiteralPath (Join-Path $tmp 'pedit.exe') -Destination $staged
    Install-File $staged $dest
    $staged = $null
    Write-Host "Installed pedit $version to $dest"

    Update-Path $installDir
  } finally {
    if ($staged) { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-Pedit
