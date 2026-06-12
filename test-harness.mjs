/*
 * Lucid smoke harness: a minimal DOM shim sufficient to construct the
 * real ImageForensicsTool and drive end-to-end flows without a browser:
 * image load (metadata panel must populate, with real JPEG bytes and a
 * realistically slow exifr stub that reproduces the reset race), split
 * compare (mousedown+mousemove must move the divider), and region OCR
 * (drag-select must produce recognized text). Any uncaught exception in
 * app code is reported with its stack; exits non-zero on failure.
 */

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err && err.stack || err);
    process.exitCode = 1;
});

const failures = [];

function makeCtx(canvas) {
    const calls = [];
    const ctx = {
        canvas,
        calls,
        fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
        textAlign: '', textBaseline: '', lineCap: '', globalAlpha: 1,
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        getImageData(x, y, w, h) {
            return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
        },
        putImageData(...a) { calls.push(['putImageData']); },
        drawImage(...a) { calls.push(['drawImage', ...a.slice(1)]); },
        fillRect(...a) { calls.push(['fillRect', ...a]); },
        strokeRect() {}, clearRect() {},
        beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
        rect() {}, clip() {}, fill() {}, stroke() {},
        save() {}, restore() {}, setLineDash() {}, translate() {}, scale() {}, rotate() {},
        fillText(...a) { calls.push(['fillText', ...a]); },
        strokeText() {},
        measureText: (t) => ({ width: String(t).length * 6 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
    };
    return ctx;
}

const valueSpan = () => makeEl('span.value');
function makeEl(id) {
    const listeners = {};
    const el = {
        id,
        tagName: 'DIV',
        style: new Proxy({ setProperty(k, v) { this[k] = v; } }, {
            get: (t, k) => t[k] ?? '',
            set: (t, k, v) => { t[k] = v; return true; }
        }),
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c, f) { (f === undefined ? !this._set.has(c) : f) ? this._set.add(c) : this._set.delete(c); },
            contains(c) { return this._set.has(c); }
        },
        dataset: {},
        value: '', checked: false, disabled: false,
        textContent: '', innerHTML: '', title: '',
        files: [],
        width: 0, height: 0, offsetWidth: 800, offsetHeight: 600,
        _listeners: listeners,
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener() {},
        dispatch(type, ev = {}) {
            ev.target = ev.target || el;
            for (const fn of listeners[type] || []) {
                try { fn(ev); } catch (err) {
                    failures.push(`[${id}] ${type} handler threw: ${err.stack}`);
                }
            }
        },
        appendChild(c) { return c; },
        remove() {},
        click() { el.dispatch('click', {}); },
        querySelector(sel) {
            if (!el._qs) el._qs = {};
            if (!el._qs[sel]) el._qs[sel] = makeEl(id + ' ' + sel);
            return el._qs[sel];
        },
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
        getContext(kind) { if (!el._ctx) el._ctx = makeCtx(el); return el._ctx; },
        toDataURL: () => 'data:image/png;base64,AAAA',
        toBlob: (cb) => cb({ arrayBuffer: async () => new ArrayBuffer(8) }),
        focus() {}, setAttribute() {}, removeAttribute(k) { delete el.dataset[k.replace('data-', '')]; }
    };
    el.parentElement = { querySelector: (s) => { if (!el._pq) el._pq = {}; if (!el._pq[s]) el._pq[s] = valueSpan(); return el._pq[s]; } };
    return el;
}

const registry = {};
const docListeners = {};
const doc = {
    getElementById(id) { return registry[id] || (registry[id] = makeEl(id)); },
    createElement(tag) { const e = makeEl('created:' + tag); e.tagName = tag.toUpperCase(); return e; },
    querySelector(sel) { return registry['qs:' + sel] || (registry['qs:' + sel] = makeEl(sel)); },
    querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    head: { appendChild() {} },
    body: { appendChild() {}, tagName: 'BODY' }
};
globalThis.document = doc;
globalThis.window = globalThis;
const winListeners = {};
globalThis.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (cb) => cb();
globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; }, removeItem(k) { delete this._m[k]; } };
Object.defineProperty(globalThis, 'navigator', {
    value: {
        storage: { persist: async () => true },
        serviceWorker: { register: () => Promise.resolve({}) },
        clipboard: { writeText: async () => {} }
    },
    configurable: true
});
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
globalThis.Image = class {
    constructor() { this.width = 400; this.height = 300; }
    set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 10); }
    get src() { return this._src; }
};
globalThis.FileReader = class {
    readAsDataURL() { queueMicrotask(() => this.onload && this.onload({ target: { result: 'data:image/png;base64,AAAA' } })); }
};
globalThis.Tesseract = {
    createWorker: async () => ({
        recognize: async () => ({ data: { text: 'ABC123', confidence: 91 } }),
        terminate: async () => {}
    })
};
globalThis.exifr = {
    parse: async () => {
        await new Promise(r => setTimeout(r, 25));
        return ({
        Make: 'TestCam', Model: 'X1', Software: '<img src=x onerror=alert(1)>',
        DateTimeOriginal: new Date('2024-01-01'), CreateDate: new Date('2024-01-01'),
        ExposureTime: 0.008, FNumber: 1.8, ISO: 100, Orientation: 'Horizontal (normal)',
        latitude: -33.8688, longitude: 151.2093, GPSAltitude: 58.2,
        ApplicationNotes: new Uint8Array([1, 2, 3]),
        nested: { deep: true },
        weird: null
    });
    },
    thumbnail: async () => null
};
globalThis.Blob = globalThis.Blob || class { constructor(parts) { this.parts = parts; } };
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};

