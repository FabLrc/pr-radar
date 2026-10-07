export interface PrInfo {
  number: number;
  title: string;
  url: string;
  author: string;
  branch: string;
  /** Propriétaire du dépôt source de la PR (fork ou dépôt principal), absent si le fork a été supprimé. */
  headOwner: string | undefined;
  isDraft: boolean;
}

/** Index : chemin relatif (séparateur "/") -> PR qui modifient ce fichier. */
export type PrIndex = Map<string, PrInfo[]>;

export interface FetchResult {
  prs: { pr: PrInfo; files: string[] }[];
  /** Vrai si toutes les PR ouvertes n'ont pas pu être récupérées (limite `maxPages`). */
  truncated: boolean;
}

// Une seule requête GraphQL récupère les PR ouvertes ET leurs fichiers,
// là où l'API REST demanderait 1 appel par PR.
const PRS_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        isDraft
        headRefName
        headRepositoryOwner { login }
        author { login }
        files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path } }
      }
    }
  }
}`;

// Fichiers restants d'une PR qui en modifie plus de 100.
const FILES_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { path } }
    }
  }
}`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface FilesConnection {
  pageInfo: PageInfo;
  nodes: { path: string }[];
}

interface GqlPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  headRepositoryOwner: { login: string } | null;
  author: { login: string } | null;
  files: FilesConnection | null;
}

interface PrsData {
  repository: { pullRequests: { pageInfo: PageInfo; nodes: GqlPr[] } } | null;
}

interface FilesData {
  repository: { pullRequest: { files: FilesConnection | null } | null } | null;
}

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pr-radar-vscode',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: T | null; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(json.errors.map(e => e.message).join(', '));
  }
  if (!json.data) {
    throw new Error('Réponse GitHub vide.');
  }
  return json.data;
}

async function collectFiles(
  token: string,
  owner: string,
  repo: string,
  number: number,
  first: FilesConnection,
): Promise<string[]> {
  const paths = first.nodes.map(f => f.path);
  let conn = first;
  while (conn.pageInfo.hasNextPage) {
    const data = await graphql<FilesData>(token, FILES_QUERY, {
      owner, repo, number, cursor: conn.pageInfo.endCursor,
    });
    const next = data.repository?.pullRequest?.files;
    if (!next) break; // PR fermée ou supprimée entre-temps
    paths.push(...next.nodes.map(f => f.path));
    conn = next;
  }
  return paths;
}

export async function fetchOpenPrs(
  token: string,
  owner: string,
  repo: string,
  maxPages = 4,
): Promise<FetchResult> {
  const prs: FetchResult['prs'] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const data: PrsData = await graphql<PrsData>(token, PRS_QUERY, { owner, repo, cursor });
    if (!data.repository) {
      throw new Error(`Dépôt ${owner}/${repo} introuvable ou inaccessible avec ce compte GitHub.`);
    }

    const conn = data.repository.pullRequests;
    for (const n of conn.nodes) {
      prs.push({
        pr: {
          number: n.number,
          title: n.title,
          url: n.url,
          isDraft: n.isDraft,
          branch: n.headRefName,
          headOwner: n.headRepositoryOwner?.login,
          author: n.author?.login ?? 'ghost',
        },
        files: n.files ? await collectFiles(token, owner, repo, n.number, n.files) : [],
      });
    }

    if (!conn.pageInfo.hasNextPage) return { prs, truncated: false };
    cursor = conn.pageInfo.endCursor;
  }

  return { prs, truncated: true };
}

export function buildIndex(prs: { pr: PrInfo; files: string[] }[]): PrIndex {
  const index: PrIndex = new Map();
  for (const { pr, files } of prs) {
    for (const f of files) {
      const list = index.get(f);
      if (list) list.push(pr);
      else index.set(f, [pr]);
    }
  }
  return index;
}
