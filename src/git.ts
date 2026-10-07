import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface RepoInfo {
  root: string;      // chemin absolu de la racine du dépôt
  owner: string;     // ex: "microsoft"
  repo: string;      // ex: "vscode"
  branch: string;    // branche courante
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** Extrait owner/repo d'une URL de remote GitHub (SSH ou HTTPS). */
export function parseGithubRemote(url: string): { owner: string; repo: string } | undefined {
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export async function getRepoInfo(cwd: string): Promise<RepoInfo> {
  const root = await git(cwd, 'rev-parse', '--show-toplevel');
  const branch = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD');

  // On privilégie "upstream" (cas d'un fork), sinon "origin" :
  // les PR intéressantes sont celles du dépôt principal.
  let remoteUrl = '';
  for (const name of ['upstream', 'origin']) {
    try {
      remoteUrl = await git(root, 'remote', 'get-url', name);
      break;
    } catch { /* remote absent, on essaie le suivant */ }
  }

  const parsed = parseGithubRemote(remoteUrl);
  if (!parsed) {
    throw new Error(`Remote GitHub introuvable (remote: "${remoteUrl || 'aucun'}")`);
  }
  return { root, branch, ...parsed };
}
