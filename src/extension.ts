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
      connectCommand(manager, settings, alias)
    ),
    vscode.commands.registerCommand("sshExplorer.openFolder", (alias?: string) =>
      connectCommand(manager, settings, alias, true)
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
 * Sélectionne un hôte (ou utilise `alias`), demande le dossier distant puis
 * l'ajoute comme dossier du workspace via une URI `ssh://`.
 */
async function connectCommand(
  manager: ConnectionManager,
  settings: ExtensionSettings,
  alias?: string,
  askPath = false
): Promise<void> {
  let target = alias;
  if (!target) {
    const hosts = listHosts(settings.configPath);
    if (hosts.length === 0) {
      vscode.window.showWarningMessage(
        `SSH Explorer: aucun hôte trouvé dans ${settings.configPath}.`
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
      { placeHolder: "Choisir un hôte SSH à ouvrir", matchOnDescription: true }
    );
    if (!pick) {
      return;
    }
    target = pick.alias;
  }

  let remotePath = settings.defaultRemotePath || ".";
  if (askPath) {
    const input = await vscode.window.showInputBox({
      prompt: `Dossier distant à ouvrir sur ${target}`,
      value: remotePath,
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return;
    }
    remotePath = input;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connexion à ${target}…` },
    async () => {
      try {
        const sftp = await manager.getSftp(target!);
        const absolute = await realpath(sftp, remotePath);
        addWorkspaceFolder(target!, absolute);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `SSH Explorer: connexion à ${target} impossible — ${err?.message ?? err}`
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
    vscode.window.showInformationMessage("SSH Explorer: aucun dossier distant ouvert.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.toString(), folder: f })),
    { placeHolder: "Dossier distant à fermer" }
  );
  if (!pick) {
    return;
  }
  await manager.disconnect(pick.folder.uri.authority);
  vscode.workspace.updateWorkspaceFolders(pick.folder.index, 1);
}

// --- Utilitaires ----------------------------------------------------------

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
    vscode.window.showInformationMessage(`SSH Explorer: ${alias} est déjà ouvert.`);
    return;
  }
  const name = `SSH ${alias}${absolutePath === "/" ? "" : " " + absolutePath}`;
  vscode.workspace.updateWorkspaceFolders(existing.length, 0, { uri, name });
}
