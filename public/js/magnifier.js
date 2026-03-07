/*
 * Magnifier Tool
 *
 * Provides a floating magnification window that follows the cursor
 * over the image. Supports configurable zoom levels, optional pixel
 * grid overlay, crosshair, and real-time pixel color information.
 * Can apply enhancement filters to the magnified region only.
 */

import { rgbToHex } from './utils.js';
import { applySharpen, applyEdgeDetection } from './filters.js';

export class Magnifier {
    constructor(canvas, ctx, settings) {
        // Initializes magnifier with canvas context and settings reference
        this.canvas = canvas;
        this.ctx = ctx;
        this.settings = settings;
    }

    show(mouseX, mouseY, canvasX, canvasY, sourceCanvas, imageData) {
        // Displays magnifier at cursor position with magnified image region
        const { size, level, enhancement, showGrid, showCrosshair, showPixelInfo } = this.settings;

        this.canvas.style.display = 'block';
        this.canvas.style.position = 'fixed';

        const offsetDistance = 20;
        let magX = mouseX + offsetDistance;
        let magY = mouseY + offsetDistance;

        if (magX + size > window.innerWidth) magX = mouseX - size - offsetDistance;
        if (magY + size > window.innerHeight) magY = mouseY - size - offsetDistance;

        this.canvas.style.left = magX + 'px';
        this.canvas.style.top = magY + 'px';
        this.canvas.width = size;
        this.canvas.height = size;

        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, size, size);

        const canvasRect = sourceCanvas.getBoundingClientRect();
        const displayScale = canvasRect.width / sourceCanvas.width;
        const visualSourceSize = (size / level) / displayScale;

        const sx = Math.max(0, Math.min(Math.floor(canvasX - visualSourceSize / 2), sourceCanvas.width - visualSourceSize));
        const sy = Math.max(0, Math.min(Math.floor(canvasY - visualSourceSize / 2), sourceCanvas.height - visualSourceSize));
        const actualSourceWidth = Math.min(visualSourceSize, sourceCanvas.width - sx);
        const actualSourceHeight = Math.min(visualSourceSize, sourceCanvas.height - sy);

        this.ctx.imageSmoothingEnabled = false;

        try {
            this.ctx.drawImage(
                sourceCanvas,
                Math.floor(sx), Math.floor(sy),
                Math.ceil(actualSourceWidth), Math.ceil(actualSourceHeight),
                0, 0, size, size
            );
        } catch (e) {
            console.error('Magnifier draw error:', e);
        }

        if (enhancement !== 'none') {
            const magData = this.ctx.getImageData(0, 0, size, size);
            this.applyEnhancement(magData.data, size, size, enhancement);
            this.ctx.putImageData(magData, 0, 0);
        }

        if (showGrid) this.drawGrid(size, level);
        if (showCrosshair) this.drawCrosshair(size);
        if (showPixelInfo) this.showPixelInfo(mouseX, mouseY, canvasX, canvasY, imageData, sourceCanvas.width);
    }

    applyEnhancement(data, width, height, type) {
        // Applies selected enhancement filter to magnified region
        switch (type) {
            case 'autoContrast': {
                let min = 255, max = 0;
                for (let i = 0; i < data.length; i += 4) {
                    for (let j = 0; j < 3; j++) {
                        min = Math.min(min, data[i + j]);
                        max = Math.max(max, data[i + j]);
                    }
                }
                const range = max - min || 1;
                for (let i = 0; i < data.length; i += 4) {
                    for (let j = 0; j < 3; j++) {
                        data[i + j] = ((data[i + j] - min) / range) * 255;
                    }
                }
                break;
            }
            case 'channelContrast':
                for (let c = 0; c < 3; c++) {
                    let min = 255, max = 0;
                    for (let i = c; i < data.length; i += 4) {
                        min = Math.min(min, data[i]);
                        max = Math.max(max, data[i]);
                    }
                    const range = max - min || 1;
                    for (let i = c; i < data.length; i += 4) {
                        data[i] = ((data[i] - min) / range) * 255;
                    }
                }
                break;
            case 'normalize': {
                const sum = data.reduce((acc, val, i) => i % 4 === 3 ? acc : acc + val, 0);
                const mean = sum / (data.length * 0.75);
                const variance = data.reduce((acc, val, i) => {
                    if (i % 4 === 3) return acc;
                    return acc + Math.pow(val - mean, 2);
                }, 0) / (data.length * 0.75);
                const std = Math.sqrt(variance) || 1;
                for (let i = 0; i < data.length; i += 4) {
                    for (let j = 0; j < 3; j++) {
                        data[i + j] = Math.min(255, Math.max(0, ((data[i + j] - mean) / std) * 64 + 128));
                    }
                }
                break;
            }
            case 'sharpen':
                applySharpen(data, width, height, 0.5);
                break;
            case 'edge':
                applyEdgeDetection(data, width, height);
                break;
        }
    }

    drawGrid(size, level) {
        // Draws pixel grid overlay on magnified view
        this.ctx.strokeStyle = 'rgba(0, 255, 0, 0.2)';
        this.ctx.lineWidth = 0.5;
        const gridSize = level;

        for (let i = 0; i <= (size / level); i++) {
            this.ctx.beginPath();
            this.ctx.moveTo(i * gridSize, 0);
            this.ctx.lineTo(i * gridSize, size);
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.moveTo(0, i * gridSize);
            this.ctx.lineTo(size, i * gridSize);
            this.ctx.stroke();
        }
    }

    drawCrosshair(size) {
        // Draws center crosshair on magnified view
        this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.7)';
        this.ctx.lineWidth = 1;
        const centerX = Math.floor(size / 2);
        const centerY = Math.floor(size / 2);

        this.ctx.beginPath();
        this.ctx.moveTo(centerX + 0.5, 0);
        this.ctx.lineTo(centerX + 0.5, size);
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(0, centerY + 0.5);
        this.ctx.lineTo(size, centerY + 0.5);
        this.ctx.stroke();
    }

    showPixelInfo(mouseX, mouseY, canvasX, canvasY, imageData, width) {
        // Displays RGB/HEX color values at cursor position
        const pixelInfo = document.getElementById('pixelInfo');
        pixelInfo.style.display = 'block';
        pixelInfo.style.position = 'fixed';
        pixelInfo.style.left = (mouseX + 10) + 'px';
        pixelInfo.style.top = (mouseY - 40) + 'px';

        const idx = (Math.floor(canvasY) * width + Math.floor(canvasX)) * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        const hex = rgbToHex(r, g, b);

        pixelInfo.innerHTML = `RGB: ${r},${g},${b}<br>HEX: ${hex}<br>POS: ${Math.floor(canvasX)},${Math.floor(canvasY)}`;
    }

    hide() {
        // Hides magnifier and pixel info display
        this.canvas.style.display = 'none';
        document.getElementById('pixelInfo').style.display = 'none';
    }
}
