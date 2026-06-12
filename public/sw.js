/*
 * Lucid Service Worker
 *
 * Makes "nothing leaves your machine" literally true offline: the app
 * shell is precached on install, and runtime dependencies (ONNX
 * Runtime, exifr, Tesseract and its language data, downloaded SR
 * models) are cached on first successful fetch. After one online
 * session, Lucid works with the network unplugged — a meaningful
 * property when handling evidence images.
 */

// Bump VERSION on every release: activation deletes all older
// versioned caches, so a deployed update can never be masked by a
// stale shell (the model cache is version-independent and preserved).
const VERSION = 'v2';
const SHELL_CACHE = 'lucid-shell-' + VERSION;
const RUNTIME_CACHE = 'lucid-runtime-' + VERSION;

const SHELL_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './lucid-logo.png',
    './manifest.json',
    './js/app.js',
    './js/annotations.js',
    './js/curves.js',
    './js/enhancements.js',
    './js/filters.js',
    './js/forensics.js',
    './js/histogram.js',
    './js/history.js',
    './js/magnifier.js',
    './js/perspective.js',
    './js/superres.js',
    './js/transform.js',
    './js/utils.js'
];

// Third-party hosts whose immutable, versioned assets are safe to
// cache-first: the CDN libraries, model hosting, and OCR data.
const RUNTIME_HOSTS = [
    'cdn.jsdelivr.net',
    'media.githubusercontent.com',
    'huggingface.co',
    'cdn-lfs.huggingface.co',
    'cdn-lfs-us-1.huggingface.co',
    'tessdata.projectnaptha.com'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== 'lucid-models-v1')
                .map(k => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

function isRuntimeHost(url) {
    // Matches allowlisted hosts including regional CDN subdomains
    return RUNTIME_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        // App shell: NETWORK-FIRST. Fresh code always wins when online
        // (cache is refreshed from the response); the cache only serves
        // when the network is unavailable — i.e. true offline mode.
        // Cache-first here previously caused updates to be masked by a
        // stale shell, which is unacceptable for an evidence tool.
        event.respondWith(
            fetch(req).then(resp => {
                if (resp.ok) {
                    const clone = resp.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, clone));
                }
                return resp;
            }).catch(() => caches.match(req))
        );
        return;
    }

    if (isRuntimeHost(url)) {
        // Versioned/pinned third-party assets: cache-first
        event.respondWith(
            caches.match(req).then(hit => hit || fetch(req).then(resp => {
                // Opaque responses (no-cors script/asset loads) are
                // cacheable too — required for offline replay of CDN
                // scripts loaded without crossorigin attributes
                if (resp.ok || resp.type === 'opaque') {
                    const clone = resp.clone();
                    caches.open(RUNTIME_CACHE).then(c => c.put(req, clone));
                }
                return resp;
            }).catch(() => caches.match(req)))
        );
    }
});
