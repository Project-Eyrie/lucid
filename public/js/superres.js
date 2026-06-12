/*
 * ML Super-Resolution
 *
 * Neural upscaling that runs entirely in the browser via ONNX Runtime
 * Web (WASM backend). Image pixels never leave the machine — only the
 * runtime (~few MB) and the model weights are fetched once from a CDN
 * and cached by the browser.
 *
 * Two model paths:
 *  - BUILT-IN: the ONNX model zoo "Sub-Pixel CNN" (super-resolution-10,
 *    ~240 KB). Fixed 224x224 luminance input, 3x output. The image is
 *    processed as overlapping Y-channel tiles; chrominance comes from a
 *    bicubic upscale of the same tile, which is perceptually fine since
 *    the eye is far less sensitive to color resolution than luminance.
 *  - CUSTOM: any user-supplied .onnx taking NCHW float32 RGB in [0,1]
 *    with dynamic spatial dims (the shape Real-ESRGAN exports use). The
 *    scale factor is probed automatically from a tiny test run.
 *
 * Tiles overlap and the overlapping margins are discarded on stitching
 * so seams from edge artifacts are not visible in the output.
 */

const ORT_VERSION = '1.18.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

import { applyDenoising, applyCLAHE, applyUnsharpMask } from './filters.js';

// Sub-Pixel CNN (2016) from the ONNX model zoo, served with Git LFS
// content via media.githubusercontent.com
export const BUILTIN_MODEL_URL =
    'https://media.githubusercontent.com/media/onnx/models/main/validated/vision/super_resolution/sub_pixel_cnn_2016/model/super-resolution-10.onnx';

// Downloadable higher-quality models. URLs are user-editable in the UI
// because third-party hosting can move; any mirror of the same .onnx
// works. Models must take NCHW float32 RGB in [0,1] (fixed or dynamic
// spatial dims — both are handled).
//
// The Real-ESRGAN URL is pinned to an immutable commit: the repo's
// current main branch no longer carries the raw .onnx (Qualcomm moved
// release binaries out of the tree), but Hugging Face serves files
// from any historical revision. Pinning also makes the published
// SHA-256 below meaningful as an integrity check.
export const DOWNLOADABLE_MODELS = {
    realesrcompact: {
        label: 'RealESR-general x4v3 (compact)',
        filename: 'realesr-general-x4v3.onnx',
        url: 'https://huggingface.co/OwlMaster/AllFilesRope/resolve/d783e61585b3d83a85c91ca8a3b299e8ade94d72/realesr-general-x4v3.onnx',
        sha256: '09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4'
    },
    realesrgan: {
        label: 'Real-ESRGAN x4plus',
        filename: 'Real-ESRGAN-x4plus.onnx',
        url: 'https://huggingface.co/qualcomm/Real-ESRGAN-x4plus/resolve/01179a4da7bf5ac91faca650e6afbf282ac93933/Real-ESRGAN-x4plus.onnx',
        sha256: '4e1ae0e47f80d9f4aa2a317c24fde2cb3e49a5381eed6e1d509b4001a4b97ad2'
    }
};

let ortLoadPromise = null;

export class SRCancelledError extends Error {
    constructor() {
        // Distinguishes user cancellation from genuine failures
        super('Super-resolution cancelled');
        this.name = 'SRCancelledError';
        this.cancelled = true;
    }
}

function throwIfAborted(signal) {
    // Raises a cancellation error when the abort signal has fired.
    // Checked at tile boundaries: a WASM inference call cannot be
    // interrupted mid-run, so this is the cancellation granularity.
    if (signal?.aborted) throw new SRCancelledError();
}

function ensureOrtLoaded() {
    // Lazily injects ONNX Runtime Web once. The webgpu bundle is used
    // (it includes the WASM backend as fallback) so GPU-capable
    // browsers run models orders of magnitude faster. WASM compute is
    // proxied to a worker so the UI thread never blocks mid-tile, and
    // when the page is cross-origin isolated (see server/index.js) ORT
    // automatically uses multithreaded WASM.
    if (window.ort) return Promise.resolve(window.ort);
    if (!ortLoadPromise) {
        ortLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = ORT_BASE + 'ort.webgpu.min.js';
            script.crossOrigin = 'anonymous';
            script.onload = () => {
                try {
                    window.ort.env.wasm.wasmPaths = ORT_BASE;
                    window.ort.env.wasm.proxy = true;
                } catch {}
                resolve(window.ort);
            };
            script.onerror = () => {
                ortLoadPromise = null;
                reject(new Error('Could not load ONNX Runtime Web from CDN — check your connection.'));
            };
            document.head.appendChild(script);
        });
    }
    return ortLoadPromise;
}

