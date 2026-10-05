// Helpers for H.264 Annex-B streams.

/** Iterates the NAL units of an Annex-B buffer (start codes 00 00 01 / 00 00 00 01). */
export function* nalUnits(data: Uint8Array): Generator<Uint8Array> {
  let i = 0;
  let start = -1;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && data[end - 1] === 0) end--; // 4-byte start code
        yield data.subarray(start, end);
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) yield data.subarray(start);
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/**
 * Builds the WebCodecs codec string (`avc1.PPCCLL`) from the first SPS
 * (NAL type 7): profile_idc, constraint flags and level_idc.
 */
export function avcCodecFromAnnexB(data: Uint8Array): string | null {
  for (const nal of nalUnits(data)) {
    const header = nal[0];
    if (header === undefined || (header & 0x1f) !== 7 || nal.length < 4) continue;
    return `avc1.${hex2(nal[1] ?? 0)}${hex2(nal[2] ?? 0)}${hex2(nal[3] ?? 0)}`;
  }
  return null;
}

/** True if the buffer contains an IDR slice (NAL type 5). */
export function containsIdr(data: Uint8Array): boolean {
  for (const nal of nalUnits(data)) {
    if (((nal[0] ?? 0) & 0x1f) === 5) return true;
  }
  return false;
}
