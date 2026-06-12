/*
 * Annotation Tools
 *
 * Manages drawing annotations over images including rectangles,
 * circles, arrows, lines, text labels, measurements, and blur regions.
 *
 * Blur regions are stored as parameters only (rect + strength), never
 * as pixel snapshots: the application re-renders blurs from the live
 * pipeline whenever enhancements change, so undo and toggling can
 * never restore stale pixels. Every completed action is reported via
 * the onAction callback so the application can record it on the
 * unified undo/redo stack.
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
        this.blurRegions = [];
        this.currentTool = 'select';
        this.isDrawing = false;
        this.startX = 0;
        this.startY = 0;
        this.visible = true;
        this.tabActive = true;
        this.onAction = null; // callback({ type, data }) for the history stack
    }

    notifyAction(action) {
        // Reports a completed action for history recording
        if (this.onAction) this.onAction(action);
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
                const annotation = {
                    tool: 'text',
                    x: this.startX,
                    y: this.startY,
                    text: settings.text,
                    color: settings.textColor,
                    fontSize: settings.textSize,
                    fontWeight: settings.textWeight,
                    fontFamily: settings.textFont
                };
                this.annotations.push(annotation);
                this.redraw();
                this.notifyAction({ type: 'annotation', data: annotation });
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

    endDrawing(e) {
        // Completes drawing, saves the annotation, and reports it for history
        if (!this.isDrawing) return;

        const coords = getCanvasCoordinates(this.canvas, e);
        const endX = coords.x;
        const endY = coords.y;
        const settings = this.getSettings();

        this.isDrawing = false;

        if (this.currentTool === 'blur') {
            this.commitBlurRegion(endX, endY, settings.blurStrength, settings.blurGradient);
            return;
        }

        if (this.currentTool === 'measure') {
            const annotation = {
                tool: 'measure',
                startX: this.startX,
                startY: this.startY,
                endX,
                endY
            };
            this.annotations.push(annotation);
            this.redraw();
            this.notifyAction({ type: 'annotation', data: annotation });
            document.dispatchEvent(new CustomEvent('measurecomplete', {
                detail: { startX: this.startX, startY: this.startY, endX, endY }
            }));
            return;
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
        this.notifyAction({ type: 'annotation', data: annotation });
    }

    commitBlurRegion(endX, endY, strength, useGradient = false) {
        // Records a blur region (parameters only) and reports it for history.
        // Pixel application is performed by the owner's render pipeline.
        const x = Math.max(0, Math.floor(Math.min(this.startX, endX)));
        const y = Math.max(0, Math.floor(Math.min(this.startY, endY)));
        const width = Math.floor(Math.abs(endX - this.startX));
        const height = Math.floor(Math.abs(endY - this.startY));

        if (width <= 5 || height <= 5) return;

        const region = { x, y, width, height, strength, useGradient };
        this.blurRegions.push(region);

        // Brief confirmation outline on the annotation layer
        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x, y, width, height);
        this.ctx.restore();
        setTimeout(() => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.redraw();
        }, 500);

        this.notifyAction({ type: 'blur', data: region });
    }

    applyBlursTo(ctx) {
        // Applies all blur regions to the given context from its current
        // pixels. Called by the render pipeline after enhancements and
        // filters, so blurs always reflect the live image state.
        for (const region of this.blurRegions) {
            const x = Math.max(0, Math.min(region.x, this.mainCanvas.width - 1));
            const y = Math.max(0, Math.min(region.y, this.mainCanvas.height - 1));
            const width = Math.min(region.width, this.mainCanvas.width - x);
            const height = Math.min(region.height, this.mainCanvas.height - y);
            if (width < 2 || height < 2) continue;

            const regionData = ctx.getImageData(x, y, width, height);
            const originalData = region.useGradient
                ? new Uint8ClampedArray(regionData.data)
                : null;

            applyBlur(regionData.data, width, height, region.strength);

            if (region.useGradient) {
                this.applyGradientFeather(regionData.data, originalData, width, height);
            }
            ctx.putImageData(regionData, x, y);
        }
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

    addAnnotation(annotation) {
        // Re-adds an annotation (used by redo)
        this.annotations.push(annotation);
        this.redraw();
    }

    removeAnnotation(annotation) {
        // Removes a specific annotation (used by undo)
        const idx = this.annotations.indexOf(annotation);
        if (idx !== -1) this.annotations.splice(idx, 1);
        this.redraw();
    }

    addBlurRegion(region) {
        // Re-adds a blur region (used by redo); caller re-renders
        this.blurRegions.push(region);
    }

    removeBlurRegion(region) {
        // Removes a specific blur region (used by undo); caller re-renders
        const idx = this.blurRegions.indexOf(region);
        if (idx !== -1) this.blurRegions.splice(idx, 1);
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
        // Redraws all saved annotations (measurements included, so they
        // survive overlay refreshes instead of vanishing mid-inspection)
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

                case 'measure':
                    this.drawMeasureLine(ann.startX, ann.startY, ann.endX, ann.endY);
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

    clear() {
        // Clears all annotations from canvas
        this.annotations = [];
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    clearBlurs() {
        // Removes all blur regions; caller re-renders the pipeline
        this.blurRegions = [];
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

    reset() {
        // Resets all annotation state
        this.annotations = [];
        this.blurRegions = [];
        this.isDrawing = false;
    }
}
