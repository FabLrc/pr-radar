import * as vscode from 'vscode';

// Sous-ensemble de l'API publique de l'extension intégrée `vscode.git`
// (cf. extensions/git/src/api/git.d.ts dans le dépôt microsoft/vscode).

interface GitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

interface GitUpstreamRef {
  readonly remote: string;
  readonly name: string;
}

interface GitBranch {
  readonly name?: string;
  readonly upstream?: GitUpstreamRef;
}

interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly remotes: GitRemote[];
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

export interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

/** API de l'extension Git intégrée, ou `undefined` si elle est désactivée. */
export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.enabled ? exports.getAPI(1) : undefined;
}

export interface RepoInfo {
  root: string;      // chemin absolu de la racine du dépôt
  owner: string;     // dépôt dont on lit les PR, ex: "microsoft"
  repo: string;      // ex: "vscode"
  /** Branche GitHub correspondant à HEAD (propriétaire du fork + nom distant), si connue. */
  ownBranch?: { owner: string; branch: string };
}

/** Extrait owner/repo d'une URL de remote GitHub (SSH ou HTTPS). */
export function parseGithubRemote(url: string): { owner: string; repo: string } | undefined {
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

function remoteRepo(r: GitRepository, name: string) {
  const remote = r.state.remotes.find(x => x.name === name);
  const url = remote?.fetchUrl ?? remote?.pushUrl;
  return url ? parseGithubRemote(url) : undefined;
}

export function getRepoInfo(r: GitRepository): RepoInfo {
  // On privilégie "upstream" (cas d'un fork), sinon "origin" :
  // les PR intéressantes sont celles du dépôt principal.
  const target = remoteRepo(r, 'upstream') ?? remoteRepo(r, 'origin');
  if (!target) {
    const names = r.state.remotes.map(x => x.name).join(', ') || 'aucun';
    throw new Error(`Remote GitHub introuvable (remotes : ${names})`);
  }

  // Branche distante de HEAD : c'est elle qui identifie "ma" PR, nom ET propriétaire,
  // pour ne pas confondre avec une PR ouverte depuis la branche homonyme d'un autre fork.
  const head = r.state.HEAD;
  let ownBranch: RepoInfo['ownBranch'];
  if (head?.upstream) {
    const pushed = remoteRepo(r, head.upstream.remote);
    if (pushed) ownBranch = { owner: pushed.owner, branch: head.upstream.name };
  } else if (head?.name) {
    // Branche non encore poussée : elle le sera vraisemblablement sur origin.
    const origin = remoteRepo(r, 'origin');
    if (origin) ownBranch = { owner: origin.owner, branch: head.name };
  }

  return { root: r.rootUri.fsPath, ...target, ownBranch };
}

/** Empreinte des éléments de l'état Git qui influencent le résultat de `getRepoInfo`. */
export function repoStateKey(r: GitRepository): string {
  const { HEAD, remotes } = r.state;
  return JSON.stringify([
    HEAD?.name,
    HEAD?.upstream?.remote,
    HEAD?.upstream?.name,
    remotes.map(x => [x.name, x.fetchUrl, x.pushUrl]),
  ]);
}
