# Hosting CR-Track yourself

Everything needed to serve the extension from your own origin. Drop these files
where they are reachable over HTTPS and change one line in each installer.

## There is no separate Linux installer — `install.sh` is both

macOS and Linux run the same script. It detects the platform it is on and looks
in the right places for each: the `.app` bundle on macOS, and on Linux the
distribution package, Snap, Flatpak, and a tarball in `/opt`. The palette
shortcut it prints follows suit — `Cmd` on macOS, `Ctrl` on Linux.

So there are two installers, not three:

| Platform | File |
|---|---|
| Windows | `install.ps1` |
| **macOS and Linux** | `install.sh` |

## What to serve

Four of these are **fetched by the installers**, so they must be reachable at
exactly these paths:

| Path | Why |
|---|---|
| `/version.txt` | The installer compares this against what is installed. Plain text, the version and nothing else. |
| `/cr-track-latest.vsix` | The extension itself. Always the current build. |
| `/install.ps1` | What Windows users pipe into PowerShell. |
| `/install.sh` | What macOS and Linux users pipe into bash. |

`doctor.ps1` and `doctor.sh` are optional but worth serving — they tell a
developer which precondition failed when the extension says it is inactive, and
save you the support conversation.

## The one line to change

Both installers have a marked block near the top. Set it to your origin:

**`install.ps1`**
```powershell
if (-not $base) { $base = 'https://your-host.example.com' }
```

**`install.sh`**
```bash
BASE="${CR_TRACK_BASE:-https://your-host.example.com}"
```

Do the same in `doctor.ps1` and `doctor.sh` if you serve them. Nothing else in
any of the four files needs touching.

No trailing slash. The installers strip one if it is there, but the doctor
scripts print the URL back to the user and a doubled slash looks like a mistake.

## Then this is what your team runs

```powershell
irm https://your-host.example.com/install.ps1 | iex
```

```bash
curl -fsSL https://your-host.example.com/install.sh | bash
```

Use the right one per platform. On Windows `bash` resolves to WSL's bash, so the
curl form fails with "no installed distributions" on any machine without a WSL
distro — which is most of them.

Re-running the same command is also how people update.

## Serving requirements

- **HTTPS.** `irm` and `curl -fsSL` will both refuse or warn otherwise, and
  PowerShell 5.1 negotiates TLS 1.2 only because the script asks it to.
- **`cr-track-latest.vsix` must be served as bytes**, not transformed. The
  installer checks the first two bytes are `PK` and refuses anything else, which
  is what catches a proxy that returns an HTML error page with a 200.
- **No auth in front of these paths.** The installer is not a browser and will
  not follow a login redirect.

## The Update button

The extension has an update button in its Findings panel — a developer clicks it
and gets whatever you have published. It downloads from `crTrack.updateHost`,
which is **not** the dashboard setting, so point it at your origin:

```jsonc
// settings.json, or push it as a workspace/org setting
"crTrack.updateHost": "https://your-host.example.com"
```

Left unset it points at our host, and your team would update to a build you did
not publish. It reads the same `version.txt` and `cr-track-latest.vsix` the
installers use, so nothing extra needs serving.

## Publishing a new version

Replace `cr-track-latest.vsix`, write the new version into `version.txt`, done.
The URL never changes, so nobody needs new instructions — re-running the install
command picks it up.

Keep the two in step. `version.txt` is what the installer trusts when deciding
whether an update is needed, so a stale one means nobody upgrades and nothing
appears wrong.

## After installing

Two steps the installer cannot do:

1. **Reload VS Code** — `Ctrl+Shift+P` → *Developer: Reload Window*. Until then
   the previously loaded version keeps running, which looks exactly like the
   install not working.
2. **Set an ingest token** — the key icon in the Findings panel, or
   `Ctrl+Shift+P` → *CR-Track: Set ingest token*. Tokens are per developer.
   Without one, reviews still run and stay on disk but nothing is recorded.

The extension also needs the **Claude CLI** (`npm i -g @anthropic-ai/claude-code`,
then `claude` once to sign in). Reviews run on the developer's own machine and
bill to their own Claude account.
