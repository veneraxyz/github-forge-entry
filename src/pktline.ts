// pkt-line framing for the git smart-HTTP protocol (git's LARGE_PACKET_MAX is 65520).

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse a 4-byte hex pkt-line length header directly from the buffer (no regex/parseInt). */
function readPktLength(bytes: Buffer, offset: number): number {
  let length = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = bytes[offset + i]!;
    let nibble: number;
    if (c >= 48 && c <= 57) nibble = c - 48; // 0-9
    else if (c >= 97 && c <= 102) nibble = c - 87; // a-f
    else if (c >= 65 && c <= 70) nibble = c - 55; // A-F
    else throw new Error(`invalid pkt-line length ${JSON.stringify(bytes.subarray(offset, offset + 4).toString('ascii'))}`);
    length = length * 16 + nibble;
  }
  return length;
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload ${data.length} exceeds ${PKT_LINE_MAX_PAYLOAD}`);
  const packet = Buffer.allocUnsafe(data.length + 4);
  packet.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(packet, 4);
  return packet;
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode a mixed sequence; 'flush'/'delim'/'response-end' are the control packets. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a complete buffer into packets. Returns the packets and the offset of the first byte
 * after the last complete packet (the caller keeps the rest: a receive-pack's packfile follows
 * its command flush, unframed). Throws on a malformed header.
 */
export function decodePktLines(bytes: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error(`truncated pkt-line: ${bytes.length - offset} trailing byte(s)`);
    const length = readPktLength(bytes, offset);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error(`truncated pkt-line: ${length} announced, ${bytes.length - offset} available`);
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/**
 * Decode packets until (and including) the first flush, returning the packets before it and the
 * offset just past the flush. Used for receive-pack command lists and v0 fetch requests, where
 * unframed bytes (a packfile) may follow.
 */
export function decodeUntilFlush(bytes: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error(`truncated pkt-line: ${bytes.length - offset} trailing byte(s)`);
    const length = readPktLength(bytes, offset);
    if (length === 0) return { packets, consumed: offset + 4 };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error(`truncated pkt-line: ${length} announced, ${bytes.length - offset} available`);
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('pkt-line stream ended without a flush');
}

/** The text of every data packet, control packets dropped. */
export function packetTexts(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/** Split a sideband-framed pack into band-1 packets of at most `chunk` bytes of pack data each. */
export function sidebandPack(pack: Buffer, chunk = 65500): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunk) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + chunk));
    // One allocation per packet: 4-byte header + band byte + slice (pktLine would concat twice).
    const packet = Buffer.allocUnsafe(slice.length + 5);
    packet.write((slice.length + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    packet[4] = 1;
    slice.copy(packet, 5);
    out.push(packet);
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}