async function createSession(ort, buffer) {
    // Prefers the WebGPU execution provider, falling back to WASM.
    // Tried in sequence because EP availability is only known at
    // session-creation time (no adapter, unsupported ops, etc.).
    if (navigator.gpu) {
        try {
            return await ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'] });
        } catch (err) {
            console.warn('WebGPU EP unavailable, falling back to WASM:', err?.message);
        }
    }
    return ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] });
}

const MODEL_CACHE = 'lucid-models-v1';
let persistRequested = false;

async function cachedModelFetch(url, onStatus, signal, streamProgress = true) {
    // Fetches model bytes through the Cache API: the browser HTTP cache
    // happily evicts 67 MB files, so verified downloads are stored in a
    // named cache (with best-effort persistent storage) making the
    // download genuinely one-time — and available fully offline.
    if ('caches' in window) {
        try {
            const cache = await caches.open(MODEL_CACHE);
            const hit = await cache.match(url);
            if (hit) {
                onStatus?.('Loading model from local cache...');
                return await hit.arrayBuffer();
            }
        } catch {}
    }

    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`Model download failed (HTTP ${resp.status}). The hosting URL may have moved — paste a mirror URL and retry.`);

    let buffer;
    if (streamProgress && resp.body && resp.body.getReader) {
        const total = parseInt(resp.headers.get('content-length') || '0');
        const totalLabel = total ? ` / ${(total / 1048576).toFixed(1)} MB` : '';
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onStatus?.(`Downloading ${(received / 1048576).toFixed(1)} MB${totalLabel}...`, total ? received / total : null);
        }
        const merged = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        buffer = merged.buffer;
    } else {
        buffer = await resp.arrayBuffer();
    }

    if ('caches' in window) {
        try {
            if (!persistRequested) {
                persistRequested = true;
                navigator.storage?.persist?.();
            }
            const cache = await caches.open(MODEL_CACHE);
            await cache.put(url, new Response(buffer.slice(0), {
                headers: { 'Content-Type': 'application/octet-stream' }
            }));
        } catch {}
    }
    return buffer;
}

export async function clearModelCache() {
    // Removes all locally cached model files
    if ('caches' in window) {
        try { return await caches.delete(MODEL_CACHE); } catch {}
    }
    return false;
}

function tilePositions(extent, tile, step) {
    // Returns tile origins along one axis so tiles of `tile` px cover
    // [0, extent), with the last tile flush against the far edge
    const positions = [];
    for (let p = 0; ; p += step) {
        if (p + tile >= extent) {
            positions.push(extent - tile);
            break;
        }
        positions.push(p);
    }
    return [...new Set(positions)];
}

function padCanvasToMin(src, minSize) {
    // Pads a canvas to at least minSize on each axis by replicating the
    // last row/column, so small images can still fill a model tile
    const W = src.width, H = src.height;
    const PW = Math.max(W, minSize), PH = Math.max(H, minSize);
    if (PW === W && PH === H) return src;

    const c = document.createElement('canvas');
    c.width = PW;
    c.height = PH;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.drawImage(src, 0, 0);
    if (PW > W) x.drawImage(src, W - 1, 0, 1, H, W, 0, PW - W, H);
    if (PH > H) x.drawImage(src, 0, H - 1, W, 1, 0, H, W, PH - H);
    if (PW > W && PH > H) x.drawImage(src, W - 1, H - 1, 1, 1, W, H, PW - W, PH - H);
    return c;
}

function yieldToUI() {
    // Lets the event loop breathe between tiles so progress can paint
    return new Promise(resolve => setTimeout(resolve, 0));
}

