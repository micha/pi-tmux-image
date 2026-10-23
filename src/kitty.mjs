import { DIACRITICS } from './kitty-diacritics.mjs';

export { DIACRITICS };
export const MAX_ID = 0xffffff;
export const MAX_GRID_DIMENSION = DIACRITICS.length;
export const PLACEHOLDER = String.fromCodePoint(0x10eeee);
// Below Kitty's 4096-byte base64 limit; leaves generous tmux framing headroom.
export const DEFAULT_CHUNK_SIZE = 2048;
export const DEFAULT_MAX_PNG_BYTES = 64 * 1024 * 1024;
const ESC = '\x1b';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validateId(id, name = 'imageId') {
  if (!Number.isInteger(id) || id < 1 || id > MAX_ID) {
    throw new RangeError(`${name} must be a nonzero 24-bit integer`);
  }
  return id;
}

export function validateGrid({ columns, rows }) {
  for (const [name, value] of Object.entries({ columns, rows })) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_GRID_DIMENSION) {
      throw new RangeError(`${name} must be between 1 and ${MAX_GRID_DIMENSION}`);
    }
  }
  return { columns, rows };
}

/** One tmux layer only. Returns bytes as a string; never writes to a terminal. */
export function wrapTmux(sequence) {
  if (typeof sequence !== 'string') throw new TypeError('sequence must be a string');
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`;
}

function command(controls, payload) {
  return wrapTmux(`${ESC}_G${controls}${payload === undefined ? '' : `;${payload}`}${ESC}\\`);
}

/** Transmit only (a=t). Each array item is a complete individually wrapped APC. */
export function encodePngUpload(png, imageId, {
  chunkSize = DEFAULT_CHUNK_SIZE,
  maxBytes = DEFAULT_MAX_PNG_BYTES,
} = {}) {
  validateId(imageId);
  if (!Number.isInteger(chunkSize) || chunkSize < 4 || chunkSize > 4096 || chunkSize % 4) {
    throw new RangeError('chunkSize must be a multiple of 4 between 4 and 4096');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < PNG_SIGNATURE.length) {
    throw new RangeError('maxBytes must be a safe integer of at least 8');
  }
  if (!(png instanceof Uint8Array)) throw new TypeError('png must be a Uint8Array');
  if (png.byteLength > maxBytes) throw new RangeError('PNG exceeds maxBytes');
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length <= PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new TypeError('png must contain a PNG signature and image data');
  }
  // This is a bounded encoder, not a PNG decoder/validator.
  const base64 = bytes.toString('base64');
  const commands = [];
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    const more = offset + chunkSize < base64.length ? 1 : 0;
    const controls = offset === 0
      ? `a=t,f=100,t=d,i=${imageId},q=2,m=${more}`
      : `m=${more},q=2`;
    commands.push(command(controls, base64.slice(offset, offset + chunkSize)));
  }
  return commands;
}

export function encodeVirtualPlacement({ imageId, placementId, columns, rows }) {
  validateId(imageId);
  validateId(placementId, 'placementId');
  validateGrid({ columns, rows });
  return command(`a=p,U=1,i=${imageId},p=${placementId},c=${columns},r=${rows},q=2`);
}

/** All three marks are explicit: no neighboring cell/high-byte inheritance. */
export function encodePlaceholderCell(row, column) {
  for (const value of [row, column]) {
    if (!Number.isInteger(value) || value < 0 || value >= MAX_GRID_DIMENSION) {
      throw new RangeError(`cell coordinates must be between 0 and ${MAX_GRID_DIMENSION - 1}`);
    }
  }
  return PLACEHOLDER + DIACRITICS[row] + DIACRITICS[column] + DIACRITICS[0];
}

function color(id) {
  return `${id >>> 16};${(id >>> 8) & 255};${id & 255}`;
}

/** Only SGR and independently addressable placeholder cells, no uploads/cursors. */
export function encodePlaceholderRows({ imageId, placementId, columns, rows }) {
  validateId(imageId);
  validateId(placementId, 'placementId');
  validateGrid({ columns, rows });
  // SGR 0 also clears inherited underline/background/style. Placement uses underline
  // color, not the underline text attribute. Colon form is standard for SGR 58.
  const prefix = `${ESC}[0m${ESC}[38;2;${color(imageId)}m${ESC}[58:2::${color(placementId).replaceAll(';', ':')}m`;
  return Array.from({ length: rows }, (_, row) => {
    let line = prefix;
    for (let column = 0; column < columns; column++) line += encodePlaceholderCell(row, column);
    return line + `${ESC}[0m`;
  });
}
