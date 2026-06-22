// Vue de la barre d'activité listant les hôtes déclarés dans ~/.ssh/config.
// Un clic (ou l'action inline) déclenche la connexion à l'hôte correspondant.
import * as vscode from "vscode";
import { SshHost, listHosts } from "./sshConfig";

export class HostTreeItem extends vscode.TreeItem {
  constructor(public readonly host: SshHost) {
    super(host.alias, vscode.TreeItemCollapsibleState.None);
    const user = host.user ? `${host.user}@` : "";
    this.description = `${user}${host.hostName}:${host.port}`;
    this.tooltip = host.proxyJump
      ? `${this.description} (via ${host.proxyJump})`
      : this.description;
    this.iconPath = new vscode.ThemeIcon("server");
    this.contextValue = "sshHost";
    this.command = {
      command: "sshExplorer.connect",
      title: "Se connecter",
      arguments: [host.alias],
    };
  }
}

export class HostTreeProvider implements vscode.TreeDataProvider<HostTreeItem> {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(private readonly getConfigPath: () => string) {}

  refresh(): void {
    this._emitter.fire();
  }

  getTreeItem(element: HostTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): HostTreeItem[] {
    try {
      return listHosts(this.getConfigPath()).map((h) => new HostTreeItem(h));
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `SSH Explorer: lecture de la configuration impossible — ${err?.message ?? err}`
      );
      return [];
    }
  }
}