export class SuperResolver {
    constructor() {
        // Holds the loaded inference session and model characteristics
        this.session = null;
        this.kind = null;       // 'y224' (built-in) | 'rgb' (custom/downloaded)
        this.scale = null;
        this.label = '';
        this.fixedTile = null;  // set when the model has a fixed input size
        this.modelBytes = null; // retained for downloaded models (save-to-disk)
        this.filename = 'model.onnx';
    }

    async loadBuiltin(onStatus, signal = null) {
        // Downloads (or loads from cache) the built-in Sub-Pixel CNN
        const ort = await ensureOrtLoaded();
        onStatus?.('Fetching model (~240 KB)...');
        const buffer = await cachedModelFetch(BUILTIN_MODEL_URL, onStatus, signal, false);
        onStatus?.('Initializing model...');
        this.session = await createSession(ort, buffer);
        this.kind = 'y224';
        this.scale = 3;
        this.label = 'Sub-Pixel CNN 3x';
        return this;
    }

    async loadFromUrl(url, label, filename, onStatus, expectedSha256 = null, signal = null) {
        // Downloads an RGB model (or loads it from the local model
        // cache), keeping the bytes so the user can save the model to
        // disk for offline reuse. When the URL is the pinned default,
        // the bytes are verified against the published SHA-256 before
        // any inference runs.
        const ort = await ensureOrtLoaded();
        onStatus?.('Connecting...');
        const buffer = await cachedModelFetch(url, onStatus, signal, true);

        if (expectedSha256) {
            onStatus?.('Verifying SHA-256...');
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            const hex = Array.from(new Uint8Array(digest))
                .map(b => b.toString(16).padStart(2, '0')).join('');
            if (hex !== expectedSha256) {
                try { (await caches.open(MODEL_CACHE)).delete(url); } catch {}
                throw new Error('Model integrity check failed — downloaded bytes do not match the published SHA-256. Refusing to load.');
            }
        }

        onStatus?.('Initializing model...');
        this.session = await createSession(ort, buffer);
        this.kind = 'rgb';
        this.scale = null;
        this.label = label;
        this.filename = filename;
        this.modelBytes = buffer;
        return this;
    }

