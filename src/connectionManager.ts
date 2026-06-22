// Gestion du cycle de vie des connexions SSH (ssh2) et obtention de sessions
// SFTP. Une connexion est créée paresseusement par hôte, mise en cache et
// réutilisée par toutes les opérations du FileSystemProvider.
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { Client, SFTPWrapper, utils as ssh2Utils } from "ssh2";
import { SshHost, resolveHost } from "./sshConfig";

interface Settings {
  configPath: string;
  connectTimeout: number;
  keepaliveInterval: number;
}

interface ConnEntry {
  client: Promise<Client>;
  sftp?: Promise<SFTPWrapper>;
}

/** Détermine si une erreur ssh2 correspond à un échec d'authentification. */
function isAuthError(err: any): boolean {
  if (!err) {
    return false;
  }
  const level = err.level || "";
  const msg = String(err.message || "").toLowerCase();
  return (
    level === "client-authentication" ||
    msg.includes("authentication") ||
    msg.includes("all configured authentication methods failed")
  );
}

/** Sépare une cible ProxyJump (`user@host:port` ou simple alias). */
function parseJumpTarget(value: string): { alias: string; user?: string; port?: number } {
  let rest = value;
  let user: string | undefined;
  let port: number | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    port = parseInt(rest.slice(colon + 1), 10);
    rest = rest.slice(0, colon);
  }
  return { alias: rest, user, port };
}

export class ConnectionManager {
  private readonly connections = new Map<string, ConnEntry>();

  constructor(private settings: Settings) {}

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  /** Retourne une session SFTP prête pour l'hôte donné (créée si besoin). */
  async getSftp(alias: string): Promise<SFTPWrapper> {
    const entry = this.getEntry(alias);
    if (!entry.sftp) {
      entry.sftp = entry.client.then(
        (client) =>
          new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((err, sftp) => {
              if (err) {
                reject(err);
              } else {
                resolve(sftp);
              }
            });
          })
      );
      // En cas d'échec, ne pas mémoriser un SFTP cassé.
      entry.sftp.catch(() => {
        entry.sftp = undefined;
      });
    }
    return entry.sftp;
  }

  /** Récupère (ou crée) l'entrée de connexion mise en cache pour un alias. */
  private getEntry(alias: string): ConnEntry {
    let entry = this.connections.get(alias);
    if (!entry) {
      const host = resolveHost(this.settings.configPath, alias);
      const client = this.createConnection(host);
      entry = { client };
      // Purge l'entrée si la connexion échoue ou se ferme.
      client
        .then((c) => {
          c.on("close", () => this.connections.delete(alias));
          c.on("error", () => this.connections.delete(alias));
        })
        .catch(() => this.connections.delete(alias));
      this.connections.set(alias, entry);
    }
    return entry;
  }

  /** Ferme une connexion donnée. */
  async disconnect(alias: string): Promise<void> {
    const entry = this.connections.get(alias);
    this.connections.delete(alias);
    if (entry) {
      try {
        (await entry.client).end();
      } catch {
        /* connexion déjà tombée */
      }
    }
  }

  /** Ferme toutes les connexions (appelé à la désactivation de l'extension). */
  async disconnectAll(): Promise<void> {
    const aliases = [...this.connections.keys()];
    await Promise.all(aliases.map((a) => this.disconnect(a)));
  }

  // --- Établissement de connexion -----------------------------------------

  /**
   * Crée une connexion : tentative par clé/agent d'abord, puis repli sur une
   * authentification par mot de passe demandée à l'utilisateur si nécessaire.
   */
  private async createConnection(host: SshHost): Promise<Client> {
    try {
      return await this.attempt(host);
    } catch (err) {
      if (!isAuthError(err)) {
        throw err;
      }
      const password = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(
          "SSH password for {0}@{1}",
          host.user ?? os.userInfo().username,
          host.alias
        ),
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) {
        throw err;
      }
      return this.attempt(host, password);
    }
  }

  /** Une tentative de connexion ssh2 ; résout sur "ready", rejette sur "error". */
  private async attempt(host: SshHost, password?: string): Promise<Client> {
    const config = await this.buildConfig(host, password);
    return new Promise<Client>((resolve, reject) => {
      const client = new Client();

      // Authentification clavier-interactive (ex. OTP / 2FA).
      client.on("keyboard-interactive", async (_name, _instr, _lang, prompts, finish) => {
        const answers: string[] = [];
        for (const p of prompts) {
          const answer = await vscode.window.showInputBox({
            prompt: `${host.alias}: ${p.prompt}`,
            password: !p.echo,
            ignoreFocusOut: true,
          });
          answers.push(answer ?? "");
        }
        finish(answers);
      });

      client.once("ready", () => resolve(client));
      client.once("error", (err) => reject(err));
      client.connect(config);
    });
  }

  /** Construit l'objet de configuration ssh2 (auth + éventuel ProxyJump). */
  private async buildConfig(host: SshHost, password?: string): Promise<any> {
    const config: any = {
      host: host.hostName,
      port: host.port,
      username: host.user ?? os.userInfo().username,
      readyTimeout: this.settings.connectTimeout,
      keepaliveInterval: this.settings.keepaliveInterval,
      tryKeyboard: true,
    };

    if (process.env.SSH_AUTH_SOCK) {
      config.agent = process.env.SSH_AUTH_SOCK;
    }

    if (password) {
      config.password = password;
    } else {
      const key = await this.loadFirstUsableKey(host);
      if (key) {
        config.privateKey = key.key;
        if (key.passphrase) {
          config.passphrase = key.passphrase;
        }
      }
    }

    const sock = await this.buildProxySock(host);
    if (sock) {
      config.sock = sock;
    }

    return config;
  }

  /**
   * Charge la première clé privée exploitable parmi les IdentityFile, en
   * demandant la passphrase si la clé est chiffrée.
   */
  private async loadFirstUsableKey(
    host: SshHost
  ): Promise<{ key: Buffer; passphrase?: string } | undefined> {
    for (const file of host.identityFiles) {
      let raw: Buffer;
      try {
        raw = fs.readFileSync(file);
      } catch {
        continue; // clé absente : on essaie la suivante
      }
      const parsed = ssh2Utils.parseKey(raw);
      if (parsed instanceof Error) {
        if (/encrypted|passphrase/i.test(parsed.message)) {
          const passphrase = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Passphrase for key {0}", file),
            password: true,
            ignoreFocusOut: true,
          });
          if (passphrase) {
            return { key: raw, passphrase };
          }
        }
        continue; // clé illisible : on essaie la suivante
      }
      return { key: raw };
    }
    return undefined;
  }

  /**
   * Construit la socket de tunneling pour un saut ProxyJump (un niveau).
   * Retourne `undefined` si l'hôte n'utilise pas de bastion.
   */
  private async buildProxySock(host: SshHost): Promise<any | undefined> {
    if (!host.proxyJump) {
      return undefined;
    }
    const target = parseJumpTarget(host.proxyJump);
    const bastion = resolveHost(this.settings.configPath, target.alias);
    if (target.user) {
      bastion.user = target.user;
    }
    if (target.port) {
      bastion.port = target.port;
    }
    // Réutilise la connexion du bastion via le cache.
    const bastionClient = await this.getEntry(bastion.alias).client;
    return new Promise((resolve, reject) => {
      bastionClient.forwardOut(
        "127.0.0.1",
        0,
        host.hostName,
        host.port,
        (err, stream) => {
          if (err) {
            reject(err);
          } else {
            resolve(stream);
          }
        }
      );
    });
  }
}
