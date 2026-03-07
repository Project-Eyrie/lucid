/*
 * Transform Controls
 *
 * Manages image transformations including zoom, rotation, flip,
 * pan, and crop operations. Uses CSS transforms for hardware-
 * accelerated rendering with requestAnimationFrame batching
 * for smooth performance during real-time adjustments.
 */

import { getCanvasCoordinates } from './utils.js';

export class TransformManager {
    constructor(canvas, annotationCanvas, overlayCanvas) {
        // Initializes transform state with default values
        this.canvas = canvas;
        this.annotationCanvas = annotationCanvas;
        this.overlayCanvas = overlayCanvas;
        this.transform = { zoom: 100, rotate: 0, flipH: false, flipV: false, panX: 0, panY: 0 };
        this.cropMode = false;
        this.cropStart = null;
        this.cropRect = null;
        this.cropListeners = {};
        this.pendingApply = false;
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
    }

    apply() {
        // Applies current transform state using GPU-accelerated CSS
        if (this.pendingApply) return;
        this.pendingApply = true;

        requestAnimationFrame(() => {
            const { zoom, rotate, flipH, flipV, panX, panY } = this.transform;
            const scale = zoom / 100;
            const scaleX = flipH ? -scale : scale;
            const scaleY = flipV ? -scale : scale;

            const transform = `translate(${panX}px, ${panY}px) scale3d(${scaleX}, ${scaleY}, 1) rotate(${rotate}deg)`;
            this.canvas.style.transform = transform;
            this.annotationCanvas.style.transform = `translate(-50%, -50%) ${transform}`;
            if (this.overlayCanvas) {
                this.overlayCanvas.style.transform = `translate(-50%, -50%) ${transform}`;
            }
            this.pendingApply = false;
        });
    }

    startPan(clientX, clientY) {
        // Begins pan operation from current mouse position
        this.isPanning = true;
        this.panStart = {
            x: clientX - this.transform.panX,
            y: clientY - this.transform.panY
        };
    }

    updatePan(clientX, clientY) {
        // Updates pan offset during drag operation
        if (!this.isPanning) return;
        this.transform.panX = clientX - this.panStart.x;
        this.transform.panY = clientY - this.panStart.y;
        this.apply();
    }

    endPan() {
        // Completes pan operation
        this.isPanning = false;
    }

    setZoom(value) {
        // Sets zoom level as percentage
        this.transform.zoom = value;
        this.apply();
    }

    setRotate(value) {
        // Sets rotation angle in degrees
        this.transform.rotate = value;
        this.apply();
    }

    rotate90(clockwise = true) {
        // Rotates image by 90 degrees in specified direction
        this.transform.rotate = clockwise
            ? (this.transform.rotate + 90) % 360
            : (this.transform.rotate - 90 + 360) % 360;
        if (this.transform.rotate > 180) this.transform.rotate -= 360;
        this.apply();
        return this.transform.rotate;
    }

    toggleFlipH() {
        // Toggles horizontal flip state
        this.transform.flipH = !this.transform.flipH;
        this.apply();
        return this.transform.flipH;
    }

    toggleFlipV() {
        // Toggles vertical flip state
        this.transform.flipV = !this.transform.flipV;
        this.apply();
        return this.transform.flipV;
    }

    reset() {
        // Resets all transform values to defaults
        this.transform = { zoom: 100, rotate: 0, flipH: false, flipV: false, panX: 0, panY: 0 };
        this.isPanning = false;
        this.canvas.style.transform = '';
        this.annotationCanvas.style.transform = 'translate(-50%, -50%)';
        if (this.overlayCanvas) {
            this.overlayCanvas.style.transform = 'translate(-50%, -50%)';
        }
    }

    toggleCrop(annotationCtx, redrawFn) {
        // Toggles crop mode and returns crop rect when exiting
        this.cropMode = !this.cropMode;

        if (this.cropMode) {
            this.cropRect = null;
            this.setupCropListeners(annotationCtx, redrawFn);
        } else {
            this.removeCropListeners(annotationCtx, redrawFn);
            if (this.cropRect) {
                return this.cropRect;
            }
        }
        return null;
    }

    setupCropListeners(annotationCtx, redrawFn) {
        // Attaches mouse listeners for crop selection
        this.cropListeners.mousedown = (e) => {
            if (!this.cropMode) return;
            const coords = getCanvasCoordinates(this.annotationCanvas, e);
            this.cropStart = coords;
            this.cropRect = null;
        };

        this.cropListeners.mousemove = (e) => {
            if (!this.cropMode || !this.cropStart) return;
            const coords = getCanvasCoordinates(this.annotationCanvas, e);

            this.cropRect = {
                x: Math.min(this.cropStart.x, coords.x),
                y: Math.min(this.cropStart.y, coords.y),
                width: Math.abs(coords.x - this.cropStart.x),
                height: Math.abs(coords.y - this.cropStart.y)
            };

            this.drawCropOverlay(annotationCtx, redrawFn);
        };

        this.cropListeners.mouseup = () => {
            if (!this.cropMode) return;
            this.cropStart = null;
        };

        this.annotationCanvas.addEventListener('mousedown', this.cropListeners.mousedown);
        this.annotationCanvas.addEventListener('mousemove', this.cropListeners.mousemove);
        this.annotationCanvas.addEventListener('mouseup', this.cropListeners.mouseup);
    }

    removeCropListeners(annotationCtx, redrawFn) {
        // Removes crop listeners and clears overlay
        if (this.cropListeners.mousedown) {
            this.annotationCanvas.removeEventListener('mousedown', this.cropListeners.mousedown);
            this.annotationCanvas.removeEventListener('mousemove', this.cropListeners.mousemove);
            this.annotationCanvas.removeEventListener('mouseup', this.cropListeners.mouseup);
        }
        annotationCtx.clearRect(0, 0, this.annotationCanvas.width, this.annotationCanvas.height);
        redrawFn();
    }

    drawCropOverlay(annotationCtx, redrawFn) {
        // Draws semi-transparent crop selection overlay
        annotationCtx.clearRect(0, 0, this.annotationCanvas.width, this.annotationCanvas.height);
        redrawFn();

        if (this.cropRect && this.cropRect.width > 0 && this.cropRect.height > 0) {
            annotationCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            annotationCtx.fillRect(0, 0, this.annotationCanvas.width, this.annotationCanvas.height);
            annotationCtx.clearRect(this.cropRect.x, this.cropRect.y, this.cropRect.width, this.cropRect.height);

            annotationCtx.strokeStyle = '#fff';
            annotationCtx.lineWidth = 2;
            annotationCtx.setLineDash([5, 5]);
            annotationCtx.strokeRect(this.cropRect.x, this.cropRect.y, this.cropRect.width, this.cropRect.height);
            annotationCtx.setLineDash([]);
        }
    }

    clearCrop() {
        // Clears crop selection
        this.cropRect = null;
    }
}
