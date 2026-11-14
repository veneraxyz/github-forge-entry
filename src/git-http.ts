// Git smart HTTP: info/refs, git-upload-pack (protocol v0 and v2) and git-receive-pack (v0).
//
// Wire contract (from the suite's git-client.ts):
//   - info/refs?service=git-upload-pack with `Git-Protocol: version=2` answers a v2 capability
//     advertisement (`# service=` preamble, `version 2`, capabilities); without the header it
//     answers v0 refs. info/refs?service=git-receive-pack is v0-only.
//   - git-upload-pack POST: v2 `command=ls-refs` / `command=fetch` when the header says v2,
//     else the v0 want/have exchange. The pack always travels in sideband band 1.
//   - git-receive-pack POST: a v0 command list, an optional packfile, and a report-status reply
//     (in sideband band 1 when side-band-64k was negotiated).

import { ZERO_OID } from './constants.ts';
import {
  isObjectId,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { isAncestor, planFetch } from './gitops.ts';
import { getObject, peelToCommit, type Forge, type Repo } from './store.ts';
import {
  decodePktLines,
  decodeUntilFlush,
  pktLine,
  pktLines,
  sidebandPack,
  PKT_DELIM,
  PKT_FLUSH,
  type Pkt,
} from './pktline.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json';

const AGENT = 'github-forge/1.0';

function jsonError(status: number, message: string): HttpResult {
  return { status, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** The repo's refs sorted for advertisement: HEAD first, then branches, then tags. */
interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
}

function listRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultOid = repo.refs.get(defaultRef);
  if (defaultOid !== undefined) {
    out.push({ name: 'HEAD', oid: defaultOid });
  }
  const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
  for (const name of branches) {
    out.push({ name, oid: repo.refs.get(name)! });
  }
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    const ref: AdvertisedRef = { name, oid };
    if (object?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) ref.peeled = peeled;
    }
    out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | null,
): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return jsonError(404, `Repository ${owner}/${repoName} not found`);
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') return uploadPackV2Advertisement();
    return uploadPackV0Advertisement(repo);
  }
  if (service === 'git-receive-pack') return receivePackAdvertisement(repo);
  return jsonError(400, `Unknown service ${service}`);
}

function uploadPackV2Advertisement(): HttpResult {
  const body = pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    // Bare `ls-refs`: the suite client sends the `unborn` argument whenever the value
    // contains `unborn`, and then parses `unborn refs/heads/main` as a real ref — which
    // breaks clone-empty and the GraphQL git fixture (it reads the branch tip as ZERO).
    // No check requires the unborn value; lsRefsV2 still answers it if asked (real git).
    'ls-refs\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
  return { status: 200, contentType: UPLOAD_AD, body };
}

function uploadPackV0Advertisement(repo: Repo): HttpResult {
  const caps = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const refs = listRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: UPLOAD_AD, body: Buffer.concat(parts) };
}

function receivePackAdvertisement(repo: Repo): HttpResult {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = listRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: RECEIVE_AD, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// git-upload-pack
// ---------------------------------------------------------------------------------------------

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return jsonError(404, `Repository ${owner}/${repoName} not found`);
  try {
    if (gitProtocol === 'version=2') return uploadPackV2(repo, body);
    return uploadPackV0(repo, body);
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : String(err));
  }
}

function dataTexts(packets: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  return out;
}

function uploadPackV2(repo: Repo, body: Buffer): HttpResult {
  const { packets } = decodePktLines(body);
  const lines = dataTexts(packets);
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (command === 'command=ls-refs') return lsRefsV2(repo, lines.slice(1));
  if (command === 'command=fetch') return fetchV2(repo, lines.slice(1));
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

function lsRefsV2(repo: Repo, lines: readonly string[]): HttpResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    // agent= and object-format= lines are accepted and ignored.
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const refs = listRefs(repo);
  const isEmpty = repo.refs.size === 0;
  if (isEmpty && unborn) {
    const headTarget = `refs/heads/${repo.defaultBranch}`;
    if (symrefs && keep('HEAD')) out.push(`unborn HEAD symref-target:${headTarget}\n`);
    if (keep(headTarget)) out.push(`unborn ${headTarget}\n`);
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD' && !symrefs) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  }
  const parts: Buffer[] = out.map((line) => pktLine(line));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

function fetchV2(repo: Repo, lines: readonly string[]): HttpResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line === 'deepen-relative') deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted.
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new Error(`fetch names a bad object id ${JSON.stringify(oid)}`);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth, deepenRelative);
  const pack = writePack(plan.objects);

  const parts: Buffer[] = [];
  // Protocol v2: the acknowledgments section exists only when the client sent haves.
  // A fresh clone sends none, and real git rejects an acknowledgments section there.
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    // Negotiation is done in a single round: "ready" tells the client no more haves
    // are needed and the packfile follows. Without it real git waits for more acks.
    parts.push(pktLine('ready\n'));
    // Sections are separated by DELIM when more follow; only the last ends with FLUSH.
    // git dies ("expected packfile to be sent after 'ready'") on a FLUSH here.
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

