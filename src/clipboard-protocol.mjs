import { randomUUID } from 'node:crypto';
import { validateClipboardPng } from './clipboard-png.mjs';

const OSC = '\x1b]5522;', ST = '\x1b\\';
const MAX_HEADER = 512, MAX_PACKET = 8192;
const warning = 'Clipboard reply outside the paste dialog detected; that paste was rejected. Protocol text may be in your draft. Inspect it manually; nothing was erased. Stay in this pane while the terminal read is unresolved.';

export function strictBase64(text) {
  if (typeof text !== 'string' || text.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid clipboard encoding.');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw new Error('Invalid clipboard encoding.');
  return bytes;
}
function metadata(text) {
  if (!text || text.length > MAX_HEADER || !/^[a-zA-Z0-9=:_+./-]+$/.test(text)) return;
  const fields = Object.create(null);
  for (const part of text.split(':')) {
    const match = /^([a-z]+)=([A-Za-z0-9=_+./-]+)$/.exec(part);
    if (!match || Object.hasOwn(fields, match[1])) return;
    fields[match[1]] = match[2];
  }
  return fields;
}

/** Runtime-local bounded reader. No terminal effects, subscriptions, messages or submission. */
export function createClipboardReader({ prefix = `piimg-${randomUUID()}`, timeoutMs = 30000,
  maxBytes = 8 * 1024 * 1024, maxPackets = 4096, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {}, onWarning = () => {}, parseKey = () => undefined } = {}) {
  if (!/^[A-Za-z0-9_.+-]{1,80}$/.test(prefix)) throw new TypeError('Invalid clipboard request prefix');
  let issued = 0, active, fragment, disposed = false, lateFragmentWarningShown = false;
  function owned(id) {
    if (typeof id !== 'string' || !id.startsWith(`${prefix}-`)) return false;
    const sequence = id.slice(prefix.length + 1);
    return /^[1-9]\d{0,8}$/.test(sequence) && Number(sequence) <= issued;
  }
  function settle(result, terminalEnded = false) {
    const request = active;
    if (!request) return;
    clearTimer(request.timer);
    request.chunks = []; request.bytes = 0;
    if (!request.settled) { request.settled = true; request.resolve(result); }
    if (terminalEnded) active = undefined;
    else request.discard = true;
    onChange();
  }
  function reject(message) { settle({ ok: false, message, unresolved: true }); }
  function finish(fields, payload = '') {
    if (!active || fields.id !== active.id) return;
    if (++active.packets > maxPackets) reject('Clipboard reply exceeded packet limits; terminal read remains unresolved.');
    const status = fields.status;
    if (['DONE', 'EPERM', 'ENOSYS', 'EBUSY'].includes(status) &&
        (payload || Object.keys(fields).some((key) => !['type', 'status', 'id'].includes(key)))) {
      reject('Malformed clipboard completion; terminal read remains unresolved.');
      return;
    }
    if (['EPERM', 'ENOSYS', 'EBUSY'].includes(status)) {
      settle({ ok: false, message: status === 'EPERM' ? 'Clipboard permission was denied.' : 'Clipboard read is unavailable or busy.', unresolved: false }, true);
      return;
    }
    if (status === 'DONE') {
      if (active.discard) { settle({ ok: false, message: 'Clipboard reply drained; no image imported.', unresolved: false }, true); return; }
      try {
        if (!active.open || !active.bytes || payload || Object.keys(fields).some((key) => !['type', 'status', 'id'].includes(key))) throw new Error();
        const png = Buffer.concat(active.chunks, active.bytes);
        validateClipboardPng(png, { maxBytes });
        const image = Object.freeze({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
        settle({ ok: true, image, unresolved: false }, true);
      } catch { settle({ ok: false, message: 'Clipboard did not contain a supported valid PNG image.', unresolved: false }, true); }
      return;
    }
    if (active.discard) return;
    if (Object.keys(fields).some((key) => !['type', 'status', 'id', 'mime'].includes(key))) { reject('Malformed clipboard response; terminal read remains unresolved.'); return; }
    if (status === 'OK' && !active.open && !fields.mime && !payload) { active.open = true; return; }
    if (status !== 'DATA' || !active.open || !fields.mime || !payload) { reject('Unexpected clipboard response; terminal read remains unresolved.'); return; }
    try {
      if (strictBase64(fields.mime).toString('utf8') !== 'image/png') throw new Error();
      const bytes = strictBase64(payload);
      if (!bytes.length || bytes.length > 4096 || active.bytes + bytes.length > maxBytes) throw new Error();
      active.bytes += bytes.length; active.chunks.push(bytes);
    } catch { reject('Clipboard data was malformed, unsupported or too large; terminal read remains unresolved.'); }
  }
  function warnFragment(id) {
    const current = active?.id === id;
    const shouldWarn = current ? !active.fragmentWarned : !lateFragmentWarningShown;
    if (current) { active.fragmentWarned = true; reject('Fragmented clipboard response; terminal read remains unresolved.'); }
    else lateFragmentWarningShown = true;
    if (shouldWarn) onWarning(warning);
  }
  function packet(data) {
    if (!data.startsWith(OSC) || !data.endsWith(ST)) return false;
    const end = data.indexOf(';', OSC.length);
    const headerEnd = end < 0 ? data.length - ST.length : end;
    const header = data.slice(OSC.length, Math.min(headerEnd, OSC.length + MAX_HEADER));
    const fields = metadata(header);
    // Recognize exact delimited identity separately from validation, so owned
    // malformed packets can be rejected without printing them into the draft.
    const identityHeader = headerEnd - OSC.length > MAX_HEADER ? header.slice(0, header.lastIndexOf(':')) : header;
    const ids = identityHeader.match(/(?:^|:)id=([^:;]+)(?=:|$)/g) || [];
    const types = identityHeader.match(/(?:^|:)type=([^:;]+)(?=:|$)/g) || [];
    const id = ids.length === 1 ? ids[0].replace(/^:?id=/, '') : undefined;
    if (types.length !== 1 || types[0].replace(/^:?type=/, '') !== 'read' || !owned(id)) return false;
    if (headerEnd - OSC.length > MAX_HEADER || !fields || data.length > MAX_PACKET) {
      if (active?.id === id) reject('Malformed or oversized clipboard packet; terminal read remains unresolved.');
      return true;
    }
    finish(fields, end < 0 ? '' : data.slice(end + 1, -ST.length));
    return true;
  }
  // This observer NEVER withholds/replays ambiguous keys or consumes printable
  // payload keystrokes. Only intact owned packets and an identified frame's ST
  // can be consumed. Prefix/payload contamination is deliberately not erased.
  function observeFragment(data) {
    if (data === '\x1b]') { fragment = { header: OSC.slice(0, 2), size: 2, at: now(), body: false, payloadChars: 0, warned: false }; return false; }
    if (!fragment) return false;
    if (now() - fragment.at > 1000 || (data !== ST && (data.length !== 1 || /[^\x20-\x7e]/.test(data)))) { fragment = undefined; return false; }
    fragment.at = now(); fragment.size += data.length;
    if (fragment.size > MAX_PACKET) { fragment = undefined; return false; }
    if (data === ST) {
      const fields = metadata(fragment.header.slice(OSC.length));
      const isOwned = fields?.type === 'read' && owned(fields.id);
      const hasPayload = fragment.payloadChars > 0;
      fragment = undefined;
      if (isOwned) warnFragment(fields.id);
      if (isOwned && ['DONE', 'EPERM', 'ENOSYS', 'EBUSY'].includes(fields.status)) finish(fields, hasPayload ? 'invalid' : '');
      return Boolean(isOwned);
    }
    if (fragment.body) fragment.payloadChars += data.length;
    else {
      fragment.header += data;
      if (fragment.header.length > OSC.length + MAX_HEADER ||
          (!fragment.header.startsWith(OSC) && !OSC.startsWith(fragment.header))) { fragment = undefined; return false; }
      if (fragment.header.startsWith(OSC)) {
        const content = fragment.header.slice(OSC.length);
        const bodyAt = content.indexOf(';');
        const header = bodyAt < 0 ? content : content.slice(0, bodyAt);
        // A field must be delimited before it can establish exact ownership.
        const delimited = bodyAt < 0 ? header.slice(0, header.lastIndexOf(':')) : header;
        const partial = metadata(delimited);
        if (!fragment.warned && partial?.type === 'read' && owned(partial.id)) {
          fragment.warned = true;
          warnFragment(partial.id);
        }
        if (bodyAt >= 0) { fragment.header = OSC + header; fragment.body = true; }
      }
    }
    return false;
  }
  return {
    get state() { return Object.freeze({ waiting: Boolean(active), unresolved: Boolean(active?.discard), issued }); },
    begin() {
      if (disposed || active || issued >= 999999999) throw new Error('A clipboard read is unresolved or this runtime is unavailable. Stay in this pane and resolve the terminal permission prompt.');
      const id = `${prefix}-${++issued}`;
      let resolve;
      const done = new Promise((accept) => { resolve = accept; });
      active = { id, resolve, chunks: [], bytes: 0, packets: 0, open: false, discard: false, settled: false, fragmentWarned: false };
      active.timer = setTimer(() => reject('Clipboard read timed out; its terminal permission prompt may still be pending. Stay in this pane until resolved.'), timeoutMs);
      onChange();
      const request = `${OSC}type=read:id=${id};aW1hZ2UvcG5n${ST}`;
      return { done, request: `\x1bPtmux;${request.replaceAll('\x1b', '\x1b\x1b')}${ST}` };
    },
    rejectFrame(data) {
      if (disposed || !active || typeof data !== 'string' || !data.startsWith(OSC)) return;
      const header = data.slice(OSC.length, OSC.length + MAX_HEADER);
      const match = /(?:^|:)id=([A-Za-z0-9_.+-]+)(?=:|;|$)/.exec(header);
      if (/(?:^|:)type=read(?=:|;|$)/.test(header) && match && match[1] === active.id) {
        reject('Clipboard frame was malformed or oversized; terminal read remains unresolved.');
      }
    },
    input(data) {
      if (disposed || typeof data !== 'string') return;
      if (data.startsWith('\x1b[200~')) { fragment = undefined; return; }
      if (data === '\x1b[O' && active) reject('Terminal focus changed; clipboard import stopped, but its terminal read may remain pending.');
      if (packet(data)) { fragment = undefined; return { consume: true }; }
      const key = parseKey(data);
      const observed = key === 'alt+]' ? '\x1b]' : key === 'alt+\\' ? ST : data;
      if (observeFragment(observed)) return { consume: true };
    },
    cancel() { if (active) reject('Clipboard import cancelled locally; this does not cancel the terminal permission prompt. Stay in this pane until resolved.'); },
    dispose() {
      if (active) settle({ ok: false, message: 'Clipboard runtime closed; late replies cannot be protected after leaving it.', unresolved: true });
      disposed = true; clearTimer(active?.timer); active = undefined; fragment = undefined;
    },
  };
}
