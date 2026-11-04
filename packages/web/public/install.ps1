# Install pedit from GitHub Releases on Windows (PowerShell 5.1 or 7):
#
#   irm https://edit.piconic.ai/install.ps1 | iex
#
# PEDIT_VERSION        release tag to install (default: the latest release)
# PEDIT_INSTALL_DIR    where to put pedit.exe (default: %LOCALAPPDATA%\Programs\pedit)
# PEDIT_NO_MODIFY_PATH set to 1 to leave your PATH alone and only print a hint
#
# The archive is checked against checksums.txt, and against its build
# provenance too when the GitHub CLI is installed: gh verifies the Sigstore
# bundle published with the release (no GitHub sign-in needed) and the commit
# the tag points to. Releases before v0.1.6 have no bundle, so there gh must be
# signed in to fetch the attestation.
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
    # The OS architecture: an x64 PowerShell on ARM64 Windows reports AMD64 in
    # its environment variables. The type is missing on Windows PowerShell 5.1
    # with older .NET Framework, so fall back to the variables, where
    # PROCESSOR_ARCHITEW6432 is the real architecture inside a 32-bit process.
    $machine = $null
    try { $machine = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch {}
    if ($machine -eq 'X64') { $machine = 'AMD64' }
    if ([string]::IsNullOrEmpty($machine)) { $machine = $env:PROCESSOR_ARCHITEW6432 }
    if ([string]::IsNullOrEmpty($machine)) { $machine = $env:PROCESSOR_ARCHITECTURE }
    switch ($machine.ToUpperInvariant()) {
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

  # Run gh and return its exit code and output, stdout and stderr as gh wrote
  # them. Redirecting to files avoids PowerShell turning stderr into error
  # records, which Windows PowerShell 5.1 wraps in NativeCommandError text.
  function Invoke-Gh([string[]]$GhArgs) {
    $gh = (Get-Command gh -ErrorAction Stop | Select-Object -First 1).Source
    $quoted = $GhArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
    $stdout = [IO.Path]::GetTempFileName()
    $stderr = [IO.Path]::GetTempFileName()
    try {
      $p = Start-Process -FilePath $gh -ArgumentList $quoted -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
      $text = (Get-Content -Raw -LiteralPath $stdout) + (Get-Content -Raw -LiteralPath $stderr)
      return @{ Code = $p.ExitCode; Text = $text }
    } finally {
      Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    }
  }

  # Whether that release publishes pedit_<version>.sigstore.json beside its
  # archives. v0.1.6 is the first that does.
  function Test-HasBundle([string]$Version) {
    return -not ($Version -match '^v0\.0\.' -or $Version -match '^v0\.1\.[0-5]$')
  }

  # The 40-hex SHA that the release tag points to, as GitHub reports it, or
  # $null. Only the tag name is sent. PEDIT_API_URL replaces the API in tests
  # (scripts/test-install.ps1).
  function Get-TagCommit([string]$Version) {
    $api = $env:PEDIT_API_URL
    if ([string]::IsNullOrEmpty($api)) { $api = 'https://api.github.com' }
    $client = New-Object System.Net.WebClient
    try {
      $client.Headers.Add('Accept', 'application/vnd.github.sha')
      $client.Headers.Add('User-Agent', 'pedit-install')
      $text = $client.DownloadString("$($api.TrimEnd('/'))/repos/$repo/commits/$Version").Trim()
      if ($text -cmatch '^[0-9a-f]{40}$') { return $text }
    } catch {
    } finally {
      $client.Dispose()
    }
    return $null
  }

  function Test-Provenance([string]$Archive, [string]$Version) {
    # Optional: needs the GitHub CLI.
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
      Write-Host 'Skipped the build provenance check (needs the GitHub CLI)'
      return
    }
    $signedBy = Get-Signer $Version
    $ghArgs = @('attestation', 'verify', $Archive,
      '--repo', $signedBy,
      '--signer-workflow', "$signedBy/.github/workflows/$(Get-SignerWorkflow $Version)",
      '--deny-self-hosted-runners')
    $bundle = $null
    if (Test-HasBundle $Version) {
      # Verified offline against the release's bundle, so no sign-in is needed.
      # Pinning the tag's commit is best effort: the API may be rate limited.
      $commit = Get-TagCommit $Version
      if ($commit) {
        $ghArgs += @('--source-digest', $commit, '--signer-digest', $commit)
      } else {
        Write-Host "Could not look up the commit of $Version, so the build is not pinned to it"
      }
      $bundle = Join-Path $tmp 'bundle.json'
      $ghArgs += @('--bundle', $bundle)
    } elseif ((Invoke-Gh @('auth', 'status', '--active', '--hostname', 'github.com')).Code -ne 0) {
      # Without a bundle, gh fetches the attestation from the GitHub API, which
      # needs a sign-in. --active: without it, any other stored account with an
      # expired token fails.
      Write-Host 'Skipped the build provenance check (needs the GitHub CLI, signed in)'
      return
    }
    Invoke-Step 'Verifying build provenance' {
      if ($bundle) { Get-File "$base/pedit_$Version.sigstore.json" $bundle }
      $result = Invoke-Gh $ghArgs
      if ($result.Code -ne 0) {
        [Console]::Error.WriteLine($result.Text)
        Fail 'release provenance verification failed; no files were installed'
      }
    }
  }

  # Remove what earlier upgrades left beside pedit.exe. A copy that is still
  # running cannot be deleted and stays for the next install.
  function Remove-OldCopies([string]$Dest) {
    Get-ChildItem -LiteralPath (Split-Path -Parent $Dest) -Force -Filter ((Split-Path -Leaf $Dest) + '.old*') -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  }

  # Move the staged file over the destination. A running pedit.exe cannot be
  # overwritten but can be renamed, so the old one moves aside first, and goes
  # back if the new one cannot take its place.
  function Install-File([string]$Staged, [string]$Dest) {
    $old = "$Dest.old"
    $hadOld = Test-Path -LiteralPath $Dest
    if ($hadOld) {
      Remove-OldCopies $Dest
      if (Test-Path -LiteralPath $old) {
        # Still running from an earlier upgrade? Then pick another name.
        $old = "$Dest.old.$([guid]::NewGuid().ToString('N').Substring(0, 8))"
      }
      Move-Item -LiteralPath $Dest -Destination $old -Force
    }
    try {
      Move-Item -LiteralPath $Staged -Destination $Dest
    } catch {
      if ($hadOld) { Move-Item -LiteralPath $old -Destination $Dest -Force }
      throw
    }
    # The replaced pedit goes too unless it is running.
    Remove-OldCopies $Dest
  }

  function Test-OnPath([string]$PathValue, [string]$Dir) {
    $want = $Dir.TrimEnd('\')
    foreach ($entry in ($PathValue -split ';')) {
      if ($entry.Trim().TrimEnd('\') -ieq $want) { return $true }
    }
    return $false
  }

  # The user PATH as stored in the registry, without expanding %VAR%: setting
  # it through [Environment] would store the expanded text and so rewrite the
  # entries of other tools.
  function Get-StoredUserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    if (-not $key) { return @{ Value = $null; Kind = $null } }
    try {
      $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = $null
      if ($null -ne $value) { $kind = $key.GetValueKind('Path') }
      return @{ Value = $value; Kind = $kind }
    } finally {
      $key.Close()
    }
  }

  function Test-OnUserPath($Stored, [string]$Dir) {
    if ($null -eq $Stored.Value) { return $false }
    return (Test-OnPath $Stored.Value $Dir) -or (Test-OnPath ([Environment]::ExpandEnvironmentVariables($Stored.Value)) $Dir)
  }

  function Update-Path([string]$Dir) {
    $inSession = Test-OnPath $env:Path $Dir
    $stored = Get-StoredUserPath
    $onUserPath = Test-OnUserPath $stored $Dir
    if ($env:PEDIT_NO_MODIFY_PATH -eq '1') {
      if ($onUserPath) {
        if (-not $inSession) { Write-Host "$Dir is on your user PATH already. Open a new terminal to use pedit there." }
      } elseif (-not $inSession) {
        Write-Host "Add $Dir to your PATH to run pedit (Start menu, Edit environment variables for your account, Path)."
      }
      return
    }
    if (-not $onUserPath) {
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
      try {
        # Windows itself stores a new Path as REG_EXPAND_SZ.
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($null -ne $stored.Kind) { $kind = $stored.Kind }
        if ([string]::IsNullOrEmpty($stored.Value)) { $new = $Dir } else { $new = $stored.Value.TrimEnd(';') + ';' + $Dir }
        $key.SetValue('Path', $new, $kind)
      } finally {
        $key.Close()
      }
      # Tell running programs (Explorer, new terminals) that the environment
      # changed. Removing a variable that does not exist broadcasts and
      # changes nothing else.
      [Environment]::SetEnvironmentVariable('PEDIT_INSTALL_BROADCAST', $null, 'User')
      Write-Host "Added $Dir to your user PATH (set PEDIT_NO_MODIFY_PATH=1 to skip this). Open a new terminal to use pedit there."
    }
    if (-not $inSession) { $env:Path = $env:Path.TrimEnd(';') + ';' + $Dir }
  }

  # Another pedit earlier on PATH would keep running instead of this one.
  function Test-Shadowing([string]$Dest) {
    $found = Get-Command pedit -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found -and ($found.Source -ine $Dest)) {
      Write-Host "Warning: running pedit starts $($found.Source), not the one just installed, because its directory comes earlier on your PATH. Remove it or put $(Split-Path -Parent $Dest) first."
    }
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

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $dest = Join-Path $installDir 'pedit.exe'
    # Move-Item would move the binary into a directory instead of replacing it.
    if (Test-Path -LiteralPath $dest -PathType Container) { Fail "$dest is a directory" }
    # Stage next to the destination so the final move is a rename on one volume.
    $staged = Join-Path $installDir ('.pedit-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $tmp $archive))
    try {
      $entry = $zip.Entries | Where-Object { $_.FullName -eq 'pedit.exe' } | Select-Object -First 1
      if (-not $entry) { Fail "$archive has no pedit.exe" }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $staged)
    } finally {
      $zip.Dispose()
    }
    Install-File $staged $dest
    $staged = $null
    Write-Host "Installed pedit $version to $dest"

    Update-Path $installDir
    Test-Shadowing $dest
  } finally {
    if ($staged) { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-Pedit