    saveModelToDisk() {
        // Offers the downloaded model bytes as a file download so it
        // can be reused offline through the CUSTOM model path
        if (!this.modelBytes) return false;
        const blob = new Blob([this.modelBytes], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = this.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        return true;
    }

    async loadCustom(arrayBuffer, name = 'custom model') {
        // Initializes a user-supplied RGB ONNX model from file bytes
        const ort = await ensureOrtLoaded();
        this.session = await createSession(ort, arrayBuffer);
        this.kind = 'rgb';
        this.scale = null; // probed on first use
        this.label = name;
        return this;
    }

    async upscale(srcCanvas, onProgress, signal = null, opts = {}) {
        // Upscales a canvas, returning a new canvas scale-times larger.
        // opts.ensemble enables 8-variant test-time augmentation.
        if (!this.session) throw new Error('No model loaded');
        if (this.kind === 'y224') return this.upscaleY(srcCanvas, onProgress, signal, opts);
        return this.upscaleRGB(srcCanvas, onProgress, signal, opts);
    }

    async runTilePlanes(planes, n, ensemble) {
        // Runs the model on planar float input (1 plane for luminance
        // models, 3 for RGB), optionally as an 8-variant self-ensemble.
        // Returns averaged output planes plus the output tile size.
        const ort = window.ort;
        const inName = this.session.inputNames[0];
        const outName = this.session.outputNames[0];
        const variants = ensemble ? TTA_VARIANTS : [TTA_VARIANTS[0]];
        const C = planes.length;

        let accum = null;
        let oN = 0;
        for (const { k, flip } of variants) {
            const input = new Float32Array(C * n * n);
            for (let c = 0; c < C; c++) {
                input.set(transformPlane(planes[c], n, k, flip), c * n * n);
            }
            const tensor = new ort.Tensor('float32', input, [1, C, n, n]);
            const result = await this.session.run({ [inName]: tensor });
            const o = result[outName].data;
            oN = result[outName].dims[3];
            if (!accum) accum = Array.from({ length: C }, () => new Float32Array(oN * oN));
            for (let c = 0; c < C; c++) {
                const slice = o.subarray ? o.subarray(c * oN * oN, (c + 1) * oN * oN)
                    : o.slice(c * oN * oN, (c + 1) * oN * oN);
                const restored = inverseTransformPlane(slice, oN, k, flip);
                const acc = accum[c];
                for (let i = 0; i < acc.length; i++) acc[i] += restored[i];
            }
        }
        const inv = 1 / variants.length;
        for (const acc of accum) {
            for (let i = 0; i < acc.length; i++) acc[i] *= inv;
        }
        return { planes: accum, size: oN };
    }

    async upscaleY(srcCanvas, onProgress, signal = null, opts = {}) {
        // Built-in path: 224x224 luminance tiles, 3x output, color from
        // a bicubic upscale of the same tile (BT.601 YCbCr recombine)
        const ort = window.ort;
        const tile = 224, overlap = 12, scale = 3;
        const W = srcCanvas.width, H = srcCanvas.height;

        const padded = padCanvasToMin(srcCanvas, tile);
        const PW = padded.width, PH = padded.height;
        const pctx = padded.getContext('2d', { willReadFrequently: true });

        const step = tile - 2 * overlap;
        const xs = tilePositions(PW, tile, step);
        const ys = tilePositions(PH, tile, step);

        const out = document.createElement('canvas');
        out.width = W * scale;
        out.height = H * scale;
        const outCtx = out.getContext('2d');

        // Reusable scratch canvas for the bicubic color upscale
        const colorCanvas = document.createElement('canvas');
        colorCanvas.width = colorCanvas.height = tile * scale;
        const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
        colorCtx.imageSmoothingEnabled = true;
        colorCtx.imageSmoothingQuality = 'high';

        const total = xs.length * ys.length;
        let done = 0;

        for (const ty of ys) {
            for (const tx of xs) {
                throwIfAborted(signal);
                const src = pctx.getImageData(tx, ty, tile, tile).data;

                // Luminance plane, normalized to [0,1]
                const y = new Float32Array(tile * tile);
                for (let i = 0, p = 0; p < y.length; i += 4, p++) {
                    y[p] = (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) / 255;
                }

                const { planes: [outY], size: oTile } = await this.runTilePlanes([y], tile, opts.ensemble);

                // Chrominance from a smooth upscale of the same region
                colorCtx.drawImage(padded, tx, ty, tile, tile, 0, 0, oTile, oTile);
                const cImg = colorCtx.getImageData(0, 0, oTile, oTile);
                const c = cImg.data;

                for (let i = 0, p = 0; p < outY.length; i += 4, p++) {
                    const r = c[i], g = c[i + 1], b = c[i + 2];
                    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
                    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
                    const ny = Math.min(255, Math.max(0, outY[p] * 255));
                    c[i] = Math.min(255, Math.max(0, ny + 1.402 * (cr - 128)));
                    c[i + 1] = Math.min(255, Math.max(0, ny - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)));
                    c[i + 2] = Math.min(255, Math.max(0, ny + 1.772 * (cb - 128)));
                    c[i + 3] = 255;
                }

                this.stitchTile(outCtx, cImg, tx, ty, tile, overlap, scale, PW, PH);
                done++;
                onProgress?.(done, total);
                await yieldToUI();
            }
        }

        return out;
    }

