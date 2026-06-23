> 🌐 **Language:** **English** · [Français](https://github.com/QuanticWare/vscodium-ssh-explorer/blob/main/README.fr.md)

# SSH Explorer

Browse a **remote server's file tree** directly in the VSCodium explorer over
**SSH/SFTP**, driven by your **`~/.ssh/config`** file. Nothing to install on the
remote side: plain SSH access is enough.

> Built for **VSCodium**, where Microsoft's official *Remote - SSH* extension
> does not work. Also compatible with VS Code (identical API).

## Features

- Host list read from `~/.ssh/config` (resolves `HostName`, `User`, `Port`,
  `IdentityFile`, `ProxyJump`).
- Remote tree mounted under `ssh://<host>/<path>` URIs via an SFTP
  `FileSystemProvider` — **read and write** files.
- Authentication: SSH agent (`SSH_AUTH_SOCK`), private key (with passphrase
  prompt if encrypted), password / keyboard-interactive.
- Single `ProxyJump` hop (bastion) supported.
- **`root`** access possible through a dedicated "forced-command" SSH key
  (see [Root access](#root-access-on-the-remote-server-elevated-sftp)).
- Dedicated Activity Bar view listing the configured hosts.
- **Multilingual**: interface in **English** (default language) or **French**,
  following VSCodium's display language (see [Languages](#languages)).

## Usage

1. Open the Command Palette (`Ctrl/Cmd+Shift+P`).
2. Run **"SSH Explorer: Connect to Host"**.
3. Pick a host from your `~/.ssh/config`, then the **starting point**:
   - **Home folder** (`~`),
   - **Server root** (`/`) — to browse the *whole* tree,
   - **Custom path…**.

The tree shows up as a workspace folder; open/edit/create your files as usual.

### Browsing the whole server

VS Code/VSCodium does not let you go above the root of a workspace folder. To
explore the entire server:

- open the **Server root (`/`)** directly on connect, **or**
- **right-click** a remote folder → **"SSH Explorer: Open Parent Folder"** to add
  its parent folder.

## Root access on the remote server (elevated SFTP)

SFTP **always runs with the privileges of the connecting user**. OpenSSH's
standard SFTP subsystem cannot `sudo`: with an unprivileged account you can
neither read nor write files owned by `root`. Elevation is therefore handled
**at the SSH connection level**, not inside the extension.

The recommended approach (clean, reversible, without touching `sshd_config` or
the extension's code): a **dedicated "forced-command" SSH key**. It assumes your
user has `sudo` (ideally `NOPASSWD`) to launch `sftp-server`.

### 1. Generate a dedicated key (no passphrase)

```bash
ssh-keygen -t ed25519 -N "" -C "myhost-root-sftp" \
  -f ~/.ssh/myhost_root_sftp_ed25519
```

### 2. Install the forced command on the server

In **your** account's `~/.ssh/authorized_keys` on the server, add the public key
prefixed with the options that force an elevated `sftp-server` and allow **only**
that:

```
restrict,command="sudo /usr/lib/openssh/sftp-server" ssh-ed25519 AAAA…  myhost-root-sftp
```

- `command="sudo /usr/lib/openssh/sftp-server"` → any connection using **this**
  key launches SFTP as `root`;
- `restrict` → no shell, pty, or tunnel: this key is for elevated SFTP only;
- the `sftp-server` path varies by distribution
  (`/usr/lib/openssh/sftp-server` on Debian/Ubuntu,
  `/usr/libexec/openssh/sftp-server` on RHEL/Fedora);
- your other keys (normal login) are **not** affected.

> sudo prerequisite: `youruser ALL=(ALL) NOPASSWD: /usr/lib/openssh/sftp-server`
> (or `NOPASSWD: ALL`). Check with `sudo -n -l`.

### 3. Declare a dedicated alias in `~/.ssh/config`

Naming convention: suffix the original host with **`-sftp`**. Place this block
**before** any generic `Host *` block that would impose another `IdentityFile`,
otherwise the `Host *` key would be offered first and the forced command would
not apply.

```sshconfig
# Put it at the top of the file, before "Host *"
Host myhost.example.com-sftp
  Hostname myhost.example.com
  User youruser
  Port 22
  IdentityFile ~/.ssh/myhost_root_sftp_ed25519
  IdentitiesOnly yes
  IdentityAgent none
  PreferredAuthentications publickey
```

`IdentitiesOnly yes` + `IdentityAgent none` guarantee that **only** the dedicated
key is presented (the SSH agent won't slip another key in first).

### 4. Use it in the extension

1. **SSH Explorer: Connect to Host** → pick **`myhost.example.com-sftp`**.
2. Starting point: **Server root (`/`)**.
3. You now browse and edit the **whole** filesystem as `root`.

### Real-world example (host `myhost.example.com`)

```sshconfig
# Usual interactive (unprivileged) login
Host myhost.example.com
  Hostname 203.0.113.10
  User youruser
  Port 22
  IdentityFile ~/.ssh/myhost_ed25519
  RemoteCommand sudo -s
  RequestTTY yes

# Elevated (root) SFTP access — put BEFORE "Host *"
Host myhost.example.com-sftp
  Hostname 203.0.113.10
  User youruser
  Port 22
  IdentityFile ~/.ssh/myhost_root_sftp_ed25519
  IdentitiesOnly yes
  IdentityAgent none
  PreferredAuthentications publickey
```

Matching entry in `youruser`'s `~/.ssh/authorized_keys` on myhost:

```
restrict,command="sudo /usr/lib/openssh/sftp-server" ssh-ed25519 AAAA…  myhost-root-sftp
```

In the extension, connect to **`myhost.example.com-sftp`**, start at `/`, and
you edit `root`'s files (e.g. `/etc/...`).

> 🚀 **Fleet deployment**: to push this `authorized_keys` entry (and the matching
> sudoers rule) to all your VPS at once, an Ansible playbook is provided in
> `<your-ops-repo>/playbook/sftp_root_access.yml` (idempotent, `--check`
> mode to simulate, `-e sftp_root_state=absent` to revoke).

### Revoking access

Just remove the corresponding line from the remote `~/.ssh/authorized_keys` (and,
if needed, the local key + alias). Root access disappears immediately.

> ⚠️ This key grants read/write `root` access to the server: protect the
> `~/.ssh/<key>` file like a secret and do not copy it to untrusted machines.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sshExplorer.configPath` | `~/.ssh/config` | SSH config file to parse |
| `sshExplorer.defaultRemotePath` | `.` | Remote folder opened by default |
| `sshExplorer.connectTimeout` | `20000` | Connection timeout (ms) |
| `sshExplorer.keepaliveInterval` | `15000` | Keepalive (ms, 0 = off) |
| `sshExplorer.statCacheTtl` | `3000` | `stat` cache (ms, 0 = off) |

## Languages

The extension is **bilingual English / French**. The language it follows is
**VSCodium's UI language** (*"Configure Display Language"* command):

- **English** = base language (and fallback for any other locale);
- **French** = full translation of commands, settings and messages.

In practice:

- manifest labels (command titles, setting descriptions) are localized via
  `package.nls.json` (English) and `package.nls.fr.json` (French);
- code messages (prompts, errors, pickers) go through the native `vscode.l10n`
  API; the translations live in `l10n/bundle.l10n.fr.json`.

### Adding a language

1. Duplicate `package.nls.json` to `package.nls.<locale>.json` (e.g. `de`, `es`)
   and translate the values.
2. Duplicate `l10n/bundle.l10n.fr.json` to `l10n/bundle.l10n.<locale>.json`,
   keeping the **English keys** and translating the values.
3. Rebuild and repackage (`npm run package`).

## Development

```bash
npm install
npm run compile        # esbuild bundle -> dist/extension.js
# F5 in VSCodium to launch an Extension Development Host
npm run package        # builds the .vsix
```

## Limitations (MVP)

- No remote extension execution or remote terminal ("FileSystemProvider"
  approach, not "Remote Server").
- No real-time file watching (`watch` is a no-op).
- Single `ProxyJump` level.

## License

MIT

## Credits

Built with the help of [Claude Code](https://claude.com/claude-code) (Opus 4.8).
