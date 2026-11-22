// Follows the frames of a Zstandard file as its bytes go by, to tell whether
// the file stops before its last frame is complete. Only the frame and block
// headers are read (RFC 8878); nothing is decompressed.
//
// Some Node versions end a cut-off archive without an error, so the reader
// cannot tell a damaged file from a whole one. This can.

const FRAME = 0xfd2fb528;
const SKIPPABLE = 0x184d2a50;

export function createFrameWatch() {
  const head = Buffer.alloc(4);
  let step = 'magic';   // magic, length (of a skippable frame), descriptor, block
  let want = 4;         // header bytes this step needs
  let have = 0;         // header bytes collected so far
  let skip = 0;         // bytes to let pass before the next header
  let checksum = false; // the frame ends with four more bytes
  let closing = false;  // the bytes passing now are the last of a frame
  let frames = 0;
  let foreign = false;  // bytes that are not a frame: not ours to judge

  function next(name, bytes) {
    step = name;
    want = bytes;
    have = 0;
  }

  function decide() {
    if (step === 'magic') {
      const magic = head.readUInt32LE(0);
      if ((magic & 0xfffffff0) >>> 0 === SKIPPABLE) return next('length', 4);
      if (magic !== FRAME) {
        foreign = true;
        return;
      }
      return next('descriptor', 1);
    }
    if (step === 'length') {
      skip = head.readUInt32LE(0);
      return next('magic', 4);
    }
    if (step === 'descriptor') {
      const descriptor = head[0];
      const single = descriptor >> 5 & 1;
      const sized = descriptor >> 6;
      checksum = (descriptor & 4) !== 0;
      // Window descriptor, dictionary id and content size, as flagged.
      skip = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (sized ? [0, 2, 4, 8][sized] : single);
      return next('block', 3);
    }
    const header = head.readUIntLE(0, 3);
    const last = (header & 1) === 1;
    // A run-length block stores one byte whatever its size says.
    skip = ((header >> 1 & 3) === 1 ? 1 : header >> 3) + (last && checksum ? 4 : 0);
    if (!last) return next('block', 3);
    next('magic', 4);
    if (skip === 0) frames++;
    else closing = true;
  }

  return {
    write(chunk) {
      let at = 0;
      while (at < chunk.length && !foreign) {
        if (skip > 0) {
          const pass = Math.min(skip, chunk.length - at);
          skip -= pass;
          at += pass;
          if (skip === 0 && closing) {
            closing = false;
            frames++;
          }
          continue;
        }
        head[have++] = chunk[at++];
        if (have === want) decide();
      }
    },
    // True when the bytes seen so far end inside a frame, or hold none.
    cutShort() {
      return !foreign && (skip > 0 || have > 0 || step !== 'magic' || frames === 0);
    }
  };
}