const run = async () => {
    await import('./public/js/app.js');

    for (const fn of docListeners['DOMContentLoaded'] || []) {
        try { fn(); } catch (err) { failures.push('CONSTRUCTOR threw: ' + err.stack); }
    }
    if (failures.length) {
        console.error('===== BOOT FAILURES =====');
        failures.forEach(f => console.error(f + '\n'));
        process.exit(1);
    }

    const fs = await import('fs');
    let jpegBytes;
    try {
        jpegBytes = fs.readFileSync(new URL('./test-fixture.jpg', import.meta.url));
    } catch {
        jpegBytes = Buffer.alloc(16);
    }
    const fakeFile = {
        name: 'evidence.jpg', size: jpegBytes.length, type: 'image/jpeg', lastModified: Date.now(),
        arrayBuffer: async () => jpegBytes.buffer.slice(jpegBytes.byteOffset, jpegBytes.byteOffset + jpegBytes.byteLength)
    };
    const imageInput = doc.getElementById('imageUpload');
    imageInput.files = [fakeFile];
    imageInput.dispatch('change', { target: imageInput });

    await new Promise(r => setTimeout(r, 300));

    const exifHtml = doc.getElementById('exifContent').innerHTML;
    const checks = [
        ['parsed EXIF (Make)', exifHtml.includes('TestCam')],
        ['XSS escaped', !exifHtml.includes('<img src=x') && exifHtml.includes('&lt;img')],
        ['GPS section', exifHtml.includes('-33.868800')],
        ['JPEG internals (quant tables)', exifHtml.includes('JPEG INTERNALS') && exifHtml.includes('quant-table')],
        ['quality estimate', exifHtml.includes('Est. quality')],
        ['SHA-256 present', exifHtml.includes('SHA-256')],
        ['no error panel', !exifHtml.includes('METADATA ERROR')]
    ];
    const bad = checks.filter(([, ok]) => !ok);
    if (bad.length === 0) {
        console.log('METADATA FLOW OK — all ' + checks.length + ' content checks pass');
    } else {
        failures.push('METADATA FLOW FAILED — checks failed: ' + bad.map(([n]) => n).join(', ') +
            '\n  innerHTML: ' + JSON.stringify(exifHtml).slice(0, 400));
    }

    doc.getElementById('splitBtn').dispatch('click', {});
    await new Promise(r => setTimeout(r, 10));

    const annCanvas = doc.getElementById('annotationCanvas');
    const ctxCalls = doc.getElementById('mainCanvas').getContext('2d').calls;

    const dividerXs = () => ctxCalls.filter(c => c[0] === 'fillRect' && c[4] >= 290).map(c => c[1]);

    ctxCalls.length = 0;
    annCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 300 });
    const afterDown = dividerXs().slice(-1)[0];

    ctxCalls.length = 0;
    annCanvas.dispatch('mousemove', { clientX: 600, clientY: 300 });
    const afterMove = dividerXs().slice(-1)[0];

    annCanvas.dispatch('mouseup', { clientX: 600, clientY: 300 });

    if (afterDown !== undefined && afterMove !== undefined && Math.abs(afterMove - afterDown) > 50) {
        console.log(`SPLIT DRAG OK — divider moved ${afterDown.toFixed(0)} -> ${afterMove.toFixed(0)}`);
    } else {
        failures.push(`SPLIT DRAG FAILED — divider after mousedown: ${afterDown}, after mousemove: ${afterMove}`);
    }

    doc.getElementById('splitBtn').dispatch('click', {});
    doc.getElementById('ocrRegionBtn').dispatch('click', {});
    annCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 100 });
    annCanvas.dispatch('mousemove', { clientX: 300, clientY: 250 });
    annCanvas.dispatch('mouseup', { clientX: 300, clientY: 250 });
    await new Promise(r => setTimeout(r, 30));

    const ocrText = doc.getElementById('ocrText').textContent;
    if (ocrText === 'ABC123') {
        console.log('REGION OCR OK — selection produced OCR text');
    } else {
        failures.push('REGION OCR FAILED — ocrText = ' + JSON.stringify(ocrText));
    }

    if (failures.length) {
        console.error('\n===== FAILURES =====');
        failures.forEach(f => console.error(f + '\n'));
        process.exit(1);
    }
    console.log('\nALL FLOWS PASS');
};

run().catch(err => { console.error('HARNESS ERROR:', err.stack); process.exit(1); });
