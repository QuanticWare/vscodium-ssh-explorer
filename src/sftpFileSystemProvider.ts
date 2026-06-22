// FileSystemProvider exposant une arborescence distante via SFTP.
//
// Les URI ont la forme `ssh://<alias>/<chemin absolu distant>` :
//   - `uri.authority` = alias de l'hôte (clé de connexion dans ~/.ssh/config),
//   - `uri.path`      = chemin absolu sur le serveur distant.
import * as vscode from "vscode";
import { SFTPWrapper } from "ssh2";
import { ConnectionManager } from "./connectionManager";

/** Promisifie une opération SFTP basée sur un callback (err, result). */
function p<T>(fn: (cb: (err: any, res: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((err, res) => (err ? reject(err) : resolve(res)));
  });
}

/** Traduit une erreur SFTP en erreur de système de fichiers VS Code. */
function toFsError(err: any, uri: vscode.Uri): vscode.FileSystemError {
  const code = err && err.code;
  const msg = String((err && err.message) || "").toLowerCase();
  // Code SFTP 2 = SSH_FX_NO_SUCH_FILE, 3 = SSH_FX_PERMISSION_DENIED.
  if (code === 2 || msg.includes("no such file")) {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (code === 3 || msg.includes("permission denied")) {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  return new vscode.FileSystemError(`${uri.toString()}: ${err?.message ?? err}`);
}

interface StatCacheItem {
  stat: vscode.FileStat;
  expires: number;
}

export class SftpFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  private readonly statCache = new Map<string, StatCacheItem>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly getStatCacheTtl: () => number
  ) {}

  // --- Connexion ----------------------------------------------------------

  private sftp(uri: vscode.Uri): Promise<SFTPWrapper> {
    return this.manager.getSftp(uri.authority);
  }

  // --- Lecture ------------------------------------------------------------

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.toString();
    const ttl = this.getStatCacheTtl();
    const cached = this.statCache.get(key);
    if (cached && ttl > 0 && cached.expires > Date.now()) {
      return cached.stat;
    }

    const sftp = await this.sftp(uri);
    try {
      const attrs: any = await p((cb) => sftp.lstat(uri.path, cb));
      let type = this.fileType(attrs);

      // Pour un lien symbolique, on suit la cible afin d'exposer le bon type
      // tout en conservant le marqueur SymbolicLink.
      if (attrs.isSymbolicLink && attrs.isSymbolicLink()) {
        try {
          const target: any = await p((cb) => sftp.stat(uri.path, cb));
          type = this.fileType(target) | vscode.FileType.SymbolicLink;
        } catch {
          type = vscode.FileType.SymbolicLink;
        }
      }

      const stat: vscode.FileStat = {
        type,
        ctime: (attrs.mtime ?? 0) * 1000,
        mtime: (attrs.mtime ?? 0) * 1000,
        size: attrs.size ?? 0,
      };
      if (ttl > 0) {
        this.statCache.set(key, { stat, expires: Date.now() + ttl });
      }
      return stat;
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const sftp = await this.sftp(uri);
    try {
      const list: any[] = await p((cb) => sftp.readdir(uri.path, cb));
      return list.map((entry) => [entry.filename, this.fileType(entry.attrs)]);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const sftp = await this.sftp(uri);
    try {
      const buffer: Buffer = await p((cb) => sftp.readFile(uri.path, cb));
      return new Uint8Array(buffer);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  // --- Écriture -----------------------------------------------------------

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const sftp = await this.sftp(uri);
    let exists = true;
    try {
      await p((cb) => sftp.lstat(uri.path, cb));
    } catch {
      exists = false;
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    try {
      await p<void>((cb) =>
        sftp.writeFile(uri.path, Buffer.from(content), (err: any) => cb(err, undefined))
      );
    } catch (err) {
      throw toFsError(err, uri);
    }
    this.invalidate(uri);
    this._emitter.fire([
      { type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const sftp = await this.sftp(uri);
    try {
      await p<void>((cb) => sftp.mkdir(uri.path, (err: any) => cb(err, undefined)));
    } catch (err) {
      throw toFsError(err, uri);
    }
    this.invalidate(uri);
    this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const sftp = await this.sftp(uri);
    try {
      await this.deletePath(sftp, uri.path, options.recursive);
    } catch (err) {
      throw toFsError(err, uri);
    }
    this.invalidate(uri);
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean }
  ): Promise<void> {
    const sftp = await this.sftp(oldUri);
    try {
      if (options.overwrite) {
        // SFTP rename échoue si la cible existe : on la supprime au préalable.
        try {
          await this.deletePath(sftp, newUri.path, true);
        } catch {
          /* la cible n'existait pas */
        }
      }
      await p<void>((cb) =>
        sftp.rename(oldUri.path, newUri.path, (err: any) => cb(err, undefined))
      );
    } catch (err) {
      throw toFsError(err, oldUri);
    }
    this.invalidate(oldUri);
    this.invalidate(newUri);
    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  // --- Surveillance (non supportée par SFTP) ------------------------------

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  // --- Utilitaires --------------------------------------------------------

  /** Convertit les attributs SFTP en FileType VS Code. */
  private fileType(attrs: any): vscode.FileType {
    if (!attrs) {
      return vscode.FileType.Unknown;
    }
    if (attrs.isSymbolicLink && attrs.isSymbolicLink()) {
      return vscode.FileType.SymbolicLink;
    }
    if (attrs.isDirectory && attrs.isDirectory()) {
      return vscode.FileType.Directory;
    }
    if (attrs.isFile && attrs.isFile()) {
      return vscode.FileType.File;
    }
    return vscode.FileType.Unknown;
  }

  /** Suppression récursive d'un chemin (fichier ou dossier). */
  private async deletePath(sftp: SFTPWrapper, path: string, recursive: boolean): Promise<void> {
    const attrs: any = await p((cb) => sftp.lstat(path, cb));
    const isDir = attrs.isDirectory && attrs.isDirectory();
    if (!isDir) {
      await p<void>((cb) => sftp.unlink(path, (err: any) => cb(err, undefined)));
      return;
    }
    if (recursive) {
      const children: any[] = await p((cb) => sftp.readdir(path, cb));
      for (const child of children) {
        await this.deletePath(sftp, `${path}/${child.filename}`, true);
      }
    }
    await p<void>((cb) => sftp.rmdir(path, (err: any) => cb(err, undefined)));
  }

  /** Invalide les entrées de cache liées à un chemin et à son parent. */
  private invalidate(uri: vscode.Uri): void {
    this.statCache.delete(uri.toString());
    const parent = uri.with({ path: uri.path.replace(/\/[^/]*$/, "") || "/" });
    this.statCache.delete(parent.toString());
  }
}
