/*
 * Annotation Tools
 *
 * Manages drawing annotations over images including rectangles,
 * circles, arrows, lines, text labels, and blur regions. Supports
 * filled and outline modes, undo functionality, and maintains
 * separate history for annotations and blur operations.
 */

import { getCanvasCoordinates } from './utils.js';
import { applyBlur } from './filters.js';

export class AnnotationManager {
    constructor(canvas, ctx, mainCanvas, mainCtx) {
        // Initializes annotation state and canvas references
        this.canvas = canvas;
        this.ctx = ctx;
        this.mainCanvas = mainCanvas;
        this.mainCtx = mainCtx;
        this.annotations = [];
        this.blurHistory = [];
        this.blurRegions = [];
        this.currentTool = 'select';
        this.isDrawing = false;
        this.startX = 0;
        this.startY = 0;
        this.visible = true;
        this.tabActive = true;
    }

    getScaleFactor() {
        // Calculates scale factor relative to a 1000px reference size
        const refSize = 1000;
        const canvasSize = Math.max(this.canvas.width, this.canvas.height);
        return Math.max(1, canvasSize / refSize);
    }

    getSettings() {
        // Retrieves current annotation settings from UI controls, scaled to image size
        const scale = this.getScaleFactor();
        return {
            color: document.getElementById('annotationColor')?.value || '#ff0000',
            lineWidth: Math.round(parseInt(document.getElementById('lineWidth')?.value || 2) * scale),
            fillMode: document.getElementById('fillMode')?.value || 'outline',
            blurStrength: Math.round(parseInt(document.getElementById('blurStrength')?.value || 20) * scale),
            blurGradient: document.getElementById('blurGradient')?.checked || false,
            text: document.getElementById('annotationText')?.value || '',
            textColor: document.getElementById('textColor')?.value || '#ff0000',
            textSize: Math.round(parseInt(document.getElementById('textSize')?.value || 16) * scale),
            textWeight: document.getElementById('textWeight')?.value || 'normal',
            textFont: document.getElementById('textFont')?.value || 'monospace'
        };
    }

    startDrawing(e) {
        // Begins drawing operation at mouse position
        if (this.currentTool === 'select' || !this.visible || !this.tabActive) return false;

        const coords = getCanvasCoordinates(this.canvas, e);
        this.startX = coords.x;
        this.startY = coords.y;
        this.isDrawing = true;

        if (this.currentTool === 'text') {
            const settings = this.getSettings();
            if (settings.text) {
                const font = `${settings.textWeight} ${settings.textSize}px ${settings.textFont}`;
                this.ctx.save();
                this.ctx.font = font;
                this.ctx.fillStyle = settings.textColor;
                this.ctx.fillText(settings.text, this.startX, this.startY);
                this.ctx.restore();

                this.annotations.push({
                    tool: 'text',
                    x: this.startX,
                    y: this.startY,
                    text: settings.text,
                    color: settings.textColor,
                    fontSize: settings.textSize,
                    fontWeight: settings.textWeight,
                    fontFamily: settings.textFont
                });
            }
            this.isDrawing = false;
        }

        return this.isDrawing;
    }

    draw(e) {
        // Updates drawing preview during mouse drag
        if (!this.isDrawing || !this.visible || !this.tabActive) return;

        const coords = getCanvasCoordinates(this.canvas, e);
        const currentX = coords.x;
        const currentY = coords.y;
        const settings = this.getSettings();

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.redraw();

        this.ctx.strokeStyle = settings.color;
        this.ctx.fillStyle = settings.color;
        this.ctx.lineWidth = settings.lineWidth;
        this.ctx.lineCap = 'round';

        const width = currentX - this.startX;
        const height = currentY - this.startY;

        switch (this.currentTool) {
            case 'rect':
                if (settings.fillMode === 'filled') {
                    this.ctx.fillRect(this.startX, this.startY, width, height);
                } else {
                    this.ctx.strokeRect(this.startX, this.startY, width, height);
                }
                break;

            case 'circle': {
                const radius = Math.sqrt(width * width + height * height);
                this.ctx.beginPath();
                this.ctx.arc(this.startX, this.startY, radius, 0, Math.PI * 2);
                if (settings.fillMode === 'filled') {
                    this.ctx.fill();
                } else {
                    this.ctx.stroke();
                }
                break;
            }

            case 'line':
                this.ctx.beginPath();
                this.ctx.moveTo(this.startX, this.startY);
                this.ctx.lineTo(currentX, currentY);
                this.ctx.stroke();
                break;

            case 'arrow':
                this.drawArrow(this.startX, this.startY, currentX, currentY, settings.color, settings.lineWidth);
                break;

            case 'blur':
                this.ctx.save();
                this.ctx.strokeStyle = 'rgba(0, 100, 255, 0.7)';
                this.ctx.lineWidth = 2;
                this.ctx.setLineDash([5, 5]);
                this.ctx.strokeRect(this.startX, this.startY, width, height);
                this.ctx.restore();
                break;

            case 'measure':
                this.drawMeasureLine(this.startX, this.startY, currentX, currentY);
                break;
        }
    }

