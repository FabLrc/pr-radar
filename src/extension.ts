import * as vscode from 'vscode';
import * as path from 'path';
import { getGitApi, getRepoInfo, GitRepository, RepoInfo, repoStateKey } from './git';
import { buildIndex, fetchOpenPrs, PrIndex, PrInfo } from './github';

type Health = { kind: 'ok' } | { kind: 'signin' } | { kind: 'error'; message: string };

let index: PrIndex = new Map();
let repo: RepoInfo | undefined;       // dépôt auquel correspond `index`
let gitRepo: GitRepository | undefined;
let health: Health = { kind: 'ok' };
let partial = false;                  // l'index ne couvre pas toutes les PR ouvertes
let generation = 0;                   // incrémenté à chaque refresh : seul le plus récent s'applique
let timer: NodeJS.Timeout | undefined;
let log: vscode.LogOutputChannel;
/** Avertissements déjà affichés ; clé = fichier + PR concernées. */
const warned = new Set<string>();

// ---------- Utilitaires ----------

function config() {
  return vscode.workspace.getConfiguration('prRadar');
}

/** Convertit une URI en chemin relatif au dépôt, format GitHub ("a/b/c.ts"). */
function relPath(uri: vscode.Uri): string | undefined {
  if (!repo || uri.scheme !== 'file') return undefined;
  const rel = path.relative(repo.root, uri.fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

function prsFor(uri: vscode.Uri): PrInfo[] {
  const rel = relPath(uri);
  return rel ? index.get(rel) ?? [] : [];
}

// ---------- Décorations dans l'explorateur ----------

class PrDecorationProvider implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const prs = prsFor(uri);
    if (prs.length === 0) return undefined;
    return {
      badge: prs.length > 9 ? '9+' : `P${prs.length}`.slice(0, 2),
      tooltip: prs.map(p => `PR #${p.number} · ${p.title} (@${p.author})`).join('\n'),
      color: new vscode.ThemeColor('editorWarning.foreground'),
      propagate: false,
    };
  }

  refresh() {
    this.emitter.fire(undefined);
  }
}

// ---------- Barre de statut ----------

const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

function updateStatus(editor = vscode.window.activeTextEditor) {
  if (health.kind === 'signin') {
    statusItem.text = '$(github) PR Radar : se connecter';
    statusItem.tooltip = 'Se connecter à GitHub pour récupérer les PR ouvertes';
    statusItem.command = 'prRadar.refresh';
    statusItem.backgroundColor = undefined;
    statusItem.show();
    return;
  }

  const notes: string[] = [];
  if (partial) notes.push('Index partiel : seules les PR les plus récemment mises à jour sont analysées.');
  if (health.kind === 'error') notes.push(`Dernier rafraîchissement en échec : ${health.message}`);

  const prs = editor ? prsFor(editor.document.uri) : [];
  if (prs.length > 0) {
    statusItem.text = `$(git-pull-request) ${prs.length} PR sur ce fichier`;
    statusItem.tooltip = [prs.map(p => `#${p.number} ${p.title} (@${p.author})`).join('\n'), ...notes].join('\n\n');
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.command = 'prRadar.showPrsForFile';
    statusItem.show();
  } else if (health.kind === 'error') {
    statusItem.text = '$(warning) PR Radar';
    statusItem.tooltip = `${notes.join('\n\n')}\n\nCliquer pour réessayer.`;
    statusItem.backgroundColor = undefined;
    statusItem.command = 'prRadar.refresh';
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

// ---------- Rafraîchissement ----------

async function refresh(decorations: PrDecorationProvider, interactive = false) {
  const gen = ++generation;
  const stale = () => gen !== generation;

  if (!gitRepo) {
    repo = undefined;
    index = new Map();
    partial = false;
    health = { kind: 'ok' };
    decorations.refresh();
    updateStatus();
    if (interactive) {
      vscode.window.showInformationMessage('PR Radar : aucun dépôt Git détecté dans cet espace de travail.');
    }
    return;
  }

  try {
    const info = getRepoInfo(gitRepo);

    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: interactive,
      silent: !interactive,
    });
    if (stale()) return;
    if (!session) {
      health = { kind: 'signin' };
      updateStatus();
      return;
    }

    const me = session.account.label;
    const ignoreOwnPrs = config().get<boolean>('ignoreOwnPrs', true);
    const ignoreDrafts = config().get<boolean>('ignoreDrafts', false);

    const { prs, truncated } = await fetchOpenPrs(session.accessToken, info.owner, info.repo);
    if (stale()) return;

    const own = info.ownBranch;
    const relevant = prs.filter(({ pr }) =>
      // pas la PR de ma branche : même nom distant ET même propriétaire (fork)
      !(own && pr.branch === own.branch && pr.headOwner?.toLowerCase() === own.owner.toLowerCase()) &&
      !(ignoreOwnPrs && pr.author === me) &&
      !(ignoreDrafts && pr.isDraft),
    );

    repo = info;
    index = buildIndex(relevant);
    partial = truncated;
    health = { kind: 'ok' };
    decorations.refresh();
    updateStatus();

    if (truncated) {
      log.warn(`Plus de ${prs.length} PR ouvertes sur ${info.owner}/${info.repo} : seules les ${prs.length} plus récemment mises à jour sont analysées.`);
    }
    log.info(`${info.owner}/${info.repo} : ${relevant.length} PR retenues sur ${prs.length}, ${index.size} fichiers surveillés.`);
    if (interactive) {
      vscode.window.setStatusBarMessage(
        `PR Radar : ${relevant.length} PR ouvertes, ${index.size} fichiers surveillés`, 4000);
    }
  } catch (err) {
    if (stale()) return;
    const message = err instanceof Error ? err.message : String(err);
    log.error(err instanceof Error ? err : message);
    health = { kind: 'error', message };
    updateStatus();
    if (interactive) {
      const choice = await vscode.window.showErrorMessage(`PR Radar : ${message}`, 'Voir le journal');
      if (choice) log.show();
    }
  }
}

