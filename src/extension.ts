// Point d'entrée de l'extension : enregistre le FileSystemProvider SFTP, la vue
// des hôtes et les commandes permettant d'ouvrir une arborescence distante.
import * as vscode from "vscode";
import { SFTPWrapper } from "ssh2";
import { ConnectionManager } from "./connectionManager";
import { SftpFileSystemProvider } from "./sftpFileSystemProvider";
import { HostTreeProvider } from "./hostTreeView";
import { listHosts } from "./sshConfig";

export const SCHEME = "ssh";

interface ExtensionSettings {
  configPath: string;
  defaultRemotePath: string;
  connectTimeout: number;
  keepaliveInterval: number;
  statCacheTtl: number;
}

function readSettings(): ExtensionSettings {
  const c = vscode.workspace.getConfiguration("sshExplorer");
  return {
    configPath: c.get<string>("configPath", "~/.ssh/config"),
    defaultRemotePath: c.get<string>("defaultRemotePath", "."),
    connectTimeout: c.get<number>("connectTimeout", 20000),
    keepaliveInterval: c.get<number>("keepaliveInterval", 15000),
    statCacheTtl: c.get<number>("statCacheTtl", 3000),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  let settings = readSettings();

  const manager = new ConnectionManager(settings);
  const provider = new SftpFileSystemProvider(manager, () => settings.statCacheTtl);
  const hostTree = new HostTreeProvider(() => settings.configPath);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
    }),
    vscode.window.registerTreeDataProvider("sshExplorerHosts", hostTree),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sshExplorer")) {
        settings = readSettings();
        manager.updateSettings(settings);
        hostTree.refresh();
      }
    })
  );

  // --- Commandes ----------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand("sshExplorer.connect", (alias?: string) =>
      connectCommand(manager, settings, alias, "choose")
    ),
    vscode.commands.registerCommand("sshExplorer.openFolder", (alias?: string) =>
      connectCommand(manager, settings, alias, "prompt")
    ),
    vscode.commands.registerCommand("sshExplorer.openParent", (uri?: vscode.Uri) =>
      openParentCommand(uri)
    ),
    vscode.commands.registerCommand("sshExplorer.disconnect", () =>
      disconnectCommand(manager)
    ),
    vscode.commands.registerCommand("sshExplorer.refreshHosts", () => hostTree.refresh())
  );
}

export async function deactivate(): Promise<void> {
  // Le ConnectionManager est référencé via les closures des commandes ; les
  // connexions ouvertes seront fermées par la fin du processus de l'hôte
  // d'extension. (Voir disconnectAll pour une fermeture explicite si besoin.)
}

// --- Implémentation des commandes -----------------------------------------

/**
 * Sélectionne un hôte (ou utilise `alias`), détermine le dossier distant de
 * départ puis l'ajoute comme dossier du workspace via une URI `ssh://`.
 *
 * `mode` :
 *  - "choose" : propose Dossier personnel / Racine du serveur / Chemin perso ;
 *  - "prompt" : demande directement un chemin (champ libre).
 */
async function connectCommand(
  manager: ConnectionManager,
  settings: ExtensionSettings,
  alias?: string,
  mode: "choose" | "prompt" = "choose"
): Promise<void> {
  let target = alias;
  if (!target) {
    const hosts = listHosts(settings.configPath);
    if (hosts.length === 0) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("SSH Explorer: no host found in {0}.", settings.configPath)
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      hosts.map((h) => ({
        label: h.alias,
        description: `${h.user ? h.user + "@" : ""}${h.hostName}:${h.port}`,
        detail: h.proxyJump ? `via ${h.proxyJump}` : undefined,
        alias: h.alias,
      })),
      { placeHolder: vscode.l10n.t("Pick an SSH host to open"), matchOnDescription: true }
    );
    if (!pick) {
      return;
    }
    target = pick.alias;
  }

  const remotePath =
    mode === "prompt"
      ? await promptRemotePath(target, settings.defaultRemotePath || ".")
      : await pickStartPath(target, settings.defaultRemotePath || ".");
  if (remotePath === undefined) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Connecting to {0}…", target!),
    },
    async () => {
      try {
        const sftp = await manager.getSftp(target!);
        const absolute = await realpath(sftp, remotePath);
        addWorkspaceFolder(target!, absolute);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "SSH Explorer: cannot connect to {0} — {1}",
            target!,
            String(err?.message ?? err)
          )
        );
      }
    }
  );
}