    async probeScale() {
        // Determines the scale factor of an RGB model and whether its
        // input shape is dynamic or fixed. Mobile-targeted ESRGAN
        // exports often have a fixed input (e.g. 1x3x128x128), which is
        // handled by locking the tile size to the working probe size.
        const ort = window.ort;
        const inName = this.session.inputNames[0];
        const outName = this.session.outputNames[0];

        const tryRun = async (size) => {
            const tensor = new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]);
            const result = await this.session.run({ [inName]: tensor });
            return result[outName].dims;
        };

        let workingSize = null;
        let dims = null;
        let firstError = null;
        for (const size of [64, 128, 256, 512]) {
            try {
                dims = await tryRun(size);
                workingSize = size;
                break;
            } catch (err) {
                firstError = firstError || err;
            }
        }
        if (!workingSize) {
            throw new Error('Model rejected all probe input shapes — expected NCHW float32 RGB. ' + (firstError?.message || ''));
        }
        if (!dims || dims.length !== 4 || dims[1] !== 3) {
            throw new Error('Unsupported model output shape — expected NCHW RGB.');
        }
        const scale = dims[3] / workingSize;
        if (!Number.isInteger(scale) || scale < 1 || scale > 8) {
            throw new Error('Could not determine an integer scale factor from the model.');
        }
        this.scale = scale;

        // Second probe at a different size distinguishes dynamic dims
        // from a fixed input shape
        const altSize = workingSize === 64 ? 128 : 64;
        try {
            await tryRun(altSize);
            this.fixedTile = null; // dynamic — free tile choice
        } catch {
            this.fixedTile = workingSize;
        }
        return scale;
    }

    async upscaleRGB(srcCanvas, onProgress, signal = null, opts = {}) {
        // Custom path: NCHW float32 RGB in [0,1], tiled. Tile size is
        // free for dynamic-dim models, or locked to the model's fixed
        // input size when probing detected one.
        const ort = window.ort;
        if (!this.scale) await this.probeScale();
        const scale = this.scale;
        const tile = this.fixedTile || 128;
        const overlap = Math.max(4, Math.min(16, Math.floor(tile / 16)));
        const W = srcCanvas.width, H = srcCanvas.height;

        const padded = padCanvasToMin(srcCanvas, tile);
        const PW = padded.width, PH = padded.height;
        const pctx = padded.getContext('2d', { willReadFrequently: true });

        const step = tile - 2 * overlap;
        const xs = tilePositions(PW, tile, step);
        const ys = tilePositions(PH, tile, step);

        const out = document.createElement('canvas');
        out.width = W * scale;
        out.height = H * scale;
        const outCtx = out.getContext('2d');

        const plane = tile * tile;

        const total = xs.length * ys.length;
        let done = 0;

        for (const ty of ys) {
            for (const tx of xs) {
                throwIfAborted(signal);
                const src = pctx.getImageData(tx, ty, tile, tile).data;

                // Planar RGB in [0,1]
                const rP = new Float32Array(plane);
                const gP = new Float32Array(plane);
                const bP = new Float32Array(plane);
                for (let i = 0, p = 0; p < plane; i += 4, p++) {
                    rP[p] = src[i] / 255;
                    gP[p] = src[i + 1] / 255;
                    bP[p] = src[i + 2] / 255;
                }

                const { planes: [oR, oG, oB], size: oTile } = await this.runTilePlanes([rP, gP, bP], tile, opts.ensemble);
                const oPlane = oTile * oTile;

                const cImg = new ImageData(oTile, oTile);
                const c = cImg.data;
                for (let p = 0; p < oPlane; p++) {
                    const i = p * 4;
                    c[i] = Math.min(255, Math.max(0, oR[p] * 255));
                    c[i + 1] = Math.min(255, Math.max(0, oG[p] * 255));
                    c[i + 2] = Math.min(255, Math.max(0, oB[p] * 255));
                    c[i + 3] = 255;
                }

                this.stitchTile(outCtx, cImg, tx, ty, tile, overlap, scale, PW, PH);
                done++;
                onProgress?.(done, total);
                await yieldToUI();
            }
        }

        return out;
    }

    stitchTile(outCtx, tileImage, tx, ty, tile, overlap, scale, PW, PH) {
        // Writes a processed tile into the output, discarding overlap
        // margins on interior edges so tile-border artifacts never show
        const sx = tx === 0 ? 0 : overlap;
        const sy = ty === 0 ? 0 : overlap;
        const ex = tx + tile >= PW ? tile : tile - overlap;
        const ey = ty + tile >= PH ? tile : tile - overlap;

        outCtx.putImageData(
            tileImage,
            tx * scale, ty * scale,
            sx * scale, sy * scale,
            (ex - sx) * scale, (ey - sy) * scale
        );
    }
}

