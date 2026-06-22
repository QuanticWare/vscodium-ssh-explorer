// Parsing et résolution du fichier ~/.ssh/config.
//
// On s'appuie sur la bibliothèque `ssh-config` pour analyser le fichier puis
// résoudre, pour un alias donné, les options effectives (HostName, User, Port,
// IdentityFile, ProxyJump…) en tenant compte des blocs `Host *` génériques.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import SSHConfig from "ssh-config";

/** Hôte résolu, prêt à être utilisé par le gestionnaire de connexions. */
export interface SshHost {
  /** Alias tel qu'écrit dans `Host <alias>` (sert d'authority dans les URI). */
  alias: string;
  /** Nom/IP réel à contacter (HostName), à défaut l'alias lui-même. */
  hostName: string;
  user?: string;
  port: number;
  /** Chemins de clés privées (IdentityFile), `~` déjà expansé. */
  identityFiles: string[];
  /** Alias d'un éventuel bastion (ProxyJump), première valeur uniquement. */
  proxyJump?: string;
}

/** Remplace un `~` initial par le répertoire personnel de l'utilisateur. */
export function expandTilde(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Lit le contenu du fichier de configuration, ou "" s'il est absent. */
function readConfigText(configPath: string): string {
  const resolved = expandTilde(configPath);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/** Récupère la première valeur d'un champ compute, insensible à la casse. */
function firstValue(computed: Record<string, any>, key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const k of Object.keys(computed)) {
    if (k.toLowerCase() === lower) {
      const v = computed[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/** Récupère toutes les valeurs d'un champ compute, insensible à la casse. */
function allValues(computed: Record<string, any>, key: string): string[] {
  const lower = key.toLowerCase();
  for (const k of Object.keys(computed)) {
    if (k.toLowerCase() === lower) {
      const v = computed[k];
      return Array.isArray(v) ? v : v != null ? [v] : [];
    }
  }
  return [];
}

/** Indique si un motif `Host` est un littéral sélectionnable (sans wildcard). */
function isSelectablePattern(pattern: string): boolean {
  return !pattern.includes("*") && !pattern.includes("?") && !pattern.startsWith("!");
}

/**
 * Résout un hôte à partir d'un objet `ssh-config` déjà parsé.
 * Retourne `undefined` si aucun HostName ni alias exploitable.
 */
function resolveFromConfig(config: any, alias: string): SshHost | undefined {
  const computed: Record<string, any> = config.compute(alias);
  const hostName = firstValue(computed, "HostName") || alias;
  const user = firstValue(computed, "User");
  const portStr = firstValue(computed, "Port");
  const port = portStr ? parseInt(portStr, 10) : 22;
  const identityFiles = [...new Set(allValues(computed, "IdentityFile").map(expandTilde))];
  const proxyJump = firstValue(computed, "ProxyJump");

  return {
    alias,
    hostName,
    user,
    port: Number.isFinite(port) ? port : 22,
    identityFiles,
    proxyJump: proxyJump && proxyJump.toLowerCase() !== "none" ? proxyJump : undefined,
  };
}

/**
 * Liste les hôtes littéraux déclarés dans le fichier de configuration.
 * Les blocs génériques (`Host *`) sont ignorés pour la sélection mais restent
 * pris en compte lors de la résolution de chaque hôte.
 */
export function listHosts(configPath: string): SshHost[] {
  const text = readConfigText(configPath);
  if (!text.trim()) {
    return [];
  }
  const config: any = SSHConfig.parse(text);

  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const line of config) {
    if (!line || typeof line.param !== "string") {
      continue;
    }
    if (line.param.toLowerCase() !== "host") {
      continue;
    }
    // `value` peut être une chaîne ("a b") ou un tableau de motifs.
    const patterns: string[] = Array.isArray(line.value)
      ? line.value
      : String(line.value).split(/\s+/);
    for (const pattern of patterns) {
      if (isSelectablePattern(pattern) && !seen.has(pattern)) {
        seen.add(pattern);
        aliases.push(pattern);
      }
    }
  }

  const hosts: SshHost[] = [];
  for (const alias of aliases) {
    const host = resolveFromConfig(config, alias);
    if (host) {
      hosts.push(host);
    }
  }
  return hosts;
}

/** Résout un alias précis (utilisé aussi pour résoudre un bastion ProxyJump). */
export function resolveHost(configPath: string, alias: string): SshHost {
  const text = readConfigText(configPath);
  const config: any = SSHConfig.parse(text || "");
  const host = resolveFromConfig(config, alias);
  if (!host) {
    // Pas d'entrée dans la config : on se rabat sur l'alias comme hostname.
    return { alias, hostName: alias, port: 22, identityFiles: [] };
  }
  return host;
}