    endDrawing(e, imageData) {
        // Completes drawing and saves annotation to history
        if (!this.isDrawing) return null;

        const coords = getCanvasCoordinates(this.canvas, e);
        const endX = coords.x;
        const endY = coords.y;
        const settings = this.getSettings();

        this.isDrawing = false;

        if (this.currentTool === 'blur') {
            return this.applyBlurRegion(endX, endY, settings.blurStrength, imageData, settings.blurGradient);
        }

        if (this.currentTool === 'measure') {
            this.drawMeasureLine(this.startX, this.startY, endX, endY);
            const event = new CustomEvent('measurecomplete', {
                detail: { startX: this.startX, startY: this.startY, endX, endY }
            });
            document.dispatchEvent(event);
            return null;
        }

        const annotation = {
            tool: this.currentTool,
            startX: this.startX,
            startY: this.startY,
            endX,
            endY,
            color: settings.color,
            lineWidth: settings.lineWidth,
            fillMode: settings.fillMode
        };

        this.annotations.push(annotation);
        this.redraw();
        return null;
    }

    applyBlurRegion(endX, endY, strength, imageData, useGradient = false) {
        // Applies blur filter to selected rectangular region
        const x = Math.floor(Math.min(this.startX, endX));
        const y = Math.floor(Math.min(this.startY, endY));
        const width = Math.floor(Math.abs(endX - this.startX));
        const height = Math.floor(Math.abs(endY - this.startY));

        if (width <= 5 || height <= 5) return null;

        const savedRegion = this.mainCtx.getImageData(x, y, width, height);
        this.blurHistory.push({ x, y, width, height, imageData: savedRegion });
        this.blurRegions.push({ x, y, width, height, strength, useGradient });

        const regionData = this.mainCtx.getImageData(x, y, width, height);
        applyBlur(regionData.data, width, height, strength);

        if (useGradient) {
            this.applyGradientFeather(regionData.data, savedRegion.data, width, height);
        }

        this.mainCtx.putImageData(regionData, x, y);

        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x, y, width, height);
        this.ctx.restore();

