export interface PrInfo {
  number: number;
  title: string;
  url: string;
  author: string;
  branch: string;
  isDraft: boolean;
}

/** Index : chemin relatif (séparateur "/") -> PR qui modifient ce fichier. */
export type PrIndex = Map<string, PrInfo[]>;

// Une seule requête GraphQL récupère les PR ouvertes ET leurs fichiers,
// là où l'API REST demanderait 1 appel par PR.
const QUERY = `
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
        author { login }
        files(first: 100) { nodes { path } }
      }
    }
  }
}`;

interface GqlPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  author: { login: string } | null;
  files: { nodes: { path: string }[] } | null;
}

export async function fetchOpenPrs(
  token: string,
  owner: string,
  repo: string,
  maxPages = 4,
): Promise<{ pr: PrInfo; files: string[] }[]> {
  const result: { pr: PrInfo; files: string[] }[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'pr-radar-vscode',
      },
      body: JSON.stringify({ query: QUERY, variables: { owner, repo, cursor } }),
    });

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }
    const json: any = await res.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((e: any) => e.message).join(', '));
    }

    const conn = json.data.repository.pullRequests;
    for (const n of conn.nodes as GqlPr[]) {
      result.push({
        pr: {
          number: n.number,
          title: n.title,
          url: n.url,
          isDraft: n.isDraft,
          branch: n.headRefName,
          author: n.author?.login ?? 'ghost',
        },
        // NB : limité aux 100 premiers fichiers par PR (suffisant pour un MVP).
        files: n.files?.nodes.map(f => f.path) ?? [],
      });
    }

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return result;
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
