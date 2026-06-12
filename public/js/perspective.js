/*
 * Perspective Correction
 *
 * Four-point perspective warp for deskewing documents, screens, and
 * license plates photographed at an angle. The user marks the four
 * corners of the skewed quadrilateral; a homography is solved that
 * maps it to an upright rectangle, and the image is resampled via
 * inverse mapping with bilinear interpolation.
 */

function solveLinearSystem(A, b) {
    // Solves Ax = b via Gaussian elimination with partial pivoting (n=8)
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
        }
        if (Math.abs(M[pivot][col]) < 1e-10) return null;
        [M[col], M[pivot]] = [M[pivot], M[col]];

        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const factor = M[r][col] / M[col][col];
            for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
        }
    }
    return M.map((row, i) => row[n] / row[i]);
}

function computeHomography(srcPts, dstPts) {
    // Computes the 3x3 homography mapping srcPts -> dstPts (4 point pairs)
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
        const { x: sx, y: sy } = srcPts[i];
        const { x: dx, y: dy } = dstPts[i];
        A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]); b.push(dx);
        A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]); b.push(dy);
    }
    const h = solveLinearSystem(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function invertHomography(H) {
    // Inverts a 3x3 matrix via the adjugate
    const [a, b, c, d, e, f, g, h, i] = H;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    return [
        (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
        (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
        (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det
    ];
}

function orderCorners(points) {
    // Orders 4 arbitrary points as [topLeft, topRight, bottomRight, bottomLeft]
    // top-left has the smallest x+y, bottom-right the largest;
    // the remaining two are split by x position.
    const sorted = [...points];
    const tl = sorted.reduce((m, p) => (p.x + p.y < m.x + m.y ? p : m));
    const br = sorted.reduce((m, p) => (p.x + p.y > m.x + m.y ? p : m));
    const rest = sorted.filter(p => p !== tl && p !== br);
    const tr = rest[0].x > rest[1].x ? rest[0] : rest[1];
    const bl = rest[0].x > rest[1].x ? rest[1] : rest[0];
    return [tl, tr, br, bl];
}

export function perspectiveWarp(sourceCanvas, corners) {
    // Warps the quadrilateral defined by `corners` (any order) to an
    // upright rectangle. Returns a new canvas with the corrected region.
    const [tl, tr, br, bl] = orderCorners(corners);

    const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
    const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);

    const outW = Math.max(8, Math.round(Math.max(widthTop, widthBottom)));
    const outH = Math.max(8, Math.round(Math.max(heightLeft, heightRight)));

    const dst = [
        { x: 0, y: 0 }, { x: outW - 1, y: 0 },
        { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }
    ];

    const H = computeHomography([tl, tr, br, bl], dst);
    if (!H) return null;
    const Hinv = invertHomography(H);
    if (!Hinv) return null;

    const srcCtx = sourceCanvas.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
    const sw = sourceCanvas.width, sh = sourceCanvas.height;

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const outCtx = out.getContext('2d');
    const outImage = outCtx.createImageData(outW, outH);
    const o = outImage.data;

    for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
            const w = Hinv[6] * x + Hinv[7] * y + Hinv[8];
            const sx = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / w;
            const sy = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / w;

            const oi = (y * outW + x) * 4;
            if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
                o[oi + 3] = 255;
                continue;
            }

            const x0 = Math.floor(sx), y0 = Math.floor(sy);
            const fx = sx - x0, fy = sy - y0;
            const i00 = (y0 * sw + x0) * 4;
            const i10 = i00 + 4;
            const i01 = i00 + sw * 4;
            const i11 = i01 + 4;

            for (let c = 0; c < 3; c++) {
                o[oi + c] =
                    srcData[i00 + c] * (1 - fx) * (1 - fy) +
                    srcData[i10 + c] * fx * (1 - fy) +
                    srcData[i01 + c] * (1 - fx) * fy +
                    srcData[i11 + c] * fx * fy;
            }
            o[oi + 3] = 255;
        }
    }

    outCtx.putImageData(outImage, 0, 0);
    return out;
}