        setTimeout(() => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.redraw();
        }, 500);

        return this.mainCtx.getImageData(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    }

    applyGradientFeather(blurredData, originalData, width, height) {
        // Blends blur edges with original pixels using distance-based feathering
        const featherSize = Math.min(width, height, 30) / 2;
        for (let py = 0; py < height; py++) {
            for (let px = 0; px < width; px++) {
                const idx = (py * width + px) * 4;
                const minDist = Math.min(px, width - 1 - px, py, height - 1 - py);
                let blend = 1;
                if (minDist < featherSize) {
                    blend = minDist / featherSize;
                }
                blurredData[idx] = originalData[idx] * (1 - blend) + blurredData[idx] * blend;
                blurredData[idx + 1] = originalData[idx + 1] * (1 - blend) + blurredData[idx + 1] * blend;
                blurredData[idx + 2] = originalData[idx + 2] * (1 - blend) + blurredData[idx + 2] * blend;
            }
        }
    }

    drawArrow(fromX, fromY, toX, toY, color, lineWidth) {
        // Draws arrow with line and arrowhead, scaled to image size
        const scale = this.getScaleFactor();
        const headLength = Math.round(15 * scale);
        const angle = Math.atan2(toY - fromY, toX - fromX);

        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = lineWidth;

        this.ctx.beginPath();
        this.ctx.moveTo(fromX, fromY);
        this.ctx.lineTo(toX, toY);
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(toX, toY);
        this.ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
        this.ctx.moveTo(toX, toY);
        this.ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
        this.ctx.stroke();
    }

    drawMeasureLine(x1, y1, x2, y2) {
        // Draws a measurement line with endpoints and distance label
        const scale = this.getScaleFactor();
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dist = Math.sqrt(dx * dx + dy * dy);

        this.ctx.save();

        this.ctx.strokeStyle = '#78e030';
        this.ctx.lineWidth = Math.max(1, Math.round(1.5 * scale));
        this.ctx.setLineDash([Math.round(6 * scale), Math.round(4 * scale)]);
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
        this.ctx.setLineDash([]);

        const radius = Math.round(4 * scale);
        [{ x: x1, y: y1 }, { x: x2, y: y2 }].forEach(pt => {
            this.ctx.beginPath();
            this.ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
            this.ctx.fillStyle = '#78e030';
            this.ctx.fill();
            this.ctx.strokeStyle = '#000';
            this.ctx.lineWidth = Math.max(1, scale);
            this.ctx.stroke();
        });

        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const fontSize = Math.round(12 * scale);
        const label = dist.toFixed(1) + 'px';

        this.ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;
        const textWidth = this.ctx.measureText(label).width;
        const pad = Math.round(4 * scale);

        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        this.ctx.fillRect(midX - textWidth / 2 - pad, midY - fontSize / 2 - pad, textWidth + pad * 2, fontSize + pad * 2);
        this.ctx.fillStyle = '#78e030';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(label, midX, midY);

        this.ctx.restore();
    }

    redraw() {
        // Redraws all saved annotations
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        for (const ann of this.annotations) {
            this.ctx.strokeStyle = ann.color;
            this.ctx.fillStyle = ann.color;
            this.ctx.lineWidth = ann.lineWidth || 2;
            this.ctx.lineCap = 'round';

            const width = ann.endX - ann.startX;
            const height = ann.endY - ann.startY;

            switch (ann.tool) {
                case 'rect':
                    if (ann.fillMode === 'filled') {
                        this.ctx.fillRect(ann.startX, ann.startY, width, height);
                    } else {
                        this.ctx.strokeRect(ann.startX, ann.startY, width, height);
                    }
                    break;

                case 'circle': {
                    const radius = Math.sqrt(width * width + height * height);
                    this.ctx.beginPath();
                    this.ctx.arc(ann.startX, ann.startY, radius, 0, Math.PI * 2);
                    if (ann.fillMode === 'filled') {
                        this.ctx.fill();
                    } else {
                        this.ctx.stroke();
                    }
                    break;
                }

                case 'line':
                    this.ctx.beginPath();
                    this.ctx.moveTo(ann.startX, ann.startY);
                    this.ctx.lineTo(ann.endX, ann.endY);
                    this.ctx.stroke();
                    break;

                case 'arrow':
                    this.drawArrow(ann.startX, ann.startY, ann.endX, ann.endY, ann.color, ann.lineWidth);
                    break;

                case 'text': {
                    const font = `${ann.fontWeight || 'normal'} ${ann.fontSize || 16}px ${ann.fontFamily || 'monospace'}`;
                    this.ctx.font = font;
                    this.ctx.fillText(ann.text, ann.x, ann.y);
                    break;
                }
            }
        }
    }

    undo() {
        // Removes last annotation or restores last blurred region
        if (this.blurHistory.length > 0) {
            const lastBlur = this.blurHistory.pop();
            this.mainCtx.putImageData(lastBlur.imageData, lastBlur.x, lastBlur.y);
            return this.mainCtx.getImageData(0, 0, this.mainCanvas.width, this.mainCanvas.height);
        } else if (this.annotations.length > 0) {
            this.annotations.pop();
            this.redraw();
        }
        return null;
    }

    clear() {
        // Clears all annotations from canvas
        this.annotations = [];
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    clearBlurs() {
        // Restores all blurred regions to original state
        while (this.blurHistory.length > 0) {
            const blur = this.blurHistory.pop();
            this.mainCtx.putImageData(blur.imageData, blur.x, blur.y);
        }
        this.blurRegions = [];
        return this.mainCtx.getImageData(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    }

    setTool(tool) {
        // Sets active drawing tool
        this.currentTool = tool;
        this.canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    }

    toggle() {
        // Toggles annotation layer visibility and returns new state
        this.visible = !this.visible;
        this.canvas.style.opacity = this.visible ? '1' : '0';
        return this.visible;
    }

    hideBlurs() {
        // Temporarily restores pre-blur image data without modifying history
        if (this.blurHistory.length === 0) return null;
        for (const blur of this.blurHistory) {
            this.mainCtx.putImageData(blur.imageData, blur.x, blur.y);
        }
        return this.mainCtx.getImageData(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    }

    showBlurs() {
        // Reapplies all blurs from blurRegions without modifying undo history
        if (this.blurRegions.length === 0) return null;
        for (const blur of this.blurRegions) {
            const { x, y, width, height, strength, useGradient } = blur;
            if (x < 0 || y < 0 || x + width > this.mainCanvas.width || y + height > this.mainCanvas.height) continue;

            const regionData = this.mainCtx.getImageData(x, y, width, height);
            const originalData = this.mainCtx.getImageData(x, y, width, height);
            applyBlur(regionData.data, width, height, strength);

            if (useGradient) {
                this.applyGradientFeather(regionData.data, originalData.data, width, height);
            }
            this.mainCtx.putImageData(regionData, x, y);
        }
        return this.mainCtx.getImageData(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    }

    reset() {
        // Resets all annotation state
        this.annotations = [];
        this.blurHistory = [];
        this.blurRegions = [];
    }
}