function schedule(decorations: PrDecorationProvider) {
  clearInterval(timer);
  const minutes = Math.max(1, config().get<number>('refreshIntervalMinutes', 5));
  timer = setInterval(() => refresh(decorations), minutes * 60_000);
}

// ---------- Activation ----------

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('PR Radar', { log: true });
  const decorations = new PrDecorationProvider();

  context.subscriptions.push(
    log,
    statusItem,
    vscode.window.registerFileDecorationProvider(decorations),

    vscode.commands.registerCommand('prRadar.refresh', () => refresh(decorations, true)),

    vscode.commands.registerCommand('prRadar.showPrsForFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const prs = target ? prsFor(target) : [];
      if (prs.length === 0) {
        vscode.window.showInformationMessage('Aucune PR ouverte ne touche ce fichier.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        prs.map(p => ({
          label: `#${p.number} ${p.title}`,
          description: `@${p.author} · ${p.branch}${p.isDraft ? ' · draft' : ''}`,
          pr: p,
        })),
        { placeHolder: 'Ouvrir une PR dans le navigateur' },
      );
      if (pick) vscode.env.openExternal(vscode.Uri.parse(pick.pr.url));
    }),

    vscode.window.onDidChangeActiveTextEditor(e => updateStatus(e)),

    // Avertissement à la première modification d'un fichier concerné
    // (de nouveau si l'ensemble des PR qui le touchent change).
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!config().get<boolean>('warnOnEdit', true) || e.contentChanges.length === 0) return;
      const rel = relPath(e.document.uri);
      if (!rel) return;
      const prs = index.get(rel);
      if (!prs?.length) return;
      const key = `${rel}#${prs.map(p => p.number).sort((a, b) => a - b).join(',')}`;
      if (warned.has(key)) return;

      warned.add(key);
      const list = prs.map(p => `#${p.number}`).join(', ');
      vscode.window
        .showWarningMessage(
          `⚠️ ${path.basename(rel)} est aussi modifié par ${prs.length > 1 ? 'les PR' : 'la PR'} ${list}.`,
          'Voir',
        )
        .then(choice => {
          if (choice) vscode.commands.executeCommand('prRadar.showPrsForFile', e.document.uri);
        });
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('prRadar')) {
        schedule(decorations);
        refresh(decorations);
      }
    }),

    // Connexion / déconnexion GitHub
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'github') refresh(decorations);
    }),
  );

  const git = await getGitApi();
  if (!git) {
    health = { kind: 'error', message: "l'extension Git intégrée de VS Code est désactivée." };
    log.error(health.message);
    updateStatus();
    return;
  }

  // Dépôt suivi : celui qui contient le premier dossier de l'espace de travail
  // (même ouvert dans un sous-dossier ou un worktree), sinon le premier détecté.
  const folder = vscode.workspace.workspaceFolders?.[0];
  let stateKey = '';
  let repoListener: vscode.Disposable | undefined;
  context.subscriptions.push({ dispose: () => repoListener?.dispose() });

  const selectRepo = () => {
    const next = (folder && git.getRepository(folder.uri)) || git.repositories[0];
    if (next?.rootUri.toString() === gitRepo?.rootUri.toString()) return;

    repoListener?.dispose();
    gitRepo = next;
    stateKey = next ? repoStateKey(next) : '';
    // Changement de branche, d'upstream ou de remotes -> on recalcule (la PR "à soi" change)
    repoListener = next?.state.onDidChange(() => {
      const key = repoStateKey(next);
      if (key === stateKey) return;
      stateKey = key;
      refresh(decorations);
    });
    refresh(decorations);
  };

  context.subscriptions.push(
    git.onDidOpenRepository(selectRepo),
    git.onDidCloseRepository(selectRepo),
  );
  selectRepo();
  schedule(decorations);
}

export function deactivate() {
  clearInterval(timer);
}
