import * as vscode from 'vscode';
import * as path from 'path';
import { getRepoInfo, RepoInfo } from './git';
import { buildIndex, fetchOpenPrs, PrIndex, PrInfo } from './github';

let index: PrIndex = new Map();
let repo: RepoInfo | undefined;
let timer: NodeJS.Timeout | undefined;
const warnedFiles = new Set<string>();

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
  const prs = editor ? prsFor(editor.document.uri) : [];
  if (prs.length === 0) {
    statusItem.hide();
    return;
  }
  statusItem.text = `$(git-pull-request) ${prs.length} PR sur ce fichier`;
  statusItem.tooltip = prs.map(p => `#${p.number} ${p.title} (@${p.author})`).join('\n');
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusItem.command = 'prRadar.showPrsForFile';
  statusItem.show();
}

// ---------- Rafraîchissement ----------

async function refresh(decorations: PrDecorationProvider, interactive = false) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  try {
    repo = await getRepoInfo(folder.uri.fsPath);

    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: interactive,
      silent: !interactive,
    });
    if (!session) {
      statusItem.text = '$(github) PR Radar : se connecter';
      statusItem.command = 'prRadar.refresh';
      statusItem.backgroundColor = undefined;
      statusItem.show();
      return;
    }

    const me = session.account.label;
    const { ignoreOwnPrs, ignoreDrafts } = {
      ignoreOwnPrs: config().get<boolean>('ignoreOwnPrs', true),
      ignoreDrafts: config().get<boolean>('ignoreDrafts', false),
    };

    const all = await fetchOpenPrs(session.accessToken, repo.owner, repo.repo);
    const relevant = all.filter(({ pr }) =>
      pr.branch !== repo!.branch &&                 // pas la PR de ma branche
      !(ignoreOwnPrs && pr.author === me) &&
      !(ignoreDrafts && pr.isDraft),
    );

    index = buildIndex(relevant);
    decorations.refresh();
    updateStatus();

    if (interactive) {
      vscode.window.setStatusBarMessage(
        `PR Radar : ${relevant.length} PR ouvertes, ${index.size} fichiers surveillés`, 4000);
    }
  } catch (err: any) {
    console.error('[PR Radar]', err);
    if (interactive) {
      vscode.window.showErrorMessage(`PR Radar : ${err.message ?? err}`);
    }
  }
}

function schedule(decorations: PrDecorationProvider) {
  if (timer) clearInterval(timer);
  const minutes = Math.max(1, config().get<number>('refreshIntervalMinutes', 5));
  timer = setInterval(() => refresh(decorations), minutes * 60_000);
}

// ---------- Activation ----------

export function activate(context: vscode.ExtensionContext) {
  const decorations = new PrDecorationProvider();

  context.subscriptions.push(
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
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!config().get<boolean>('warnOnEdit', true) || e.contentChanges.length === 0) return;
      const rel = relPath(e.document.uri);
      if (!rel || warnedFiles.has(rel)) return;
      const prs = index.get(rel);
      if (!prs?.length) return;

      warnedFiles.add(rel);
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

    // Changement de branche -> on recalcule (la PR "à soi" change)
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'github') refresh(decorations);
    }),
  );

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const headWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.git/HEAD'),
    );
    headWatcher.onDidChange(() => refresh(decorations));
    context.subscriptions.push(headWatcher);
  }

  refresh(decorations);
  schedule(decorations);
}

export function deactivate() {
  if (timer) clearInterval(timer);
}
