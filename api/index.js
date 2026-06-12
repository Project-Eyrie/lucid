/*
 * Lucid API Server
 *
 * Express server that serves static files from public directory
 * and provides a status endpoint for health checks.
 *
 * LUCID_THREADS=1 enables cross-origin isolation (COOP/COEP), which
 * lets ONNX Runtime Web use multithreaded WASM (~4-8x faster CPU
 * inference). Tradeoff: COEP blocks cross-origin iframes that don't
 * opt in, so the inline OpenStreetMap GPS embed will not render in
 * this mode (the OSM/Google Maps links still work). Off by default.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.LUCID_THREADS === '1') {
    app.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
    });
    console.log('Cross-origin isolation enabled: multithreaded WASM on, OSM map embed off.');
}

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/status', (req, res) => {
    res.json({
        name: 'Lucid',
        version: '2.2.0',
        status: 'operational'
    });
});

app.listen(PORT, () => {
    console.log(`Lucid running at http://localhost:${PORT}`);
});
