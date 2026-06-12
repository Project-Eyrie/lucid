/*
 * Forensic Analysis
 *
 * Image forensics utilities for manipulation screening:
 *  - Error Level Analysis (ELA): re-compresses the image as JPEG at a
 *    known quality and amplifies the per-pixel difference. Regions that
 *    have been edited and re-saved compress differently and stand out.
 *  - JPEG internals: parses the original file bytes for quantization
 *    tables (a fingerprint of the encoding software/quality) and basic
 *    marker structure.
 *  - Embedded EXIF thumbnail extraction (via exifr): cameras embed a
 *    thumbnail at capture time; a mismatch with the main image betrays
 *    later editing.
 */

export async function computeELA(sourceCanvas, quality = 0.75, amplify = 15) {
    // Re-encodes the canvas as JPEG and returns ImageData of the
    // amplified per-channel absolute difference.
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;

    const blob = await new Promise(resolve =>
        sourceCanvas.toBlob(resolve, 'image/jpeg', quality)
    );
    if (!blob) throw new Error('JPEG encode failed');

    const bitmap = await createImageBitmap(blob);
    const temp = document.createElement('canvas');
    temp.width = w;
    temp.height = h;
    const tctx = temp.getContext('2d');
    tctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const srcCtx = sourceCanvas.getContext('2d');
    const src = srcCtx.getImageData(0, 0, w, h).data;
    const recompressed = tctx.getImageData(0, 0, w, h);
    const rec = recompressed.data;

    const out = new ImageData(w, h);
    const o = out.data;
    for (let i = 0; i < src.length; i += 4) {
        o[i] = Math.min(255, Math.abs(src[i] - rec[i]) * amplify);
        o[i + 1] = Math.min(255, Math.abs(src[i + 1] - rec[i + 1]) * amplify);
        o[i + 2] = Math.min(255, Math.abs(src[i + 2] - rec[i + 2]) * amplify);
        o[i + 3] = 255;
    }
    return out;
}

const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

export function parseJPEGInternals(arrayBuffer) {
    // Walks JPEG markers and extracts quantization tables (DQT segments),
    // frame info (SOF), and the marker sequence. Returns null for non-JPEG.
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;

    const result = { quantTables: [], markers: [], progressive: false, frame: null };
    let pos = 2;

    while (pos < bytes.length - 1) {
        if (bytes[pos] !== 0xFF) { pos++; continue; }
        const marker = bytes[pos + 1];
        pos += 2;

        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
        if (marker === 0xD9) break;
        if (pos + 1 >= bytes.length) break;

        const length = (bytes[pos] << 8) | bytes[pos + 1];
        const segStart = pos + 2;
        const segEnd = pos + length;
        result.markers.push('FF' + marker.toString(16).toUpperCase().padStart(2, '0'));

        if (marker === 0xDB) {
            let p = segStart;
            while (p < segEnd) {
                const precision = bytes[p] >> 4;
                const tableId = bytes[p] & 0x0F;
                p++;
                const zigzagged = new Array(64);
                for (let i = 0; i < 64; i++) {
                    zigzagged[i] = precision === 0
                        ? bytes[p + i]
                        : (bytes[p + i * 2] << 8) | bytes[p + i * 2 + 1];
                }
                p += precision === 0 ? 64 : 128;
                const table = new Array(64);
                for (let i = 0; i < 64; i++) table[ZIGZAG[i]] = zigzagged[i];
                result.quantTables.push({ id: tableId, precision: precision === 0 ? 8 : 16, values: table });
            }
        } else if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            result.frame = {
                bitDepth: bytes[segStart],
                height: (bytes[segStart + 1] << 8) | bytes[segStart + 2],
                width: (bytes[segStart + 3] << 8) | bytes[segStart + 4],
                components: bytes[segStart + 5]
            };
            if (marker === 0xC2) result.progressive = true;
        } else if (marker === 0xDA) {
            pos = segEnd;
            while (pos < bytes.length - 1) {
                if (bytes[pos] === 0xFF && bytes[pos + 1] !== 0x00 &&
                    !(bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7)) break;
                pos++;
            }
            continue;
        }

        pos = segEnd;
    }

    return result;
}

export function estimateJPEGQuality(quantTable) {
    // Rough quality estimate by comparing a luminance table against the
    // IJG standard table scaled per the libjpeg quality formula.
    const STD_LUMA = [
        16, 11, 10, 16, 24, 40, 51, 61,
        12, 12, 14, 19, 26, 58, 60, 55,
        14, 13, 16, 24, 40, 57, 69, 56,
        14, 17, 22, 29, 51, 87, 80, 62,
        18, 22, 37, 56, 68, 109, 103, 77,
        24, 35, 55, 64, 81, 104, 113, 92,
        49, 64, 78, 87, 103, 121, 120, 101,
        72, 92, 95, 98, 112, 100, 103, 99
    ];
    let sumScale = 0;
    for (let i = 0; i < 64; i++) {
        sumScale += (quantTable[i] * 100) / STD_LUMA[i];
    }
    const scale = sumScale / 64;
    const quality = scale <= 100 ? Math.round((200 - scale) / 2) : Math.round(5000 / scale);
    return Math.min(100, Math.max(1, quality));
}

export async function extractEmbeddedThumbnail(file) {
    // Extracts the EXIF-embedded thumbnail (if present) as an object URL.
    // Requires the exifr full build. Returns null when absent.
    if (typeof exifr === 'undefined' || !exifr.thumbnail) return null;
    try {
        const thumbBytes = await exifr.thumbnail(file);
        if (!thumbBytes || thumbBytes.length === 0) return null;
        const blob = new Blob([thumbBytes], { type: 'image/jpeg' });
        return URL.createObjectURL(blob);
    } catch {
        return null;
    }
}