/* ============================================================
   TEXT / PLATE MODE
   Domain-specific processing around the neural upscale, tuned for
   license plates, signage, and screen text:

   1. PRE  — 3x3 median denoise + chroma-only smoothing. Sensor and
      compression noise is the main thing SR models amplify into fake
      strokes; chroma noise in particular contributes nothing to
      legibility and is safe to suppress aggressively.
   2. SR   — the neural upscale (any loaded model).
   3. IBP  — iterative back-projection: the result is repeatedly
      downscaled, compared against the true source, and the residual
      is projected back up. This enforces "the upscale must actually
      explain the observed pixels", measurably tightening stroke edges
      and suppressing hallucinated detail — exactly the failure mode
      that matters for forensic reading of characters.
   4. POST — gentle CLAHE for stroke/background separation plus a
      small-radius unsharp mask tuned for character edges.
   ============================================================ */

export function preprocessForText(canvas) {
    // Median-denoises and smooths chroma in place before inference
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyDenoising(img.data, canvas.width, canvas.height);
    smoothChroma(img.data, canvas.width, canvas.height, 2);
    ctx.putImageData(img, 0, 0);
}

function smoothChroma(data, width, height, radius) {
    // Box-blurs only the Cb/Cr planes (BT.601), leaving luminance —
    // and therefore stroke detail — untouched
    const n = width * height;
    const yP = new Float32Array(n);
    const cbP = new Float32Array(n);
    const crP = new Float32Array(n);

    for (let i = 0, p = 0; p < n; i += 4, p++) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        yP[p] = 0.299 * r + 0.587 * g + 0.114 * b;
        cbP[p] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        crP[p] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }

    boxBlurPlane(cbP, width, height, radius);
    boxBlurPlane(crP, width, height, radius);

    for (let i = 0, p = 0; p < n; i += 4, p++) {
        const Y = yP[p], cb = cbP[p] - 128, cr = crP[p] - 128;
        data[i] = Math.min(255, Math.max(0, Y + 1.402 * cr));
        data[i + 1] = Math.min(255, Math.max(0, Y - 0.344136 * cb - 0.714136 * cr));
        data[i + 2] = Math.min(255, Math.max(0, Y + 1.772 * cb));
    }
}

function boxBlurPlane(plane, width, height, radius) {
    // Separable box blur on a single float plane (horizontal + vertical)
    const temp = new Float32Array(plane.length);

    for (let y = 0; y < height; y++) {
        let sum = 0, count = 0;
        for (let x = 0; x <= radius && x < width; x++) { sum += plane[y * width + x]; count++; }
        for (let x = 0; x < width; x++) {
            temp[y * width + x] = sum / count;
            const add = x + radius + 1;
            if (add < width) { sum += plane[y * width + add]; count++; }
            const rem = x - radius;
            if (rem >= 0) { sum -= plane[y * width + rem]; count--; }
        }
    }
    for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let y = 0; y <= radius && y < height; y++) { sum += temp[y * width + x]; count++; }
        for (let y = 0; y < height; y++) {
            plane[y * width + x] = sum / count;
            const add = y + radius + 1;
            if (add < height) { sum += temp[add * width + x]; count++; }
            const rem = y - radius;
            if (rem >= 0) { sum -= temp[rem * width + x]; count--; }
        }
    }
}

