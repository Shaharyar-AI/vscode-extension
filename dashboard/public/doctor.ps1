# CR-Track doctor for Windows PowerShell — answers "why does it say inactive?"
#
#   irm https://cr-track-dashboard.vercel.app/doctor.ps1 | iex
#
# Checks every precondition the extension checks, in the same order, and prints
# the fix for whichever one fails. Read-only: it changes nothing.

function Test-CRTrack {
  [CmdletBinding()]
  param()

  $script:problems = 0
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

  function Show-Ok   { param($m) Write-Host "  ok   " -ForegroundColor Green -NoNewline; Write-Host $m }
  function Show-Bad  { param($m) $script:problems++; Write-Host "  FAIL " -ForegroundColor Red -NoNewline; Write-Host $m }
  function Show-Warn { param($m) Write-Host "  warn " -ForegroundColor Yellow -NoNewline; Write-Host $m }
  function Show-Note { param($m) Write-Host "       $m" -ForegroundColor DarkGray }

  Write-Host ""
  Write-Host "CR-Track doctor" -ForegroundColor Cyan
  Write-Host ""

  # ---- 1. the editor ---------------------------------------------------
  Write-Host "VS Code" -ForegroundColor White
  $code = $null
  foreach ($name in @('code', 'code-insiders', 'cursor', 'windsurf', 'codium')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $code = $cmd.Source; break }
  }
  if (-not $code) {
    foreach ($p in @(
      "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
      "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
      "${env:ProgramFiles(x86)}\Microsoft VS Code\bin\code.cmd")) {
      if ($p -and (Test-Path $p)) { $code = $p; break }
    }
  }
  if ($code) {
    Show-Ok "found: $code"
    $installed = Get-CRTrackVersion $code
    if ($installed) { Show-Ok "CR-Track $installed is installed" }
    else { Show-Bad "CR-Track is not installed in this editor" }
  } else {
    Show-Bad "no VS Code CLI found"
    Show-Note "VS Code -> Ctrl+Shift+P -> 'Shell Command: Install code command in PATH'"
  }

  # ---- 2. the Claude CLI -----------------------------------------------
  Write-Host ""
  Write-Host "Claude CLI" -ForegroundColor White -NoNewline
  Write-Host "   (the usual cause of `"inactive`")" -ForegroundColor DarkGray

  $claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
  $source = "PATH"
  if (-not $claude) {
    foreach ($p in @(
      "$env:USERPROFILE\.local\bin\claude.exe",
      "$env:APPDATA\npm\claude.cmd",
      "$env:LOCALAPPDATA\Programs\claude\claude.exe",
      "$env:USERPROFILE\.claude\local\claude.exe")) {
      if (Test-Path $p) { $claude = $p; $source = "a CLI install"; break }
    }
  }
  if (-not $claude) {
    $bundled = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory -Filter 'anthropic.claude-code*' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($bundled) { $claude = $bundled; $source = "the Claude Code editor extension" }
  }

  if ($claude) {
    Show-Ok "$claude"
    Show-Note "found via $source"
    $ver = (Invoke-Native $claude @('--version')).Trim()
    if ($ver) { Show-Ok "reports: $ver" }
    else { Show-Bad "it exists but did not answer --version"; Show-Note "Run it yourself: & '$claude' --version" }
    if ($source -eq "the Claude Code editor extension") {
      Show-Note "CR-Track 0.4.3+ searches this location. Older builds do not -"
      Show-Note "update, or set crTrack.claudePath to the path above."
    }
  } else {
    Show-Bad "no claude binary found anywhere this script looked"
    Show-Note "Install:  npm i -g @anthropic-ai/claude-code   then:  claude"
  }

  # ---- 3. git and a repository -----------------------------------------
  Write-Host ""
  Write-Host "Git" -ForegroundColor White
  $git = (Get-Command git -ErrorAction SilentlyContinue).Source
  if ($git) {
    Show-Ok "$git - $((Invoke-Native $git @('--version')).Trim())"
    $inside = (Invoke-Native $git @('rev-parse', '--is-inside-work-tree')).Trim() -eq 'true' 
    if ($inside) {
      Show-Ok "this folder is a git repository"
      $head = (Invoke-Native $git @('rev-parse', '--short', 'HEAD')).Trim()
      if ($head) { Show-Ok "it has commits ($head)" }
      else { Show-Warn "no commits yet - the first one will be reviewed" }
    } else {
      Show-Warn "you are not inside a git repository right now"
      Show-Note "CR-Track activates on folders that are. Run this from your project."
    }
  } else {
    Show-Bad "git is not on PATH"
  }

  # ---- verdict ---------------------------------------------------------
  Write-Host ""
  if ($script:problems -eq 0) {
    Write-Host "Nothing blocking found." -ForegroundColor Green
    Show-Note "If it still says inactive: open the project in VS Code, then"
    Show-Note "Ctrl+Shift+P -> 'CR-Track: Re-detect Claude CLI and repositories'."
    Show-Note "Still stuck? Ctrl+Shift+P -> 'CR-Track: Diagnose' and send that output."
  } else {
    Write-Host "$($script:problems) problem(s) above." -ForegroundColor Red -NoNewline
    Write-Host " Fix those, then reload VS Code."
  }
  Write-Host ""
}

Test-CRTrack
