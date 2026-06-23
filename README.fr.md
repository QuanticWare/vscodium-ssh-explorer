> 🌐 **Langue :** **Français** · [English](https://github.com/QuanticWare/vscodium-ssh-explorer/blob/main/README.md)

# SSH Explorer

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
- Accès **`root`** possible via une clé SSH dédiée à « commande forcée »
  (voir [Accès « root »](#accès--root--sur-le-serveur-distant-sftp-élevé)).
- Vue dédiée dans la barre d'activité listant les hôtes configurés.
- **Multilingue** : interface en **anglais** (langue par défaut) ou en **français**,
  selon la langue d'affichage de VSCodium (voir [Langues](#langues)).

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

## Accès « root » sur le serveur distant (SFTP élevé)

SFTP s'exécute **toujours avec les droits de l'utilisateur qui se connecte**. Le
sous-système SFTP standard d'OpenSSH ne sait pas faire de `sudo` : avec un compte
non privilégié, vous ne pouvez ni lire ni écrire les fichiers appartenant à
`root`. L'élévation se règle donc **au niveau de la connexion SSH**, pas dans
l'extension.

La méthode recommandée (propre, réversible, sans modifier `sshd_config` ni le
code de l'extension) : une **clé SSH dédiée à « commande forcée »**. Elle suppose
que votre utilisateur dispose de `sudo` (idéalement `NOPASSWD`) pour lancer
`sftp-server`.

### 1. Générer une clé dédiée (sans passphrase)

```bash
ssh-keygen -t ed25519 -N "" -C "monhote-root-sftp" \
  -f ~/.ssh/monhote_root_sftp_ed25519
```

### 2. Installer la commande forcée côté serveur

Dans le `~/.ssh/authorized_keys` de **votre** compte sur le serveur, ajoutez la
clé publique précédée des options qui forcent un `sftp-server` élevé et
n'autorisent **que** ça :

```
restrict,command="sudo /usr/lib/openssh/sftp-server" ssh-ed25519 AAAA…  monhote-root-sftp
```

- `command="sudo /usr/lib/openssh/sftp-server"` → toute connexion via **cette**
  clé lance le SFTP en `root` ;
- `restrict` → ni shell, ni pty, ni tunnel : cette clé ne sert qu'au SFTP élevé ;
- le chemin de `sftp-server` varie selon la distribution
  (`/usr/lib/openssh/sftp-server` sur Debian/Ubuntu,
  `/usr/libexec/openssh/sftp-server` sur RHEL/Fedora) ;
- vos autres clés (connexion normale) ne sont **pas** affectées.

> Prérequis sudo : `votreuser ALL=(ALL) NOPASSWD: /usr/lib/openssh/sftp-server`
> (ou `NOPASSWD: ALL`). Vérifiez avec `sudo -n -l`.

### 3. Déclarer un alias dédié dans `~/.ssh/config`

Convention de nommage : suffixer l'hôte d'origine par **`-sftp`**. Placez ce bloc
**avant** tout bloc générique `Host *` qui imposerait une autre `IdentityFile`,
sinon la clé du `Host *` serait proposée en premier et la commande forcée ne
s'appliquerait pas.

```sshconfig
# À placer en haut du fichier, avant "Host *"
Host monhote.example.com-sftp
  Hostname monhote.example.com
  User votreuser
  Port 22
  IdentityFile ~/.ssh/monhote_root_sftp_ed25519
  IdentitiesOnly yes
  IdentityAgent none
  PreferredAuthentications publickey
```

`IdentitiesOnly yes` + `IdentityAgent none` garantissent que **seule** la clé
dédiée est présentée (l'agent SSH ne glisse pas une autre clé en premier).

### 4. Utiliser dans l'extension

1. **SSH Explorer: Se connecter à un hôte** → choisir **`monhote.example.com-sftp`**.
2. Point de départ : **Racine du serveur (`/`)**.
3. Vous parcourez et éditez désormais **tout** le système de fichiers en `root`.

### Exemple complet

```sshconfig
# Connexion interactive habituelle (non privilégiée)
Host monhote.example.com
  Hostname 203.0.113.10
  User votreuser
  Port 22
  IdentityFile ~/.ssh/monhote_ed25519
  RemoteCommand sudo -s
  RequestTTY yes

# Accès SFTP élevé (root) — à placer AVANT "Host *"
Host monhote.example.com-sftp
  Hostname 203.0.113.10
  User votreuser
  Port 22
  IdentityFile ~/.ssh/monhote_root_sftp_ed25519
  IdentitiesOnly yes
  IdentityAgent none
  PreferredAuthentications publickey
```

Entrée correspondante dans le `~/.ssh/authorized_keys` de `votreuser` sur monhote :

```
restrict,command="sudo /usr/lib/openssh/sftp-server" ssh-ed25519 AAAA…  monhote-root-sftp
```

Dans l'extension, connectez-vous à **`monhote.example.com-sftp`**, démarrez sur
`/`, et vous éditez les fichiers de `root` (ex. `/etc/...`).

> 🚀 **Déploiement de flotte** : pour poser cette entrée `authorized_keys` (et la
> règle sudoers associée) sur tous les VPS d'un coup, un playbook Ansible est
> fourni dans `<your-ops-repo>/playbook/sftp_root_access.yml`
> (idempotent, mode `--check` pour simuler, `-e sftp_root_state=absent` pour
> révoquer).

### Révoquer l'accès

Supprimez simplement la ligne correspondante dans le `~/.ssh/authorized_keys`
distant (et, au besoin, la clé locale + l'alias). L'accès root disparaît
immédiatement.

> ⚠️ Cette clé ouvre un accès `root` en lecture/écriture au serveur : protégez le
> fichier `~/.ssh/<clé>` comme un secret et ne le copiez pas sur des machines non
> fiables.

## Paramètres

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| `sshExplorer.configPath` | `~/.ssh/config` | Fichier de config SSH à analyser |
| `sshExplorer.defaultRemotePath` | `.` | Dossier distant ouvert par défaut |
| `sshExplorer.connectTimeout` | `20000` | Timeout de connexion (ms) |
| `sshExplorer.keepaliveInterval` | `15000` | Keepalive (ms, 0 = off) |
| `sshExplorer.statCacheTtl` | `3000` | Cache des `stat` (ms, 0 = off) |

## Langues

L'extension est **bilingue anglais / français**. La langue suivie est celle de
**l'interface de VSCodium** (commande *« Configure Display Language »* /
*« Configurer la langue d'affichage »*) :

- **anglais** = langue de base (et repli pour toute autre locale) ;
- **français** = traduction complète des commandes, réglages et messages.

Concrètement :

- les libellés du manifeste (titres de commandes, descriptions des réglages) sont
  localisés via `package.nls.json` (anglais) et `package.nls.fr.json` (français) ;
- les messages du code (invites, erreurs, sélecteurs) passent par l'API native
  `vscode.l10n` ; les traductions vivent dans `l10n/bundle.l10n.fr.json`.

### Ajouter une langue

1. Dupliquer `package.nls.json` en `package.nls.<locale>.json` (ex. `de`, `es`)
   et traduire les valeurs.
2. Dupliquer `l10n/bundle.l10n.fr.json` en `l10n/bundle.l10n.<locale>.json` en
   conservant les **clés anglaises** et en traduisant les valeurs.
3. Reconstruire et repackager (`npm run package`).

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

## Crédits

Réalisée avec l'aide de [Claude Code](https://claude.com/claude-code) (Opus 4.8).