/** Demande quel dossier distant fermer puis le retire du workspace. */
async function disconnectCommand(manager: ConnectionManager): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (f) => f.uri.scheme === SCHEME
  );
  if (folders.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("SSH Explorer: no remote folder open.")
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.toString(), folder: f })),
    { placeHolder: vscode.l10n.t("Remote folder to close") }
  );
  if (!pick) {
    return;
  }
  await manager.disconnect(pick.folder.uri.authority);
  vscode.workspace.updateWorkspaceFolders(pick.folder.index, 1);
}

/**
 * Ajoute le dossier parent d'un dossier distant à l'espace de travail, ce qui
 * permet de « remonter » dans l'arborescence du serveur (VS Code n'autorise pas
 * la navigation au-dessus de la racine d'un dossier de workspace).
 * `uri` est fourni lors d'un clic droit dans l'explorateur ; sinon on demande.
 */
async function openParentCommand(uri?: vscode.Uri): Promise<void> {
  let folderUri = uri;
  if (!folderUri || folderUri.scheme !== SCHEME) {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (f) => f.uri.scheme === SCHEME
    );
    if (folders.length === 0) {
      vscode.window.showInformationMessage(
      vscode.l10n.t("SSH Explorer: no remote folder open.")
    );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.toString(), uri: f.uri })),
      { placeHolder: vscode.l10n.t("Remote folder whose parent to open") }
    );
    if (!pick) {
      return;
    }
    folderUri = pick.uri;
  }

  const parent = parentOf(folderUri.path);
  if (parent === folderUri.path) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("SSH Explorer: {0} is already at the root (/).", folderUri.authority)
    );
    return;
  }
  addWorkspaceFolder(folderUri.authority, parent);
}

// --- Utilitaires ----------------------------------------------------------

/**
 * Propose un point de départ : dossier personnel, racine du serveur (`/`) ou
 * chemin saisi librement. Retourne le chemin choisi, ou `undefined` si annulé.
 */
async function pickStartPath(
  alias: string,
  homePath: string
): Promise<string | undefined> {
  const CUSTOM = "__custom__";
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: vscode.l10n.t("$(home) Home folder"),
        description: homePath,
        value: homePath,
      },
      { label: vscode.l10n.t("$(folder-library) Server root"), description: "/", value: "/" },
      { label: vscode.l10n.t("$(edit) Custom path…"), description: "", value: CUSTOM },
    ],
    { placeHolder: vscode.l10n.t("Which folder to open on {0}?", alias) }
  );
  if (!choice) {
    return undefined;
  }
  if (choice.value === CUSTOM) {
    return promptRemotePath(alias, homePath);
  }
  return choice.value;
}

/** Demande librement un chemin distant à ouvrir. */
async function promptRemotePath(
  alias: string,
  defaultPath: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: vscode.l10n.t("Remote folder to open on {0}", alias),
    value: defaultPath,
    ignoreFocusOut: true,
  });
}

/** Calcule le dossier parent d'un chemin POSIX absolu (`/` reste `/`). */
function parentOf(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) {
    return "/";
  }
  return trimmed.slice(0, idx);
}

/** Résout un chemin distant (éventuellement relatif comme ".") en absolu. */
function realpath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.realpath(remotePath, (err, absolute) => {
      if (err) {
        reject(err);
      } else {
        resolve(absolute);
      }
    });
  });
}

/** Ajoute un dossier distant à la fin de la liste des dossiers du workspace. */
function addWorkspaceFolder(alias: string, absolutePath: string): void {
  const uri = vscode.Uri.from({ scheme: SCHEME, authority: alias, path: absolutePath });
  const existing = vscode.workspace.workspaceFolders ?? [];
  if (existing.some((f) => f.uri.toString() === uri.toString())) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("SSH Explorer: {0} is already open.", alias)
    );
    return;
  }
  const name = `SSH ${alias}${absolutePath === "/" ? "" : " " + absolutePath}`;
  vscode.workspace.updateWorkspaceFolders(existing.length, 0, { uri, name });
}
