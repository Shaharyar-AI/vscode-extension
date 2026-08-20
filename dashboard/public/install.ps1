# CR-Track installer for Windows PowerShell.
#
#   irm https://cr-track-dashboard.vercel.app/install.ps1 | iex
#
# The bash installer is for macOS and Linux. On Windows, `bash` resolves to
# WSL's bash, so `curl ... | bash` fails with "no installed distributions" on
# any machine without a WSL distro — which is most of them.
#
# Environment:
#   CR_TRACK_BASE   override the download host
#   CODE_BIN        use a specific editor CLI
#   CR_TRACK_FORCE  set to 1 to reinstall even when the version already matches

function Install-CRTrack {
  [CmdletBinding()]
  param()

  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 still defaults to TLS 1.0 on some builds, which every
  # modern host refuses. Without this the first download fails with a bare
  # "could not create SSL/TLS secure channel".
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  $base = $env:CR_TRACK_BASE
  if (-not $base) { $base = 'https://cr-track-dashboard.vercel.app' }
  $base = $base.TrimEnd('/')

  # Native commands and $ErrorActionPreference='Stop' do not mix in Windows
  # PowerShell: anything an .exe writes to stderr becomes a terminating
  # NativeCommandError, even on exit code 0. `code.cmd` prints a Node
  # deprecation warning, which killed this script mid-install. Every native
  # call goes through here, with the preference relaxed for its duration.
  function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = & $Exe @Arguments 2>&1 | Out-String
    } catch {
      $out = ''
    } finally {
      $ErrorActionPreference = $prev
    }
    return $out
  }

  function Get-CRTrackVersion {
    param([string]$Exe)
    $listed = Invoke-Native $Exe @('--list-extensions', '--show-versions')
    foreach ($line in ($listed -split "`r?`n")) {
      if ($line.Trim() -like 'ikonic.cr-track@*') { return $line.Trim().Split('@')[1] }
    }
    return ''
  }

  function Write-Step { param($m) Write-Host "==> " -ForegroundColor White -NoNewline; Write-Host $m }
  function Write-Note { param($m) Write-Host "    $m" -ForegroundColor DarkGray }
  function Write-Fail { param($m) Write-Host " error: " -ForegroundColor Red -NoNewline; Write-Host $m }

  Write-Host ""
  Write-Host "CR-Track" -ForegroundColor Cyan -NoNewline
  Write-Host " - reviews every commit with Claude" -ForegroundColor DarkGray
  Write-Host ""

  if ($base -like '*REPLACE_WITH_HOST*') {
    Write-Fail "This script was not configured with a download host."
    return
  }

  # ---- find the editor -------------------------------------------------
  Write-Step "Looking for VS Code"
  $code = $null
  if ($env:CODE_BIN) {
    $code = $env:CODE_BIN
  } else {
    foreach ($name in @('code', 'code-insiders', 'cursor', 'windsurf', 'codium')) {
      $cmd = Get-Command $name -ErrorAction SilentlyContinue
      if ($cmd) { $code = $cmd.Source; break }
    }
  }
  if (-not $code) {
    # VS Code's installer does not always add bin\ to PATH, and a machine where
    # it did not is indistinguishable from one with no VS Code at all unless we
    # look in the places the installer actually uses.
    $candidates = @(
      "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
      "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
      "${env:ProgramFiles(x86)}\Microsoft VS Code\bin\code.cmd",
      "$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
      "$env:ProgramFiles\Microsoft VS Code Insiders\bin\code-insiders.cmd",
      "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd",
      "$env:LOCALAPPDATA\Programs\Windsurf\bin\windsurf.cmd"
    )
    foreach ($p in $candidates) {
      if ($p -and (Test-Path $p)) { $code = $p; break }
    }
  }
  if (-not $code) {
    Write-Fail "VS Code was not found."
    Write-Note "If it is installed, open it and run:"
    Write-Note "  Ctrl+Shift+P -> 'Shell Command: Install code command in PATH'"
    Write-Note "Then run this installer again, or point at it directly:"
    Write-Note "  `$env:CODE_BIN = 'C:\path\to\code.cmd'"
    return
  }
  Write-Note $code

  # ---- what is available, what is installed ----------------------------
  Write-Step "Checking for the latest version"
  try {
    $remote = (Invoke-WebRequest -Uri "$base/version.txt" -UseBasicParsing -TimeoutSec 30).Content.Trim()
  } catch {
    Write-Fail "Could not reach $base - $($_.Exception.Message)"
    return
  }
  if (-not $remote) { Write-Fail "The server did not return a version."; return }
  Write-Note $remote

  $installed = Get-CRTrackVersion $code

  if ($installed -eq $remote -and $env:CR_TRACK_FORCE -ne '1') {
    Write-Host ""
    Write-Host "Already up to date" -ForegroundColor Green -NoNewline
    Write-Host " ($remote)."
    Write-Note "Reinstall anyway:  `$env:CR_TRACK_FORCE=1; irm $base/install.ps1 | iex"
    Write-Host ""
    return
  }

  # ---- download --------------------------------------------------------
  Write-Step "Downloading"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cr-track-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $vsix = Join-Path $tmp "cr-track-$remote.vsix"
  try {
    Invoke-WebRequest -Uri "$base/cr-track-latest.vsix" -OutFile $vsix -UseBasicParsing -TimeoutSec 120

    # A .vsix is a zip. Anything else means we saved an error page, and handing
    # that to VS Code fails several steps later with a baffling message.
    $head = [IO.File]::ReadAllBytes($vsix)[0..1]
    if ($head[0] -ne 0x50 -or $head[1] -ne 0x4B) {
      Write-Fail "The downloaded file is not a valid .vsix."
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      return
    }
    Write-Note ("{0:N0} bytes" -f (Get-Item $vsix).Length)

    # ---- install -------------------------------------------------------
    Write-Step "Installing"
    $installOutput = Invoke-Native $code @('--install-extension', $vsix, '--force')
    $now = Get-CRTrackVersion $code

    if (-not $now) {
      Write-Fail "The extension does not appear installed."
      Write-Note "VS Code said: $($installOutput.Trim())"
      Write-Note "Try manually: $code --install-extension $vsix --force"
      return
    }

    Write-Host ""
    Write-Host "Installed" -ForegroundColor Green -NoNewline
    Write-Host " CR-Track $now"
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # ---- the dependency people forget ------------------------------------
  $claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
  if (-not $claude) {
    $probe = @(
      "$env:USERPROFILE\.local\bin\claude.exe",
      "$env:APPDATA\npm\claude.cmd",
      "$env:LOCALAPPDATA\Programs\claude\claude.exe"
    )
    foreach ($p in $probe) { if (Test-Path $p) { $claude = $p; break } }
  }
  if (-not $claude) {
    # The editor extension bundles its own copy and puts nothing on PATH. This
    # is a perfectly good Claude and the commonest reason someone believes they
    # have one while every PATH lookup disagrees.
    $bundled = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory -Filter 'anthropic.claude-code*' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($bundled) { $claude = $bundled }
  }

  if ($claude) {
    Write-Note "Claude CLI: $claude"
  } else {
    Write-Host ""
    Write-Host " warning:" -ForegroundColor Yellow -NoNewline
    Write-Host " the Claude CLI was not found. CR-Track needs it to review"
    Write-Note "anything, and stays inactive without it:"
    Write-Note "  npm i -g @anthropic-ai/claude-code"
    Write-Note "  claude        # sign in once"
  }

  Write-Host ""
  Write-Host "Next:" -ForegroundColor White -NoNewline
  Write-Host " reload VS Code, then commit something."
  Write-Note "Ctrl+Shift+P -> Developer: Reload Window"
  Write-Host ""
}

Install-CRTrack