function uploadPackV0(repo: Repo, body: Buffer): HttpResult {
  // Section 1 (wants/shallow/deepen) ends at the first flush; section 2 (haves/done) at the next.
  const first = decodeUntilFlush(body);
  const rest = body.subarray(first.consumed);
  let secondPackets: Pkt[] = [];
  if (rest.length > 0) {
    try {
      secondPackets = decodeUntilFlush(rest).packets;
    } catch {
      secondPackets = decodePktLines(rest).packets;
    }
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  for (const raw of dataTexts(first.packets)) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const token = line.slice(5).split(' ')[0]!;
      wants.push(token);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line === 'deepen-relative') deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  for (const raw of dataTexts(secondPackets)) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new Error(`fetch names a bad object id ${JSON.stringify(oid)}`);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth, deepenRelative);
  const pack = writePack(plan.objects);

  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// git-receive-pack (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return jsonError(404, `Repository ${owner}/${repoName} not found`);
  try {
    return receivePack(repo, body);
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : String(err));
  }
}

function receivePack(repo: Repo, body: Buffer): HttpResult {
  const { packets, consumed } = decodeUntilFlush(body);
  const lines = dataTexts(packets);
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  lines.forEach((raw, index) => {
    const line = raw.replace(/\n$/, '');
    let text = line;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
        text = line.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!) || !parts[2]!.startsWith('refs/')) {
      throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  });
  if (commands.length === 0) throw new Error('receive-pack sent no commands');

  // Unpack the packfile first: a refused update must still unpack.
  const packBytes = body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => getObject(repo, oid) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  // Validate every command against the pre-push refs, then apply the ok ones.
  const snapshot = new Map(repo.refs);
  const verdicts: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = snapshot.get(command.ref);
    if (!unpackOk) {
      verdicts.push({ ref: command.ref, ok: false, reason: unpackDetail });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        verdicts.push({ ref: command.ref, ok: false, reason: `cannot lock ref '${command.ref}': is at ${current} but expected ${command.oldOid}` });
      } else {
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must exist.
    const target: GitObject | undefined = repo.objects.get(command.newOid);
    if (!target) {
      verdicts.push({ ref: command.ref, ok: false, reason: `unable to read ${command.newOid}` });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (command.oldOid !== current) {
      verdicts.push({ ref: command.ref, ok: false, reason: `cannot lock ref '${command.ref}': is at ${current} but expected ${command.oldOid}` });
      continue;
    }
    if (command.oldOid === command.newOid) {
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Fast-forward check on the peeled commits (tags peel to their target commit).
    const oldCommit = peelToCommit(repo, command.oldOid);
    const newCommit = peelToCommit(repo, command.newOid);
    if (oldCommit !== null && newCommit !== null) {
      if (isAncestor(repo, oldCommit, newCommit)) {
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      }
    } else {
      // A non-commit target (a tag object pointing at a blob, ...): git refuses tag moves.
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }

  let refsChanged = false;
  for (let i = 0; i < commands.length; i += 1) {
    const verdict = verdicts[i]!;
    if (!verdict.ok) continue;
    const command = commands[i]!;
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    refsChanged = true;
  }
  if (refsChanged) repo.branchesCache = null;

  // report-status (always sent: the client always negotiates it when advertised).
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const verdict of verdicts) {
    reportLines.push(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`);
  }
  const report = pktLines([...reportLines, 'flush']);
  let responseBody: Buffer;
  if (sideband) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < report.length; offset += 65500) {
      const slice = report.subarray(offset, Math.min(report.length, offset + 65500));
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(PKT_FLUSH);
    responseBody = Buffer.concat(chunks);
  } else {
    responseBody = report;
  }
  void reportStatus;
  return { status: 200, contentType: RECEIVE_RESULT, body: responseBody };
}
