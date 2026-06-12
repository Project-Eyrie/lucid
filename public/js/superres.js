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

// Sub-Pixel CNN (2016) from the ONNX model zoo, served with Git LFS
// content via media.githubusercontent.com
export const BUILTIN_MODEL_URL =
    'https://media.githubusercontent.com/media/onnx/models/main/validated/vision/super_resolution/sub_pixel_cnn_2016/model/super-resolution-10.onnx';

let ortLoadPromise = null;

function ensureOrtLoaded() {
    // Lazily injects the ONNX Runtime Web script once and configures
    // its WASM asset path to the same CDN directory
    if (window.ort) return Promise.resolve(window.ort);
    if (!ortLoadPromise) {
        ortLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = ORT_BASE + 'ort.min.js';
            script.onload = () => {
                try {
                    window.ort.env.wasm.wasmPaths = ORT_BASE;
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
        this.kind = null;   // 'y224' (built-in) | 'rgb' (custom)
        this.scale = null;
        this.label = '';
    }

    async loadBuiltin(onStatus) {
        // Downloads and initializes the built-in Sub-Pixel CNN model
        const ort = await ensureOrtLoaded();
        onStatus?.('Downloading model (~240 KB)...');
        const resp = await fetch(BUILTIN_MODEL_URL);
        if (!resp.ok) throw new Error('Model download failed (HTTP ' + resp.status + ')');
        const buffer = await resp.arrayBuffer();
        onStatus?.('Initializing model...');
        this.session = await ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] });
        this.kind = 'y224';
        this.scale = 3;
        this.label = 'Sub-Pixel CNN 3x';
        return this;
    }

    async loadCustom(arrayBuffer, name = 'custom model') {
        // Initializes a user-supplied RGB ONNX model from file bytes
        const ort = await ensureOrtLoaded();
        this.session = await ort.InferenceSession.create(arrayBuffer, { executionProviders: ['wasm'] });
        this.kind = 'rgb';
        this.scale = null; // probed on first use
        this.label = name;
        return this;
    }

    async upscale(srcCanvas, onProgress) {
        // Upscales a canvas, returning a new canvas scale-times larger
        if (!this.session) throw new Error('No model loaded');
        if (this.kind === 'y224') return this.upscaleY(srcCanvas, onProgress);
        return this.upscaleRGB(srcCanvas, onProgress);
    }

    async upscaleY(srcCanvas, onProgress) {
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

        const inName = this.session.inputNames[0];
        const outName = this.session.outputNames[0];

        const total = xs.length * ys.length;
        let done = 0;

        for (const ty of ys) {
            for (const tx of xs) {
                const src = pctx.getImageData(tx, ty, tile, tile).data;

                // Luminance plane, normalized to [0,1]
                const y = new Float32Array(tile * tile);
                for (let i = 0, p = 0; p < y.length; i += 4, p++) {
                    y[p] = (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) / 255;
                }

                const tensor = new ort.Tensor('float32', y, [1, 1, tile, tile]);
                const result = await this.session.run({ [inName]: tensor });
                const outY = result[outName].data;
                const oTile = result[outName].dims[2]; // 672

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
        // Determines the scale factor of a custom model from a tiny run
        const ort = window.ort;
        const probe = 64;
        const tensor = new ort.Tensor('float32', new Float32Array(3 * probe * probe), [1, 3, probe, probe]);
        const result = await this.session.run({ [this.session.inputNames[0]]: tensor });
        const dims = result[this.session.outputNames[0]].dims;
        if (!dims || dims.length !== 4 || dims[1] !== 3) {
            throw new Error('Unsupported model output shape — expected NCHW RGB.');
        }
        const scale = dims[3] / probe;
        if (!Number.isInteger(scale) || scale < 1 || scale > 8) {
            throw new Error('Could not determine an integer scale factor from the model.');
        }
        this.scale = scale;
        return scale;
    }

    async upscaleRGB(srcCanvas, onProgress) {
        // Custom path: NCHW float32 RGB in [0,1], dynamic dims, tiled
        const ort = window.ort;
        if (!this.scale) await this.probeScale();
        const scale = this.scale;
        const tile = 128, overlap = 8;
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

        const inName = this.session.inputNames[0];
        const outName = this.session.outputNames[0];
        const plane = tile * tile;

        const total = xs.length * ys.length;
        let done = 0;

        for (const ty of ys) {
            for (const tx of xs) {
                const src = pctx.getImageData(tx, ty, tile, tile).data;

                // Planar RGB tensor in [0,1]
                const input = new Float32Array(3 * plane);
                for (let i = 0, p = 0; p < plane; i += 4, p++) {
                    input[p] = src[i] / 255;
                    input[plane + p] = src[i + 1] / 255;
                    input[2 * plane + p] = src[i + 2] / 255;
                }

                const tensor = new ort.Tensor('float32', input, [1, 3, tile, tile]);
                const result = await this.session.run({ [inName]: tensor });
                const o = result[outName].data;
                const oTile = result[outName].dims[3];
                const oPlane = oTile * oTile;

                const cImg = new ImageData(oTile, oTile);
                const c = cImg.data;
                for (let p = 0; p < oPlane; p++) {
                    const i = p * 4;
                    c[i] = Math.min(255, Math.max(0, o[p] * 255));
                    c[i + 1] = Math.min(255, Math.max(0, o[oPlane + p] * 255));
                    c[i + 2] = Math.min(255, Math.max(0, o[2 * oPlane + p] * 255));
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
