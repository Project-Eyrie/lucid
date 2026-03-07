/*
 * Lucid API Server
 *
 * Express server that serves static files from public directory
 * and provides a status endpoint for health checks.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/status', (req, res) => {
    res.json({
        name: 'Lucid',
        version: '2.0.0',
        status: 'operational'
    });
});

app.listen(PORT, () => {
    console.log(`Lucid running at http://localhost:${PORT}`);
});