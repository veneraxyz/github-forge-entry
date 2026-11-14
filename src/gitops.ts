// Git operations over a repository's object store: ancestry, merge-base, tree diffs,
// three-way merges, commit creation, and upload-pack fetch planning.

import { ZERO_OID } from './constants.ts';
import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseTag,
  type GitObject,
  type TreeEntry,
} from './git.ts';
import {
  getCommit,
  getObject,
  getTree,
  peelToCommit,
  putObject,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// ancestry
// ---------------------------------------------------------------------------------------------

/** True when `ancestor` is `descendant` itself or reachable from it through parent links. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return false;
}

/**
 * The merge-base of `a` and `b`: the first commit reachable from `a` (breadth-first) that is
 * also reachable from `b`. Exact for the linear histories the suite builds.
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  const queueB = [b];
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queueB.push(parent);
  }
  const seen = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.shift()!;
    if (ancestorsOfB.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queueA.push(parent);
  }
  return null;
}

/** Commits reachable from `tip`, newest first (breadth-first from the tip). */
export function commitList(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    out.push(oid);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into path -> {oid, mode}. Gitlinks are kept as entries. */
export function flattenTree(repo: Repo, treeOid: string | null, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  if (treeOid === null) return out;
  const entries = getTree(repo, treeOid);
  if (!entries) return out;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Read one path's blob oid from a tree, or null when absent. */
export function treeLookup(repo: Repo, treeOid: string | null, path: string): FlatEntry | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let current: string | null = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    if (current === null) return null;
    const entries = getTree(repo, current);
    if (!entries) return null;
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** List a directory's entries at `path` (' ' for the root): {name, mode, oid, isDir}. */
export function treeListDir(
  repo: Repo,
  treeOid: string | null,
  path: string,
): Array<{ name: string; mode: string; oid: string; isDir: boolean }> | null {
  if (treeOid === null) return null;
  if (path === '') {
    const entries = getTree(repo, treeOid);
    if (!entries) return null;
    return entries.map((e) => ({ name: e.name, mode: e.mode, oid: e.oid, isDir: e.mode === '40000' }));
  }
  const segments = path.split('/').filter((s) => s !== '');
  let current: string | null = treeOid;
  for (const segment of segments) {
    if (current === null) return null;
    const entries = getTree(repo, current);
    if (!entries) return null;
    const entry = entries.find((e) => e.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const entries = getTree(repo, current);
  if (!entries) return null;
  return entries.map((e) => ({ name: e.name, mode: e.mode, oid: e.oid, isDir: e.mode === '40000' }));
}

/**
 * Build (and store) nested trees from a flat path map. Returns the root tree oid.
 * Empty directories are dropped (git does not store them).
 */
export function buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    entries: Map<string, TreeEntry>;
  }
  const root: Node = { entries: new Map() };
  const dirs = new Map<string, Node>();
  dirs.set('', root);
  const getDir = (path: string): Node => {
    let node = dirs.get(path);
    if (node) return node;
    node = { entries: new Map() };
    dirs.set(path, node);
    const slash = path.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    getDir(parentPath).entries.set(name, { mode: '40000', name, oid: '' });
    return node;
  };
  for (const [path, entry] of files) {
    const slash = path.lastIndexOf('/');
    const dirPath = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    getDir(dirPath).entries.set(name, { mode: entry.mode, name, oid: entry.oid });
  }
  const build = (path: string, node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const entry of node.entries.values()) {
      if (entry.mode === '40000') {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const child = dirs.get(childPath)!;
        if (child.entries.size === 0) continue;
        entries.push({ mode: '40000', name: entry.name, oid: build(childPath, child) });
      } else {
        entries.push(entry);
      }
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    putObject(repo, oid, { type: 'tree', data });
    return oid;
  };
  return build('', root);
}

/** Set (or delete, with blobOid null) one path in a tree; returns the new root tree oid. */
export function updateTreePath(
  repo: Repo,
  baseTreeOid: string | null,
  path: string,
  blobOid: string | null,
  mode = '100644',
): string {
  const files = flattenTree(repo, baseTreeOid);
  if (blobOid === null) files.delete(path);
  else files.set(path, { oid: blobOid, mode });
  return buildTreeFromMap(repo, files);
}

// ---------------------------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two flat trees. */
export function diffFlatTrees(
  base: ReadonlyMap<string, FlatEntry>,
  head: ReadonlyMap<string, FlatEntry>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) changes.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && (b.oid !== h.oid || b.mode !== h.mode)) {
      changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Split text into lines (no trailing newline handling: a trailing newline is not a line). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * LCS-based line diff: the number of added and deleted lines between two texts.
 * Files in the suite are small, so the O(n*m) DP table is cheap.
 */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // Two-row LCS length table.
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

// ---------------------------------------------------------------------------------------------
// three-way merge
// ---------------------------------------------------------------------------------------------

interface Hunk {
  /** Base line range [start, end) this hunk replaces. */
  start: number;
  end: number;
  /** The replacement lines. */
  replacement: string[];
}

/** The edit script from `base` to `other` as hunks over base line ranges (LCS backtrack). */
function diffHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  // Full DP table for backtracking.
  const dp: Int32Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = base[i] === other[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  const flush = (): void => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === other[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < m && (i === n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      if (!cur) cur = { start: i, end: i, replacement: [] };
      cur.replacement.push(other[j]!);
      j += 1;
    } else if (i < n) {
      if (!cur) cur = { start: i, end: i, replacement: [] };
      cur.end = i + 1;
      i += 1;
    } else {
      break;
    }
  }
  flush();
  return hunks;
}

/**
 * Three-way line merge of one file. Returns the merged text, or null on conflict.
 * Two changes conflict when their base ranges overlap, or when both insert different text
 * at the same base position.
 */
export function mergeFileContents(baseText: string, oursText: string, theirsText: string): string | null {
  if (oursText === theirsText) return oursText;
  if (oursText === baseText) return theirsText;
  if (theirsText === baseText) return oursText;
  const base = splitLines(baseText);
  const oursHunks = diffHunks(base, splitLines(oursText));
  const theirsHunks = diffHunks(base, splitLines(theirsText));
  // Overlap check (ranges in base coordinates; pure insertions are zero-width at a position).
  for (const o of oursHunks) {
    for (const t of theirsHunks) {
      const overlap = o.start < t.end && t.start < o.end;
      const sameInsertion =
        o.start === o.end && t.start === t.end && o.start === t.start &&
        o.replacement.join('\n') !== t.replacement.join('\n');
      // Adjacent changes (one ends where the other starts) also conflict, as in git.
      const adjacent =
        (o.end === t.start || t.end === o.start) &&
        !(o.start === o.end && t.start === t.end && o.start === t.start);
      if (overlap || sameInsertion || adjacent) return null;
    }
  }
  // Apply both hunk sets in base order.
  interface Applied {
    start: number;
    end: number;
    replacement: string[];
  }
  const applied: Applied[] = [
    ...oursHunks.map((h) => ({ start: h.start, end: h.end, replacement: h.replacement })),
    ...theirsHunks.map((h) => ({ start: h.start, end: h.end, replacement: h.replacement })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of applied) {
    if (hunk.start < cursor) return null; // defensive: overlapping hunks
    for (let i = cursor; i < hunk.start; i += 1) out.push(base[i]!);
    out.push(...hunk.replacement);
    cursor = hunk.end;
  }
  for (let i = cursor; i < base.length; i += 1) out.push(base[i]!);
  // Preserve a trailing newline when the inputs had one.
  const joined = out.join('\n');
  const hadTrailing = baseText.endsWith('\n') || oursText.endsWith('\n') || theirsText.endsWith('\n');
  return out.length === 0 ? '' : hadTrailing ? `${joined}\n` : joined;
}

export interface MergeResult {
  /** The merged flat tree (valid only when conflict is false). */
  merged: Map<string, FlatEntry>;
  conflict: boolean;
  conflictPaths: string[];
}

/**
 * Three-way merge of flat trees (base, ours, theirs). Per path: unchanged on one side wins;
 * both sides changed the same path -> a line-level merge of the blobs, or a conflict.
 */
export function mergeFlatTrees(
  repo: Repo,
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeResult {
  const merged = new Map<string, FlatEntry>();
  const conflictPaths: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) {
      if (o) merged.set(path, o);
      continue;
    }
    if (same(o, b)) {
      if (t) merged.set(path, t);
      continue;
    }
    if (same(t, b)) {
      if (o) merged.set(path, o);
      continue;
    }
    // Both sides changed the path differently.
    if (o === undefined || t === undefined) {
      // One side deleted, the other modified: a conflict (delete/modify).
      conflictPaths.push(path);
      continue;
    }
    if (o.mode === '160000' || t.mode === '160000' || (b && b.mode === '160000')) {
      conflictPaths.push(path);
      continue;
    }
    const baseBlob = b ? getObject(repo, b.oid) : undefined;
    const oursBlob = getObject(repo, o.oid);
    const theirsBlob = getObject(repo, t.oid);
    if (!oursBlob || !theirsBlob || oursBlob.type !== 'blob' || theirsBlob.type !== 'blob') {
      conflictPaths.push(path);
      continue;
    }
    const mergedText = mergeFileContents(
      baseBlob?.type === 'blob' ? baseBlob.data.toString('utf8') : '',
      oursBlob.data.toString('utf8'),
      theirsBlob.data.toString('utf8'),
    );
    if (mergedText === null) {
      conflictPaths.push(path);
      continue;
    }
    const data = Buffer.from(mergedText, 'utf8');
    const oid = hashObject('blob', data);
    putObject(repo, oid, { type: 'blob', data });
    merged.set(path, { oid, mode: o.mode });
  }
  return { merged, conflict: conflictPaths.length > 0, conflictPaths };
}

// ---------------------------------------------------------------------------------------------
// commit creation
// ---------------------------------------------------------------------------------------------

/** Create a commit object, store it, and return its oid. */
export function createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const data = buildCommit(treeOid, parents, message);
  const oid = hashObject('commit', data);
  putObject(repo, oid, { type: 'commit', data });
  return oid;
}

/** Move a branch ref to a commit (invalidates the branches cache). */
export function setBranch(repo: Repo, branch: string, oid: string): void {
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.branchesCache = null;
  repo.refsVersion += 1;
}

// ---------------------------------------------------------------------------------------------
// fetch planning (upload-pack)
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to pack, in deterministic order. */
  objects: GitObject[];
  /** The new shallow boundary. */
  shallow: string[];
  /** Client shallow commits whose parents are now included. */
  unshallow: string[];
  /** Haves that are ancestors-or-equal of a want. */
  acks: string[];
  nak: boolean;
}

/**
 * Plan a fetch: which objects to send for `wants`, excluding everything reachable from `haves`,
 * honouring `depth` (1 = the wanted commits only) and the client's shallow boundaries.
 *
 * A have normally cuts traversal — except a have that is also in `clientShallow`: the client
 * holds that commit but not its parents, so traversal continues through it (up to the depth
 * limit) to deliver the next generation.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
  deepenRelative = false,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = new Set(haves);
  const shallowSet = new Set(clientShallow);
  // The have closure stops at the client's shallow boundary: a shallow have's ancestors
  // are NOT held (the client has never seen below its boundary), so they must stay
  // sendable or a deepen would name a new boundary without delivering its objects.
  const haveClosure = collectReachable(haves, lookup, { allowMissing: true, stopAtParentsOf: shallowSet });

  // deepen-relative (real git's `fetch --deepen=N`): depth is measured from the client's
  // shallow boundary, not from the wants. A reachable shallow commit is relative depth 1,
  // its parent 2, and the new boundary sits at depth + 1 (git upload-pack's
  // get_shallow_commits(reachable_shallows, depth + 1)). Commits not below any reachable
  // shallow commit have no relative depth and are not depth-limited.
  const relativeDepth = new Map<string, number>();
  if (depth !== null && deepenRelative) {
    const reachableFromWants = collectReachable(wants, lookup, { allowMissing: true });
    const relQueue: Array<{ oid: string; depth: number }> = [];
    for (const oid of shallowSet) {
      if (reachableFromWants.has(oid)) relQueue.push({ oid, depth: 1 });
    }
    const relSeen = new Set<string>();
    while (relQueue.length) {
      const { oid, depth: d } = relQueue.shift()!;
      if (relSeen.has(oid)) continue;
      relSeen.add(oid);
      const prev = relativeDepth.get(oid);
      if (prev === undefined || d < prev) relativeDepth.set(oid, d);
      const commit = getCommit(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!relSeen.has(parent)) relQueue.push({ oid: parent, depth: d + 1 });
      }
    }
  }

  // Resolve wants to their traversal roots (tags peel to their target commit).
  const tagObjects = new Set<string>();
  const roots: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    // A zero want names nothing (an unborn branch's tip); it is a no-op, not an error.
    if (want === ZERO_OID) continue;
    const object = lookup(want);
    if (!object) throw new Error(`fetch wants unknown object ${want}`);
    if (object.type === 'tag') {
      tagObjects.add(want);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit') roots.push({ oid: target, depth: 1 });
      else if (targetObject) roots.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      roots.push({ oid: want, depth: 1 });
    } else {
      // A tree/blob want: send the object (and, for a tree, its subtree).
      roots.push({ oid: want, depth: 1 });
    }
  }

  // BFS over commits with the depth limit. `included` = commits to send.
  const included = new Set<string>();
  const reachedAtDepth = new Map<string, number>(); // commit -> depth it was reached at
  const queue: Array<{ oid: string; depth: number }> = [...roots];
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type !== 'commit') {
      // A non-commit root (tree/blob want): include it directly.
      if (!haveClosure.has(oid)) included.add(oid);
      continue;
    }
    reachedAtDepth.set(oid, d);
    const held = haveClosure.has(oid);
    if (!held) included.add(oid);
    // Expand parents unless the depth limit cuts the walk. Haves do NOT cut the
    // traversal: a held commit may sit above a shallow boundary the client has not
    // crossed yet (second deepen), and the boundary computation must see past it —
    // git's upload-pack likewise ignores haves when computing the boundary. What the
    // client holds only decides what is *sent* (haveClosure), never what is walked.
    if (depth !== null && !deepenRelative && d >= depth) continue;
    if (depth !== null && deepenRelative) {
      const rd = relativeDepth.get(oid);
      if (rd !== undefined && rd >= depth + 1) continue;
    }
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!seen.has(parent)) queue.push({ oid: parent, depth: d + 1 });
    }
  }

  // New shallow boundary: commits reached at exactly the depth limit that have parents.
  // Absolute mode counts from the wants; relative mode counts from the shallow boundary
  // (boundary at depth + 1) and only counts commits the fetch actually reached.
  const shallow: string[] = [];
  if (depth !== null) {
    if (deepenRelative) {
      for (const [oid, rd] of relativeDepth) {
        if (rd !== depth + 1) continue;
        if (!reachedAtDepth.has(oid)) continue;
        const commit = getCommit(repo, oid);
        if (commit && commit.parents.length > 0) shallow.push(oid);
      }
    } else {
      for (const [oid, d] of reachedAtDepth) {
        if (d !== depth) continue;
        const commit = getCommit(repo, oid);
        if (commit && commit.parents.length > 0) shallow.push(oid);
      }
    }
  }
  shallow.sort();

  // Unshallow: a client boundary whose parents are all in the included set now.
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    if (!reachedAtDepth.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    if (commit.parents.length === 0) continue;
    if (commit.parents.every((p) => included.has(p))) unshallow.push(oid);
  }
  unshallow.sort();

  // Objects to send: the included commits' tree closures + tag objects, minus the have closure.
  const send = new Set<string>();
  for (const oid of included) {
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      send.add(oid);
      const commit = getCommit(repo, oid)!;
      const treeClosure = collectReachable([commit.tree], lookup, { allowMissing: true });
      for (const t of treeClosure) send.add(t);
    } else {
      // Tree/blob want: its closure.
      const closure = collectReachable([oid], lookup, { allowMissing: true });
      for (const c of closure) send.add(c);
    }
  }
  for (const oid of tagObjects) send.add(oid);
  for (const oid of haveClosure) send.delete(oid);

  const objects: GitObject[] = [];
  const sorted = [...send].sort();
  for (const oid of sorted) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }

  // Acknowledgements: haves that are ancestors-or-equal of a want. Computed by walking
  // parent links only, and skipped entirely when no haves were sent: a full
  // collectReachable from the tip is O(history × tree) and dominated depth-1 clones
  // of the 200-commit bench history (the tip's own closure is 3 objects).
  const acks: string[] = [];
  if (haves.length > 0) {
    const wantCommits: string[] = [];
    for (const w of wants) {
      if (w === ZERO_OID) continue;
      const peeled = peelToCommit(repo, w);
      if (peeled !== null) wantCommits.push(peeled);
    }
    for (const h of haves) {
      if (h === ZERO_OID) continue;
      if (wantCommits.some((wc) => h === wc || isAncestor(repo, h, wc))) acks.push(h);
    }
  }
  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}