export async function backProject(srcCanvas, upCanvas, iterations = 2, alpha = 0.75, onProgress, signal = null) {
    // Iterative back-projection: refines `upCanvas` in place so that
    // downscaling it reproduces `srcCanvas`. Each iteration downscales
    // the current estimate, computes the residual against the true
    // source, bilinearly projects the residual back up, and adds it.
    const W = srcCanvas.width, H = srcCanvas.height;
    const UW = upCanvas.width, UH = upCanvas.height;
    const scaleX = UW / W, scaleY = UH / H;

    const srcData = srcCanvas.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, W, H).data;

    const upCtx = upCanvas.getContext('2d', { willReadFrequently: true });

    // Scratch canvas for high-quality downscaling
    const down = document.createElement('canvas');
    down.width = W;
    down.height = H;
    const downCtx = down.getContext('2d', { willReadFrequently: true });
    downCtx.imageSmoothingEnabled = true;
    downCtx.imageSmoothingQuality = 'high';

    for (let it = 0; it < iterations; it++) {
        throwIfAborted(signal);
        downCtx.clearRect(0, 0, W, H);
        downCtx.drawImage(upCanvas, 0, 0, UW, UH, 0, 0, W, H);
        const downData = downCtx.getImageData(0, 0, W, H).data;

        // Residual in source space (signed, per RGB channel)
        const res = new Float32Array(W * H * 3);
        for (let i = 0, p = 0; p < W * H; i += 4, p++) {
            res[p * 3] = srcData[i] - downData[i];
            res[p * 3 + 1] = srcData[i + 1] - downData[i + 1];
            res[p * 3 + 2] = srcData[i + 2] - downData[i + 2];
        }

        // Project the residual up with bilinear sampling and add
        const upImg = upCtx.getImageData(0, 0, UW, UH);
        const u = upImg.data;
        for (let y = 0; y < UH; y++) {
            const sy = Math.min(H - 1, Math.max(0, (y + 0.5) / scaleY - 0.5));
            const y0 = Math.floor(sy), y1 = Math.min(H - 1, y0 + 1);
            const fy = sy - y0;
            for (let x = 0; x < UW; x++) {
                const sx = Math.min(W - 1, Math.max(0, (x + 0.5) / scaleX - 0.5));
                const x0 = Math.floor(sx), x1 = Math.min(W - 1, x0 + 1);
                const fx = sx - x0;

                const p00 = (y0 * W + x0) * 3, p10 = (y0 * W + x1) * 3;
                const p01 = (y1 * W + x0) * 3, p11 = (y1 * W + x1) * 3;
                const i = (y * UW + x) * 4;

                for (let c = 0; c < 3; c++) {
                    const r =
                        res[p00 + c] * (1 - fx) * (1 - fy) +
                        res[p10 + c] * fx * (1 - fy) +
                        res[p01 + c] * (1 - fx) * fy +
                        res[p11 + c] * fx * fy;
                    u[i + c] = Math.min(255, Math.max(0, u[i + c] + alpha * r));
                }
            }
        }
        upCtx.putImageData(upImg, 0, 0);
        onProgress?.(it + 1, iterations);
        await new Promise(r => setTimeout(r, 0));
    }
}

export function postprocessForText(canvas) {
    // Stroke-tuned finishing: gentle local contrast to separate
    // characters from the plate background, then a small-radius
    // unsharp mask that bites on character edges but not flat areas
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyCLAHE(img.data, canvas.width, canvas.height, 1.8, 6);
    applyUnsharpMask(img.data, canvas.width, canvas.height, 0.8, 1, 2);
    ctx.putImageData(img, 0, 0);
}

/* ============================================================
   SELF-ENSEMBLE (x8 test-time augmentation)
   Standard SR quality technique: each tile is inferred 8 times — the
   4 rotations of the original and of its mirror — outputs are
   inverse-transformed back and averaged. Averaging cancels the
   orientation-dependent component of model error, giving a measurable
   PSNR gain at 8x the compute. Transforms are exact index remappings
   on square planes (no resampling), so the ensemble itself introduces
   zero interpolation loss.
   ============================================================ */

export function rotatePlane90(plane, n) {
    // Rotates an n x n plane 90 degrees clockwise: out(x,y) = in(y, n-1-x)
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            out[y * n + x] = plane[(n - 1 - x) * n + y];
        }
    }
    return out;
}

export function flipPlaneH(plane, n) {
    // Mirrors an n x n plane horizontally
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            out[y * n + x] = plane[y * n + (n - 1 - x)];
        }
    }
    return out;
}

export function transformPlane(plane, n, k, flip) {
    // Forward TTA transform: optional horizontal flip, then k clockwise
    // 90-degree rotations
    let p = flip ? flipPlaneH(plane, n) : plane;
    for (let i = 0; i < k; i++) p = rotatePlane90(p, n);
    return p;
}

export function inverseTransformPlane(plane, n, k, flip) {
    // Exact inverse of transformPlane: undo rotations first, then flip
    let p = plane;
    for (let i = 0; i < (4 - k) % 4; i++) p = rotatePlane90(p, n);
    return flip ? flipPlaneH(p, n) : p;
}

export const TTA_VARIANTS = [
    { k: 0, flip: false }, { k: 1, flip: false }, { k: 2, flip: false }, { k: 3, flip: false },
    { k: 0, flip: true },  { k: 1, flip: true },  { k: 2, flip: true },  { k: 3, flip: true }
];
