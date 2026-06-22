# SSH Explorer (VSCodium)

Ouvre l'**arborescence d'un serveur distant** directement dans l'explorateur de
VSCodium via **SSH/SFTP**, en se basant sur votre fichier **`~/.ssh/config`**.
Aucun agent ni serveur à installer côté distant : un simple accès SSH suffit.

> Conçue pour **VSCodium**, où l'extension officielle *Remote - SSH* de Microsoft
> ne fonctionne pas. Compatible VS Code également (API identique).

## Fonctionnalités

- Liste des hôtes lue depuis `~/.ssh/config` (résolution de `HostName`, `User`,
  `Port`, `IdentityFile`, `ProxyJump`).
- Montage de l'arborescence distante sous des URI `ssh://<hôte>/<chemin>` via un
  `FileSystemProvider` SFTP — lecture **et** écriture des fichiers.
- Authentification : agent SSH (`SSH_AUTH_SOCK`), clé privée (avec invite de
  passphrase si chiffrée), mot de passe / clavier-interactif.
- Support d'un saut `ProxyJump` (bastion).
- Vue dédiée dans la barre d'activité listant les hôtes configurés.

## Utilisation

1. Ouvrir la palette de commandes (`Ctrl/Cmd+Shift+P`).
2. Lancer **« SSH Explorer: Se connecter à un hôte »**.
3. Choisir un hôte de votre `~/.ssh/config`, puis le **point de départ** :
   - **Dossier personnel** (`~`),
   - **Racine du serveur** (`/`) — pour parcourir *toute* l'arborescence,
   - **Chemin personnalisé…**.

L'arborescence apparaît comme un dossier du workspace ; ouvrez/modifiez/créez vos
fichiers normalement.

### Parcourir tout le serveur

VS Code/VSCodium ne permet pas de remonter au-dessus de la racine d'un dossier de
workspace. Pour explorer l'ensemble du serveur :

- ouvrez directement la **Racine du serveur (`/`)** à la connexion, **ou**
- faites un **clic droit** sur un dossier distant → **« SSH Explorer: Remonter au
  dossier parent »** pour ajouter son dossier parent.

## Paramètres

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| `sshExplorer.configPath` | `~/.ssh/config` | Fichier de config SSH à analyser |
| `sshExplorer.defaultRemotePath` | `.` | Dossier distant ouvert par défaut |
| `sshExplorer.connectTimeout` | `20000` | Timeout de connexion (ms) |
| `sshExplorer.keepaliveInterval` | `15000` | Keepalive (ms, 0 = off) |
| `sshExplorer.statCacheTtl` | `3000` | Cache des `stat` (ms, 0 = off) |

## Développement

```bash
npm install
npm run compile        # bundle esbuild -> dist/extension.js
# F5 dans VSCodium pour lancer un Extension Development Host
npm run package        # génère le .vsix
```

## Limites (MVP)

- Pas d'exécution distante d'extensions ni de terminal distant (approche
  « FileSystemProvider », pas « Remote Server »).
- Pas de surveillance temps réel des fichiers (`watch` no-op).
- Un seul niveau de `ProxyJump`.

## Licence

MIT
