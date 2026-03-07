/*
 * Lucid Main Application
 *
 * Browser-based image enhancement and analysis tool. Orchestrates
 * all modules including image loading, enhancements, filters,
 * transforms, annotations, magnifier, curves, histogram, and
 * metadata extraction. Handles user interactions and coordinates
 * between components.
 */

import { Magnifier } from './magnifier.js';
import { AnnotationManager } from './annotations.js';
import { TransformManager } from './transform.js';
import { processEnhancements } from './enhancements.js';
import { CurvesEditor } from './curves.js';
import { HistogramDisplay } from './histogram.js';
import * as Filters from './filters.js';
import { debounce, throttle, rgbToHex } from './utils.js';

class ImageForensicsTool {
    constructor() {
        // Initializes canvas elements, managers, and default settings
        this.canvas = document.getElementById('mainCanvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.annotationCanvas = document.getElementById('annotationCanvas');
        this.annotationCtx = this.annotationCanvas.getContext('2d');
        this.overlayCanvas = document.getElementById('overlayCanvas');
        this.overlayCtx = this.overlayCanvas.getContext('2d');
        this.magnifierCanvas = document.getElementById('magnifierCanvas');
        this.magnifierCtx = this.magnifierCanvas.getContext('2d');

        this.originalImage = null;
        this.watermarkSettings = null;
        this.captionSettings = null;
        this.imageData = null;
        this.spacePressed = false;
        this.colorPickerActive = false;

        this.magnifierSettings = {
            level: 3, size: 150, enhancement: 'none',
            showGrid: false, showPixelInfo: true, showCrosshair: true,
            enabled: true, visible: true
        };

        this.enhancements = {
            brightness: 0, contrast: 0, saturation: 0,
            sharpen: 0, gamma: 1.0, balanceR: 0, balanceG: 0, balanceB: 0
        };

        this.sectionEnabled = {
            adjustments: true,
            colorBalance: true,
            curves: true
        };

        this.magnifier = new Magnifier(this.magnifierCanvas, this.magnifierCtx, this.magnifierSettings);
        this.annotations = new AnnotationManager(this.annotationCanvas, this.annotationCtx, this.canvas, this.ctx);
        this.transform = new TransformManager(this.canvas, this.annotationCanvas, this.overlayCanvas);
        this.applyEnhancementsDebounced = debounce(() => this.applyEnhancements(), 50);
        this.curvesEditor = new CurvesEditor(
            document.getElementById('curvesCanvas'),
            () => this.applyEnhancementsDebounced()
        );
        this.histogram = new HistogramDisplay(document.getElementById('histogramCanvas'));

        this.initEventListeners();
    }

    initEventListeners() {
        // Attaches all UI event handlers
        document.getElementById('imageUpload').addEventListener('change', (e) => this.loadImage(e));

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e));
        });

        ['brightness', 'contrast', 'saturation', 'sharpen'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', (e) => {
                    this.enhancements[id] = parseFloat(e.target.value);
                    e.target.parentElement.querySelector('.value').textContent = e.target.value;
                    this.applyEnhancementsDebounced();
                });
            }
        });

        document.getElementById('gamma').addEventListener('input', (e) => {
            this.enhancements.gamma = parseFloat(e.target.value) / 100;
            e.target.parentElement.querySelector('.value').textContent = this.enhancements.gamma.toFixed(2);
            this.applyEnhancementsDebounced();
        });

        ['balanceR', 'balanceG', 'balanceB'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', (e) => {
                    this.enhancements[id] = parseFloat(e.target.value);
                    e.target.parentElement.querySelector('.value').textContent = e.target.value;
                    this.applyEnhancementsDebounced();
                });
            }
        });

        document.getElementById('resetColorBalance').addEventListener('click', () => this.resetColorBalance());

        document.getElementById('resetCurves').addEventListener('click', () => {
            this.curvesEditor.reset();
        });

        const toggleMap = {
            toggleAdjustments: { key: 'adjustments', section: 'sectionAdjustments' },
            toggleColorBalance: { key: 'colorBalance', section: 'sectionColorBalance' },
            toggleCurves: { key: 'curves', section: 'sectionCurves' }
        };
        Object.entries(toggleMap).forEach(([toggleId, { key, section }]) => {
            document.getElementById(toggleId).addEventListener('change', (e) => {
                this.sectionEnabled[key] = e.target.checked;
                document.getElementById(section).classList.toggle('disabled', !e.target.checked);
                this.applyEnhancementsDebounced();
            });
        });

        document.getElementById('zoomLevel').addEventListener('input', (e) => {
            this.transform.setZoom(parseInt(e.target.value));
            e.target.parentElement.querySelector('.value').textContent = e.target.value + '%';
        });

        document.getElementById('rotateAngle').addEventListener('input', (e) => {
            this.transform.setRotate(parseInt(e.target.value));
            e.target.parentElement.querySelector('.value').textContent = e.target.value + '°';
        });

        document.getElementById('rotate90').addEventListener('click', () => {
            const angle = this.transform.rotate90(true);
            document.getElementById('rotateAngle').value = angle;
            document.getElementById('rotateAngle').parentElement.querySelector('.value').textContent = angle + '°';
        });

        document.getElementById('rotate-90').addEventListener('click', () => {
            const angle = this.transform.rotate90(false);
            document.getElementById('rotateAngle').value = angle;
            document.getElementById('rotateAngle').parentElement.querySelector('.value').textContent = angle + '°';
        });

        document.getElementById('flipH').addEventListener('click', () => {
            const active = this.transform.toggleFlipH();
            document.getElementById('flipH').classList.toggle('active', active);
        });

        document.getElementById('flipV').addEventListener('click', () => {
            const active = this.transform.toggleFlipV();
            document.getElementById('flipV').classList.toggle('active', active);
        });

        document.getElementById('cropBtn').addEventListener('click', () => this.toggleCrop());

        document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
            btn.addEventListener('click', (e) => this.applyFilter(e.target.dataset.filter));
        });

        document.getElementById('magLevel').addEventListener('input', (e) => {
            this.magnifierSettings.level = parseInt(e.target.value);
            e.target.parentElement.querySelector('.value').textContent = e.target.value + 'x';
        });

        document.getElementById('magSize').addEventListener('input', (e) => {
            this.magnifierSettings.size = parseInt(e.target.value);
            e.target.parentElement.querySelector('.value').textContent = e.target.value;
            this.magnifierCanvas.width = this.magnifierCanvas.height = this.magnifierSettings.size;
        });

        document.getElementById('magEnhance').addEventListener('change', (e) => {
            this.magnifierSettings.enhancement = e.target.value;
        });

        ['magGrid', 'magPixelInfo', 'magCrosshair'].forEach((id, i) => {
            const props = ['showGrid', 'showPixelInfo', 'showCrosshair'];
            document.getElementById(id).addEventListener('change', (e) => {
                this.magnifierSettings[props[i]] = e.target.checked;
            });
        });

        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tool = e.target.dataset.tool;
                if (btn.classList.contains('active')) {
                    this.deselectTool();
                } else {
                    this.selectTool(tool);
                }
            });
        });

        document.getElementById('lineWidth').addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value;
        });

        document.getElementById('blurStrength').addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value;
        });

        const wrapper = document.querySelector('.canvas-wrapper');
        const throttledMouseMove = throttle((e) => this.handleMouseMove(e), 16);
        wrapper.addEventListener('mousemove', throttledMouseMove);
        wrapper.addEventListener('mouseleave', () => this.magnifier.hide());

        wrapper.addEventListener('mousedown', (e) => {
            if (e.button === 0 && this.spacePressed) {
                this.transform.startPan(e.clientX, e.clientY);
                wrapper.style.cursor = 'grabbing';
            }
        });

        wrapper.addEventListener('mousemove', (e) => {
            if (this.transform.isPanning) {
                this.transform.updatePan(e.clientX, e.clientY);
            }
        });

        wrapper.addEventListener('mouseup', () => {
            if (this.transform.isPanning) {
                this.transform.endPan();
                wrapper.style.cursor = this.spacePressed ? 'grab' : 'default';
            }
        });

        this.annotationCanvas.addEventListener('mousedown', (e) => {
            if (e.button === 0 && !this.transform.cropMode && !this.spacePressed) {
                if (this.colorPickerActive) {
                    this.pickColor(e);
                } else {
                    this.annotations.startDrawing(e);
                }
            }
        });

        this.annotationCanvas.addEventListener('mousemove', (e) => {
            if (this.annotations.isDrawing && !this.spacePressed) {
                requestAnimationFrame(() => this.annotations.draw(e));
            }
        });

        this.annotationCanvas.addEventListener('mouseup', (e) => {
            if (!this.spacePressed && !this.colorPickerActive) {
                const newImageData = this.annotations.endDrawing(e, this.imageData);
                if (newImageData) this.imageData = newImageData;
            }
        });

        this.annotationCanvas.addEventListener('mouseleave', (e) => {
            if (this.annotations.isDrawing && !this.spacePressed) {
                const newImageData = this.annotations.endDrawing(e, this.imageData);
                if (newImageData) this.imageData = newImageData;
            }
        });

        document.getElementById('resetBtn').addEventListener('click', () => this.reset());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportImage());
        document.getElementById('copyBtn').addEventListener('click', () => this.copyImage());
        document.getElementById('pasteBtn').addEventListener('click', () => this.pasteImage());
        document.getElementById('resetEnhancements').addEventListener('click', () => this.resetEnhancements());
        document.getElementById('resetAdjustments').addEventListener('click', () => this.resetAdjustments());
        document.getElementById('resetTransform').addEventListener('click', () => this.resetTransform());
        document.getElementById('resetFilters').addEventListener('click', () => this.resetFilters());
        document.getElementById('clearAnnotations').addEventListener('click', () => {
            this.annotations.clear();
            this.imageData = this.annotations.clearBlurs();
        });
        document.getElementById('undoAnnotation').addEventListener('click', () => {
            const newImageData = this.annotations.undo();
            if (newImageData) this.imageData = newImageData;
        });

        document.addEventListener('keydown', (e) => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

            if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                const visible = this.annotations.toggle();
                document.getElementById('toggleAnnotations')?.classList.toggle('active', visible);
                this.updateAnnotationVisibilityUI();
            }
            if (e.key === 'm' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.magnifierSettings.visible = !this.magnifierSettings.visible;
                if (!this.magnifierSettings.visible) this.magnifier.hide();
                document.getElementById('toggleMagnifier')?.classList.toggle('active', this.magnifierSettings.visible);
                this.updateMagnifierVisibilityUI();
            }
            if (e.key === 'p' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.selectTool('colorpicker');
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                document.querySelector('[data-tool="colorpicker"]')?.classList.add('active');
                document.getElementById('togglePicker')?.classList.add('active');
            }
            if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                const newImageData = this.annotations.undo();
                if (newImageData) this.imageData = newImageData;
            }
            if (e.key === ' ') {
                e.preventDefault();
                this.spacePressed = true;
                wrapper.style.cursor = 'grab';
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.key === ' ') {
                this.spacePressed = false;
                wrapper.style.cursor = 'default';
            }
        });

        document.getElementById('toggleAnnotations')?.addEventListener('click', () => {
            const btn = document.getElementById('toggleAnnotations');
            const visible = this.annotations.toggle();
            btn.classList.toggle('active', visible);
            this.updateAnnotationVisibilityUI();
            this.overlayCanvas.style.opacity = visible ? '1' : '0';
            if (visible) {
                const newData = this.annotations.showBlurs();
                if (newData) this.imageData = newData;
            } else {
                const newData = this.annotations.hideBlurs();
                if (newData) this.imageData = newData;
            }
        });

        document.getElementById('toggleMagnifier')?.addEventListener('click', () => {
            const btn = document.getElementById('toggleMagnifier');
            this.magnifierSettings.visible = !this.magnifierSettings.visible;
            if (!this.magnifierSettings.visible) this.magnifier.hide();
            btn.classList.toggle('active', this.magnifierSettings.visible);
            this.updateMagnifierVisibilityUI();
        });

        document.getElementById('togglePicker')?.addEventListener('click', () => {
            const btn = document.getElementById('togglePicker');
            if (this.colorPickerActive) {
                this.colorPickerActive = false;
                this.selectTool('rect');
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                document.querySelector('[data-tool="rect"]')?.classList.add('active');
                btn.classList.remove('active');
            } else {
                this.selectTool('colorpicker');
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                document.querySelector('[data-tool="colorpicker"]')?.classList.add('active');
                btn.classList.add('active');
            }
        });

        document.getElementById('advancedToggle').addEventListener('click', () => {
            const section = document.getElementById('advancedSection');
            section.classList.toggle('expanded');
        });

        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.applyPreset(e.target.dataset.preset));
        });

        this.initPanelResize();

        this.checkScreenSize();
        window.addEventListener('resize', () => {
            this.checkScreenSize();
            if (this.originalImage) {
                this.syncAnnotationCanvas();
            }
        });

        document.getElementById('resetPreset')?.addEventListener('click', () => this.resetPreset());

        document.getElementById('watermarkSize')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + 'px';
        });
        document.getElementById('watermarkOpacity')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + '%';
        });
        document.getElementById('watermarkAngle')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + '°';
        });
        document.getElementById('applyWatermark')?.addEventListener('click', () => this.applyWatermark());
        document.getElementById('removeWatermark')?.addEventListener('click', () => this.removeWatermark());

        document.getElementById('captionHeight')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + 'px';
        });
        document.getElementById('captionSize')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + 'px';
        });
        document.getElementById('applyCaption')?.addEventListener('click', () => this.applyCaption());
        document.getElementById('removeCaption')?.addEventListener('click', () => this.removeCaption());

        document.getElementById('watermarkToggle')?.addEventListener('click', () => {
            document.getElementById('watermarkSection')?.classList.toggle('expanded');
        });
        document.getElementById('captionToggle')?.addEventListener('click', () => {
            document.getElementById('captionSection')?.classList.toggle('expanded');
        });

        document.getElementById('textSize')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + 'px';
        });

        wrapper.addEventListener('wheel', (e) => {
            if (!this.originalImage) return;
            e.preventDefault();
            const delta = e.deltaY > 0 ? -10 : 10;
            const currentZoom = this.transform.transform.zoom;
            const newZoom = Math.max(10, Math.min(500, currentZoom + delta));
            this.transform.setZoom(newZoom);
            const zoomEl = document.getElementById('zoomLevel');
            zoomEl.value = newZoom;
            zoomEl.parentElement.querySelector('.value').textContent = newZoom + '%';
        }, { passive: false });

        document.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const blob = item.getAsFile();
                    if (blob) this.loadImageFromBlob(blob);
                    return;
                }
            }
        });

        document.getElementById('toggleAnnotations')?.classList.add('active');
        document.getElementById('toggleMagnifier')?.classList.add('active');
        document.getElementById('toggleSidebar')?.classList.add('active');

        document.getElementById('toggleSidebar')?.addEventListener('click', () => {
            const panel = document.querySelector('.control-panel');
            const btn = document.getElementById('toggleSidebar');
            panel.classList.toggle('collapsed');
            btn.classList.toggle('active', !panel.classList.contains('collapsed'));
            panel.style.width = '';
        });

        document.getElementById('helpBtn')?.addEventListener('click', () => {
            document.getElementById('helpModal').style.display = 'flex';
        });
        document.getElementById('closeHelp')?.addEventListener('click', () => {
            document.getElementById('helpModal').style.display = 'none';
        });
        document.getElementById('helpModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'helpModal') {
                document.getElementById('helpModal').style.display = 'none';
            }
        });

        this.updateAnnotationVisibilityUI();
        this.updateMagnifierVisibilityUI();

        document.addEventListener('measurecomplete', (e) => {
            const { startX, startY, endX, endY } = e.detail;
            this.updateMeasurement(startX, startY, endX, endY);
        });

        document.getElementById('fetchUrlBtn')?.addEventListener('click', () => this.loadImageFromUrl());
        document.getElementById('imageUrlInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.loadImageFromUrl();
        });

        document.getElementById('searchGoogle')?.addEventListener('click', () => this.reverseImageSearch('google'));
        document.getElementById('searchYandex')?.addEventListener('click', () => this.reverseImageSearch('yandex'));
        document.getElementById('searchTineye')?.addEventListener('click', () => this.reverseImageSearch('tineye'));
        document.getElementById('searchBing')?.addEventListener('click', () => this.reverseImageSearch('bing'));

        document.getElementById('runOcr')?.addEventListener('click', () => this.runOCR());
        document.getElementById('copyOcrText')?.addEventListener('click', () => this.copyOcrText());
    }

    updateAnnotationVisibilityUI() {
        // Toggles annotation hidden warning visibility
        const warning = document.getElementById('annotationsHiddenWarning');
        if (warning) {
            warning.style.display = this.annotations.visible ? 'none' : 'flex';
        }
    }

    updateMagnifierVisibilityUI() {
        // Toggles magnifier hidden warning visibility
        const warning = document.getElementById('magnifierHiddenWarning');
        if (warning) {
            warning.style.display = this.magnifierSettings.visible ? 'none' : 'flex';
        }
    }

    loadImage(e) {
        // Loads image file and initializes canvas
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                this.resetForNewImage();
                this.originalImage = img;
                this.setupCanvas();
                this.drawImage();
                this.extractEXIF(file);
                this.updateStatusBar();
                this.updateThumbnail();
                this.updateHistogram();
            };
            img.onerror = () => alert('Failed to load image.');
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }

    loadImageFromBlob(blob) {
        // Loads image from a Blob (used by paste and clipboard)
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                this.resetForNewImage();
                this.originalImage = img;
                this.setupCanvas();
                this.drawImage();
                this.updateStatusBar();
                this.updateThumbnail();
                this.updateHistogram();

                const el = document.getElementById('exifContent');
                let html = '<div class="meta-section"><h4>FILE INFO</h4><table class="exif-table">';
                html += `<tr><td class="exif-key">Source</td><td class="exif-value">Clipboard</td></tr>`;
                html += `<tr><td class="exif-key">Type</td><td class="exif-value">${blob.type || 'Unknown'}</td></tr>`;
                html += `<tr><td class="exif-key">Size</td><td class="exif-value">${this.formatFileSize(blob.size)}</td></tr>`;
                html += `<tr><td class="exif-key">Dimensions</td><td class="exif-value">${img.width} × ${img.height}</td></tr>`;
                html += '</table></div>';
                el.innerHTML = html;
            };
            img.onerror = () => alert('Failed to load pasted image.');
            img.src = event.target.result;
        };
        reader.readAsDataURL(blob);
    }

    async pasteImage() {
        // Reads image from clipboard via Clipboard API
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        const blob = await item.getType(type);
                        this.loadImageFromBlob(blob);
                        return;
                    }
                }
            }
            alert('No image found in clipboard.');
        } catch {
            alert('Could not read clipboard. Try Ctrl+V instead.');
        }
    }

    setupCanvas() {
        // Configures canvas dimensions and positioning
        this.canvas.width = this.annotationCanvas.width = this.overlayCanvas.width = this.originalImage.width;
        this.canvas.height = this.annotationCanvas.height = this.overlayCanvas.height = this.originalImage.height;
        this.syncAnnotationCanvas();
        this.magnifierCanvas.width = this.magnifierCanvas.height = this.magnifierSettings.size;
    }

    syncAnnotationCanvas() {
        // Syncs annotation and overlay canvas style dimensions with main canvas display size
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const mainRect = this.canvas.getBoundingClientRect();
                const canvasStyle = {
                    position: 'absolute',
                    width: `${mainRect.width}px`,
                    height: `${mainRect.height}px`,
                    left: '50%', top: '50%',
                    transform: 'translate(-50%, -50%)'
                };
                Object.assign(this.annotationCanvas.style, { ...canvasStyle, pointerEvents: 'auto' });
                Object.assign(this.overlayCanvas.style, { ...canvasStyle, pointerEvents: 'none' });
            });
        });
    }

    drawImage() {
        // Draws original image to canvas and captures pixel data
        if (!this.originalImage) return;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.originalImage, 0, 0);
        this.imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    }

    applyEnhancements() {
        // Applies current enhancement settings, respecting section toggles
        if (!this.originalImage) return;
        this.drawImage();

        const eff = { ...this.enhancements };
        if (!this.sectionEnabled.adjustments) {
            eff.brightness = 0;
            eff.contrast = 0;
            eff.saturation = 0;
            eff.sharpen = 0;
            eff.gamma = 1.0;
        }
        if (!this.sectionEnabled.colorBalance) {
            eff.balanceR = 0;
            eff.balanceG = 0;
            eff.balanceB = 0;
        }

        const curvesLUT = (this.sectionEnabled.curves && !this.curvesEditor.isIdentity())
            ? this.curvesEditor.getLUT() : null;

        processEnhancements(this.imageData, eff, this.canvas.width, this.canvas.height, curvesLUT);
        this.ctx.putImageData(this.imageData, 0, 0);

        if (this.annotations.visible) {
            const newData = this.annotations.showBlurs();
            if (newData) this.imageData = newData;
        }

        this.updateHistogram();
    }

    applyFilter(type) {
        // Applies selected filter to current image data
        if (!this.originalImage) return;
        const data = this.imageData.data;
        const w = this.canvas.width, h = this.canvas.height;

        switch (type) {
            case 'grayscale': Filters.applyGrayscale(data); break;
            case 'invert': Filters.applyInvert(data); break;
            case 'edge': Filters.applyEdgeDetection(data, w, h); break;
            case 'emboss': Filters.applyEmboss(data, w, h); break;
            case 'histogram': Filters.equalizeHistogram(data); break;
            case 'noise': Filters.applyDenoising(data, w, h); break;
        }

        this.ctx.putImageData(this.imageData, 0, 0);
        this.updateHistogram();
    }

    toggleCrop() {
        // Toggles crop mode and applies crop when selection exists
        const cropRect = this.transform.toggleCrop(
            this.annotationCtx,
            () => this.annotations.redraw()
        );

        const btn = document.getElementById('cropBtn');
        btn.classList.toggle('active', this.transform.cropMode);
        btn.textContent = this.transform.cropMode ? 'APPLY CROP' : 'CROP MODE';

        if (cropRect && cropRect.width >= 10 && cropRect.height >= 10) {
            this.applyCrop(cropRect);
        }
    }

    applyCrop(rect) {
        // Crops image to specified rectangle
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = rect.width;
        tempCanvas.height = rect.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(this.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);

        const newImage = new Image();
        newImage.onload = () => {
            this.originalImage = newImage;
            this.annotations.reset();

            this.transform.reset();
            document.getElementById('zoomLevel').value = 100;
            document.getElementById('rotateAngle').value = 0;
            document.getElementById('zoomLevel').parentElement.querySelector('.value').textContent = '100%';
            document.getElementById('rotateAngle').parentElement.querySelector('.value').textContent = '0°';
            document.getElementById('flipH').classList.remove('active');
            document.getElementById('flipV').classList.remove('active');

            this.setupCanvas();
            this.drawImage();
            this.applyEnhancements();
            this.updateStatusBar();
            this.updateThumbnail();
        };
        newImage.src = tempCanvas.toDataURL();
        this.transform.clearCrop();
    }

    handleMouseMove(e) {
        // Updates magnifier and status bar on mouse movement
        if (!this.originalImage) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const canvasX = (e.clientX - rect.left) * scaleX;
        const canvasY = (e.clientY - rect.top) * scaleY;

        if (canvasX >= 0 && canvasX < this.canvas.width && canvasY >= 0 && canvasY < this.canvas.height) {
            document.getElementById('mouseCoords').textContent = `X: ${Math.floor(canvasX)} Y: ${Math.floor(canvasY)}`;

            const idx = (Math.floor(canvasY) * this.canvas.width + Math.floor(canvasX)) * 4;
            const [r, g, b] = [this.imageData.data[idx], this.imageData.data[idx + 1], this.imageData.data[idx + 2]];
            document.getElementById('pixelValue').textContent = `RGB: ${r},${g},${b}`;

            const annotateActive = document.getElementById('annotate').classList.contains('active');
            if (this.magnifierSettings.enabled && this.magnifierSettings.visible && !annotateActive) {
                this.magnifier.show(e.clientX, e.clientY, canvasX, canvasY, this.canvas, this.imageData);
            } else {
                this.magnifier.hide();
            }
        } else {
            this.magnifier.hide();
        }
    }

    pickColor(e) {
        // Picks a color from the image at the click position (display only, no annotation color change)
        if (!this.originalImage || !this.imageData) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const canvasX = Math.floor((e.clientX - rect.left) * scaleX);
        const canvasY = Math.floor((e.clientY - rect.top) * scaleY);

        if (canvasX < 0 || canvasX >= this.canvas.width || canvasY < 0 || canvasY >= this.canvas.height) return;

        const idx = (canvasY * this.canvas.width + canvasX) * 4;
        const r = this.imageData.data[idx];
        const g = this.imageData.data[idx + 1];
        const b = this.imageData.data[idx + 2];
        const hex = rgbToHex(r, g, b);

        document.getElementById('colorPickerResult').style.display = 'block';
        document.getElementById('pickerSwatch').style.background = hex;
        document.getElementById('pickerRGB').textContent = `RGB: ${r}, ${g}, ${b}`;
        document.getElementById('pickerHEX').textContent = `HEX: ${hex}`;

        document.getElementById('pickedColor').style.display = 'inline-flex';
        document.getElementById('pickedSwatch').style.background = hex;
        document.getElementById('pickedHex').textContent = hex;

        navigator.clipboard.writeText(hex).catch(() => {});
    }

    deselectTool() {
        // Deselects current tool and returns to select mode
        this.colorPickerActive = false;
        this.annotations.setTool('select');
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('togglePicker')?.classList.remove('active');
        document.getElementById('shapeSettings').style.display = 'none';
        document.getElementById('textSettings').style.display = 'none';
        document.getElementById('blurSettings').style.display = 'none';
        document.getElementById('measureSettings') && (document.getElementById('measureSettings').style.display = 'none');
        document.getElementById('colorPickerResult').style.display = 'none';
        document.getElementById('pickedColor').style.display = 'none';
    }

    selectTool(tool) {
        // Sets active annotation tool and updates UI
        this.colorPickerActive = tool === 'colorpicker';

        if (tool === 'colorpicker') {
            this.annotations.setTool('select');
            this.annotationCanvas.style.cursor = 'crosshair';
        } else if (tool === 'measure') {
            this.annotations.setTool('measure');
            this.annotationCanvas.style.cursor = 'crosshair';
        } else {
            this.annotations.setTool(tool);
        }

        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`[data-tool="${tool}"]`)?.classList.add('active');

        document.getElementById('togglePicker')?.classList.toggle('active', tool === 'colorpicker');

        const shapeSettings = document.getElementById('shapeSettings');
        const textSettings = document.getElementById('textSettings');
        const blurSettings = document.getElementById('blurSettings');
        const measureSettings = document.getElementById('measureSettings');

        const shapeTools = ['rect', 'circle', 'arrow', 'line'];
        const isShapeTool = shapeTools.includes(tool);

        shapeSettings.style.display = isShapeTool ? 'block' : 'none';
        textSettings.style.display = tool === 'text' ? 'block' : 'none';
        blurSettings.style.display = tool === 'blur' ? 'block' : 'none';
        if (measureSettings) measureSettings.style.display = tool === 'measure' ? 'block' : 'none';

        const fillModeRow = document.getElementById('fillModeRow');
        if (fillModeRow) {
            fillModeRow.style.display = (tool === 'rect' || tool === 'circle') ? 'flex' : 'none';
        }

        const colorPickerResult = document.getElementById('colorPickerResult');
        const pickedColor = document.getElementById('pickedColor');
        if (tool !== 'colorpicker') {
            if (colorPickerResult) colorPickerResult.style.display = 'none';
            if (pickedColor) pickedColor.style.display = 'none';
        }
    }

    switchTab(e) {
        // Switches between control panel tabs
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
        document.getElementById(e.target.dataset.tab).classList.add('active');
        this.annotations.tabActive = (e.target.dataset.tab === 'annotate');
        if (e.target.dataset.tab === 'annotate') this.magnifier.hide();
    }

    updateStatusBar() {
        // Updates image dimensions in status bar
        if (this.originalImage) {
            document.getElementById('imageInfo').textContent = `${this.originalImage.width}×${this.originalImage.height}`;
        }
    }

    updateThumbnail() {
        // Draws a scaled thumbnail of the current image in the header
        if (!this.originalImage) return;
        const thumbCanvas = document.getElementById('thumbnailCanvas');
        const container = document.getElementById('thumbnailContainer');
        const maxH = 36;
        const scale = maxH / this.originalImage.height;
        const thumbW = Math.round(this.originalImage.width * scale);
        thumbCanvas.width = thumbW;
        thumbCanvas.height = maxH;
        const thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.drawImage(this.originalImage, 0, 0, thumbW, maxH);
        container.classList.add('visible');
    }

    updateHistogram() {
        // Updates the histogram display with current image data
        if (this.imageData) {
            this.histogram.update(this.imageData);
            this.updateColorPalette();
        }
    }

    reset() {
        // Resets entire application state
        this.originalImage = null;
        this.imageData = null;
        this.watermarkSettings = null;
        this.captionSettings = null;
        this.colorPickerActive = false;
        this.annotations.reset();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.annotationCtx.clearRect(0, 0, this.annotationCanvas.width, this.annotationCanvas.height);
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        this.resetEnhancements();
        this.clearAllInputs();
        document.getElementById('imageInfo').textContent = 'NO IMAGE';
        document.getElementById('exifContent').innerHTML = '<p class="no-data">No image loaded</p>';
        document.getElementById('thumbnailContainer').classList.remove('visible');
        document.getElementById('colorPickerResult').style.display = 'none';
        document.getElementById('pickedColor').style.display = 'none';
        const palette = document.getElementById('colorPalette');
        if (palette) palette.innerHTML = '<p class="no-data">No image loaded</p>';
        const ocrResult = document.getElementById('ocrResult');
        if (ocrResult) ocrResult.style.display = 'none';
        const measureResult = document.getElementById('measureResult');
        if (measureResult) measureResult.style.display = 'none';
    }

    clearAllInputs() {
        // Clears all text inputs and resets UI state for new image
        const textInputs = ['watermarkText', 'captionText', 'annotationText'];
        textInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));

        const sections = ['watermarkSection', 'captionSection', 'advancedSection'];
        sections.forEach(id => {
            document.getElementById(id)?.classList.remove('expanded');
        });

        this.deselectTool();
    }

    resetForNewImage() {
        // Full reset for loading a new image
        this.watermarkSettings = null;
        this.captionSettings = null;
        this.colorPickerActive = false;
        this.annotations.reset();
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        this.annotationCtx.clearRect(0, 0, this.annotationCanvas.width, this.annotationCanvas.height);
        this.resetEnhancements();
        this.clearAllInputs();

        if (!this.annotations.visible) {
            this.annotations.toggle();
            document.getElementById('toggleAnnotations')?.classList.add('active');
            this.updateAnnotationVisibilityUI();
            this.overlayCanvas.style.opacity = '1';
        }
    }

    resetEnhancements() {
        // Resets all enhancement and transform values
        this.enhancements = {
            brightness: 0, contrast: 0, saturation: 0,
            sharpen: 0, gamma: 1.0, balanceR: 0, balanceG: 0, balanceB: 0
        };
        this.transform.reset();
        this.curvesEditor.reset();

        this.sectionEnabled = { adjustments: true, colorBalance: true, curves: true };
        ['toggleAdjustments', 'toggleColorBalance', 'toggleCurves'].forEach(id => {
            document.getElementById(id).checked = true;
        });
        ['sectionAdjustments', 'sectionColorBalance', 'sectionCurves'].forEach(id => {
            document.getElementById(id).classList.remove('disabled');
        });

        ['brightness', 'contrast', 'saturation', 'sharpen'].forEach(id => {
            document.getElementById(id).value = 0;
        });
        document.getElementById('gamma').value = 100;
        document.getElementById('zoomLevel').value = 100;
        document.getElementById('rotateAngle').value = 0;

        ['balanceR', 'balanceG', 'balanceB'].forEach(id => {
            document.getElementById(id).value = 0;
            document.getElementById(id).parentElement.querySelector('.value').textContent = '0';
        });

        document.querySelectorAll('.control-row .value').forEach(el => {
            const input = el.parentElement.querySelector('input[type="range"]');
            if (input) {
                if (input.id === 'zoomLevel') el.textContent = input.value + '%';
                else if (input.id === 'rotateAngle') el.textContent = input.value + '°';
                else if (input.id === 'gamma') el.textContent = '1.00';
                else if (!['balanceR', 'balanceG', 'balanceB'].includes(input.id))
                    el.textContent = input.value;
            }
        });

        document.getElementById('flipH').classList.remove('active');
        document.getElementById('flipV').classList.remove('active');

        if (this.transform.cropMode) this.toggleCrop();
        if (this.originalImage) {
            this.drawImage();
            this.updateHistogram();
        }
    }

    resetAdjustments() {
        // Resets adjustment sliders only
        this.enhancements = {
            brightness: 0, contrast: 0, saturation: 0,
            sharpen: 0, gamma: 1.0, balanceR: 0, balanceG: 0, balanceB: 0
        };

        this.sectionEnabled = { adjustments: true, colorBalance: true, curves: true };
        ['toggleAdjustments', 'toggleColorBalance', 'toggleCurves'].forEach(id => {
            document.getElementById(id).checked = true;
        });
        ['sectionAdjustments', 'sectionColorBalance', 'sectionCurves'].forEach(id => {
            document.getElementById(id).classList.remove('disabled');
        });

        ['brightness', 'contrast', 'saturation', 'sharpen'].forEach(id => {
            const el = document.getElementById(id);
            el.value = 0;
            el.parentElement.querySelector('.value').textContent = '0';
        });
        document.getElementById('gamma').value = 100;
        document.getElementById('gamma').parentElement.querySelector('.value').textContent = '1.00';
        ['balanceR', 'balanceG', 'balanceB'].forEach(id => {
            document.getElementById(id).value = 0;
            document.getElementById(id).parentElement.querySelector('.value').textContent = '0';
        });
        this.curvesEditor.reset();

        if (this.originalImage) {
            this.drawImage();
            this.applyEnhancements();
        }
    }

    resetFilters() {
        // Resets destructive filters by re-drawing from original and re-applying enhancements
        if (!this.originalImage) return;
        this.drawImage();
        this.applyEnhancements();
    }

    resetColorBalance() {
        // Resets color balance sliders only
        this.enhancements.balanceR = 0;
        this.enhancements.balanceG = 0;
        this.enhancements.balanceB = 0;
        ['balanceR', 'balanceG', 'balanceB'].forEach(id => {
            document.getElementById(id).value = 0;
            document.getElementById(id).parentElement.querySelector('.value').textContent = '0';
        });
        if (this.originalImage) {
            this.applyEnhancementsDebounced();
        }
    }

    resetTransform() {
        // Resets transform controls only
        this.transform.reset();
        document.getElementById('zoomLevel').value = 100;
        document.getElementById('rotateAngle').value = 0;
        document.getElementById('zoomLevel').parentElement.querySelector('.value').textContent = '100%';
        document.getElementById('rotateAngle').parentElement.querySelector('.value').textContent = '0°';
        document.getElementById('flipH').classList.remove('active');
        document.getElementById('flipV').classList.remove('active');
        if (this.transform.cropMode) this.toggleCrop();
    }

    createExportCanvas(includeOverlays = true) {
        // Creates a composited canvas with main image and optional annotation/overlay layers
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = this.canvas.width;
        exportCanvas.height = this.canvas.height;
        const exportCtx = exportCanvas.getContext('2d');
        exportCtx.drawImage(this.canvas, 0, 0);
        if (includeOverlays) {
            exportCtx.drawImage(this.annotationCanvas, 0, 0);
            exportCtx.drawImage(this.overlayCanvas, 0, 0);
        }
        return exportCanvas;
    }

    exportImage() {
        // Exports current view with annotations and overlay as PNG
        if (!this.originalImage) return;
        const exportCanvas = this.createExportCanvas();
        const link = document.createElement('a');
        link.download = 'lucid_' + Date.now() + '.png';
        link.href = exportCanvas.toDataURL();
        link.click();
    }

    async copyImage() {
        // Copies current canvas with annotations and overlay to clipboard as PNG
        if (!this.originalImage) return;
        const exportCanvas = this.createExportCanvas();
        try {
            const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            const btn = document.getElementById('copyBtn');
            const span = btn.querySelector('span');
            if (span) {
                span.textContent = 'COPIED';
                setTimeout(() => { span.textContent = 'COPY'; }, 1500);
            }
        } catch {
            alert('Could not copy to clipboard.');
        }
    }

    async extractEXIF(file) {
        // Extracts and displays file metadata, hash, and EXIF data
        const el = document.getElementById('exifContent');
        let html = '';

        let imageHash = '';
        try {
            const arrayBuffer = await file.arrayBuffer();
            imageHash = await this.computeImageHash(arrayBuffer);
        } catch {
            imageHash = 'Unable to compute';
        }

        html += '<div class="meta-section"><h4>FILE INFO</h4><table class="exif-table">';
        html += `<tr><td class="exif-key">Name</td><td class="exif-value">${file.name}</td></tr>`;
        html += `<tr><td class="exif-key">Size</td><td class="exif-value">${this.formatFileSize(file.size)}</td></tr>`;
        html += `<tr><td class="exif-key">Type</td><td class="exif-value">${file.type || 'Unknown'}</td></tr>`;
        html += `<tr><td class="exif-key">Modified</td><td class="exif-value">${new Date(file.lastModified).toLocaleString()}</td></tr>`;
        if (this.originalImage) {
            html += `<tr><td class="exif-key">Dimensions</td><td class="exif-value">${this.originalImage.width} × ${this.originalImage.height}</td></tr>`;
        }
        html += '</table></div>';

        html += '<div class="meta-section"><h4>FILE HASH</h4><table class="exif-table">';
        html += `<tr><td class="exif-key">SHA-256</td><td class="exif-value hash-value">${imageHash}</td></tr>`;
        html += '</table></div>';

        try {
            const exifData = await exifr.parse(file, { translateKeys: true, translateValues: true });

            if (exifData && Object.keys(exifData).length > 0) {
                const cameraFields = ['Make', 'Model', 'LensModel', 'Software'];
                const settingsFields = ['ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'Flash', 'WhiteBalance'];
                const dateFields = ['DateTime', 'DateTimeOriginal', 'DateTimeDigitized'];

                const cameraData = this.filterExifFields(exifData, cameraFields);
                const settingsData = this.filterExifFields(exifData, settingsFields);
                const dateData = this.filterExifFields(exifData, dateFields);

                if (Object.keys(cameraData).length > 0) {
                    html += '<div class="meta-section"><h4>CAMERA</h4>';
                    html += this.buildExifTable(cameraData);
                    html += '</div>';
                }

                if (Object.keys(settingsData).length > 0) {
                    html += '<div class="meta-section"><h4>SETTINGS</h4>';
                    html += this.buildExifTable(settingsData);
                    html += '</div>';
                }

                if (Object.keys(dateData).length > 0) {
                    html += '<div class="meta-section"><h4>DATE/TIME</h4>';
                    html += this.buildExifTable(dateData);
                    html += '</div>';
                }

                if (exifData.latitude && exifData.longitude) {
                    html += `<div class="meta-section"><h4>LOCATION</h4>
                        <div class="gps-info">
                            <table class="exif-table">
                                <tr><td class="exif-key">Latitude</td><td class="exif-value">${exifData.latitude.toFixed(6)}</td></tr>
                                <tr><td class="exif-key">Longitude</td><td class="exif-value">${exifData.longitude.toFixed(6)}</td></tr>
                            </table>
                            <a href="https://maps.google.com/?q=${exifData.latitude},${exifData.longitude}" target="_blank" class="map-link">VIEW ON MAP</a>
                        </div>
                    </div>`;
                }
            } else {
                html += '<div class="meta-section"><h4>EXIF DATA</h4><p class="no-data">Could not find any EXIF data</p></div>';
            }
        } catch {
            html += '<div class="meta-section"><h4>EXIF DATA</h4><p class="no-data">Could not find any EXIF data</p></div>';
        }

        el.innerHTML = html;
    }

    formatFileSize(bytes) {
        // Converts bytes to human-readable size string
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    filterExifFields(data, fields) {
        // Filters EXIF data to include only specified fields
        const result = {};
        fields.forEach(f => {
            if (data[f] !== undefined && data[f] !== null) {
                result[f] = data[f];
            }
        });
        return result;
    }

    buildExifTable(data) {
        // Builds HTML table from EXIF key-value pairs
        let html = '<table class="exif-table">';
        Object.entries(data).forEach(([key, value]) => {
            const displayKey = key.replace(/([A-Z])/g, ' $1').trim();
            let displayValue = value;
            if (value instanceof Date) {
                displayValue = value.toLocaleString();
            }
            html += `<tr><td class="exif-key">${displayKey}</td><td class="exif-value">${displayValue}</td></tr>`;
        });
        html += '</table>';
        return html;
    }

    applyPreset(preset) {
        // Applies auto-enhancement presets
        if (!this.originalImage) return;

        this.resetAdjustments();

        const presets = {
            auto: { brightness: 10, contrast: 15, saturation: 10, sharpen: 15, gamma: 1.1 },
            lowlight: { brightness: 30, contrast: 25, gamma: 1.3, saturation: 5, sharpen: 10 },
            forensic: { contrast: 40, sharpen: 50, saturation: -30, gamma: 0.9, brightness: 5 },
            clarity: { contrast: 20, sharpen: 40, saturation: 0, gamma: 1.0, brightness: 0 },
            vivid: { saturation: 40, contrast: 25, brightness: 5, sharpen: 15, gamma: 1.05 },
            muted: { saturation: -40, contrast: -10, brightness: -5, sharpen: 0, gamma: 1.0 }
        };

        const settings = presets[preset];
        if (!settings) return;

        this.enhancements.brightness = settings.brightness ?? 0;
        this.enhancements.contrast = settings.contrast ?? 0;
        this.enhancements.saturation = settings.saturation ?? 0;
        this.enhancements.sharpen = settings.sharpen ?? 0;
        this.enhancements.gamma = settings.gamma ?? 1.0;

        document.getElementById('brightness').value = this.enhancements.brightness;
        document.getElementById('brightness').parentElement.querySelector('.value').textContent = this.enhancements.brightness;
        document.getElementById('contrast').value = this.enhancements.contrast;
        document.getElementById('contrast').parentElement.querySelector('.value').textContent = this.enhancements.contrast;
        document.getElementById('saturation').value = this.enhancements.saturation;
        document.getElementById('saturation').parentElement.querySelector('.value').textContent = this.enhancements.saturation;
        document.getElementById('sharpen').value = this.enhancements.sharpen;
        document.getElementById('sharpen').parentElement.querySelector('.value').textContent = this.enhancements.sharpen;
        document.getElementById('gamma').value = this.enhancements.gamma * 100;
        document.getElementById('gamma').parentElement.querySelector('.value').textContent = this.enhancements.gamma.toFixed(2);

        document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`[data-preset="${preset}"]`)?.classList.add('active');

        this.applyEnhancements();
    }

    initPanelResize() {
        // Initializes draggable panel resize with snap-to-close behavior
        const panel = document.querySelector('.control-panel');
        const handle = document.createElement('div');
        handle.className = 'panel-resize-handle';
        panel.appendChild(handle);

        let isResizing = false;
        let startX = 0;
        let startWidth = 0;
        const minWidth = 300;
        const maxWidth = 600;
        const defaultWidth = 420;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = panel.classList.contains('collapsed') ? 0 : panel.offsetWidth;
            handle.classList.add('dragging');
            document.body.style.cursor = 'ew-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const diff = startX - e.clientX;
            const newWidth = startWidth + diff;

            if (panel.classList.contains('collapsed') && newWidth > 50) {
                panel.classList.remove('collapsed');
                panel.style.width = Math.min(maxWidth, Math.max(minWidth, newWidth)) + 'px';
            } else if (!panel.classList.contains('collapsed')) {
                panel.style.width = Math.min(maxWidth, Math.max(100, newWidth)) + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                handle.classList.remove('dragging');
                document.body.style.cursor = '';

                const currentWidth = panel.offsetWidth;
                if (currentWidth < minWidth) {
                    panel.classList.add('collapsed');
                    panel.style.width = '';
                } else {
                    panel.classList.remove('collapsed');
                    panel.style.width = Math.max(minWidth, currentWidth) + 'px';
                }

                const btn = document.getElementById('toggleSidebar');
                if (btn) btn.classList.toggle('active', !panel.classList.contains('collapsed'));
            }
        });

        handle.addEventListener('dblclick', () => {
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                panel.style.width = defaultWidth + 'px';
            } else {
                panel.classList.add('collapsed');
                panel.style.width = '';
            }
            const btn = document.getElementById('toggleSidebar');
            if (btn) btn.classList.toggle('active', !panel.classList.contains('collapsed'));
        });
    }

    checkScreenSize() {
        // Checks minimum screen size and shows warning
        const minWidth = 1024;
        const warning = document.getElementById('screenSizeWarning');
        const widthEl = document.getElementById('currentWidth');

        if (window.innerWidth < minWidth) {
            warning.classList.add('visible');
            widthEl.textContent = window.innerWidth;
        } else {
            warning.classList.remove('visible');
        }
    }

    resetPreset() {
        // Resets the auto-enhancement preset to default values
        if (!this.originalImage) return;

        this.enhancements.brightness = 0;
        this.enhancements.contrast = 0;
        this.enhancements.saturation = 0;
        this.enhancements.sharpen = 0;
        this.enhancements.gamma = 1.0;

        ['brightness', 'contrast', 'saturation', 'sharpen'].forEach(id => {
            const el = document.getElementById(id);
            el.value = 0;
            el.parentElement.querySelector('.value').textContent = '0';
        });
        document.getElementById('gamma').value = 100;
        document.getElementById('gamma').parentElement.querySelector('.value').textContent = '1.00';

        document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));

        this.applyEnhancements();
    }

    applyWatermark() {
        // Stores watermark settings and draws to overlay canvas
        if (!this.originalImage) {
            alert('Please load an image first.');
            return;
        }

        const text = document.getElementById('watermarkText')?.value.trim();
        if (!text) {
            alert('Please enter watermark text.');
            return;
        }

        const baseSize = parseInt(document.getElementById('watermarkSize')?.value || 24);
        const scale = Math.max(this.originalImage.width, this.originalImage.height) / 1000;
        const size = Math.round(baseSize * Math.max(1, scale));

        const opacity = parseInt(document.getElementById('watermarkOpacity')?.value || 30) / 100;
        const color = document.getElementById('watermarkColor')?.value || '#ffffff';
        const position = document.getElementById('watermarkPosition')?.value || 'center';
        const angle = parseInt(document.getElementById('watermarkAngle')?.value || -30);

        this.watermarkSettings = { text, size, opacity, color, position, angle };
        this.drawOverlay();
    }

    removeWatermark() {
        // Removes the watermark from overlay
        this.watermarkSettings = null;
        this.drawOverlay();
    }

    applyCaption() {
        // Stores caption settings and draws to overlay canvas
        if (!this.originalImage) {
            alert('Please load an image first.');
            return;
        }

        const text = document.getElementById('captionText')?.value.trim();
        if (!text) {
            alert('Please enter caption text.');
            return;
        }

        const position = document.getElementById('captionPosition')?.value || 'bottom';

        const scale = Math.max(this.originalImage.width, this.originalImage.height) / 1000;
        const baseHeight = parseInt(document.getElementById('captionHeight')?.value || 50);
        const baseFontSize = parseInt(document.getElementById('captionSize')?.value || 16);
        const barHeight = Math.round(baseHeight * Math.max(1, scale));
        const fontSize = Math.round(baseFontSize * Math.max(1, scale));

        const bgColor = document.getElementById('captionBgColor')?.value || '#000000';
        const textColor = document.getElementById('captionTextColor')?.value || '#ffffff';

        this.captionSettings = { text, position, barHeight, fontSize, bgColor, textColor };
        this.drawOverlay();
    }

    removeCaption() {
        // Removes the caption from overlay
        this.captionSettings = null;
        this.drawOverlay();
    }

    drawOverlay() {
        // Draws watermark and caption to the overlay canvas
        const ctx = this.overlayCtx;
        const width = this.overlayCanvas.width;
        const height = this.overlayCanvas.height;

        ctx.clearRect(0, 0, width, height);

        if (this.captionSettings) {
            const { text, position, barHeight, fontSize, bgColor, textColor } = this.captionSettings;

            ctx.fillStyle = bgColor;
            if (position === 'top') {
                ctx.fillRect(0, 0, width, barHeight);
            } else {
                ctx.fillRect(0, height - barHeight, width, barHeight);
            }

            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (position === 'top') {
                ctx.moveTo(0, Math.floor(barHeight) - 0.5);
                ctx.lineTo(width, Math.floor(barHeight) - 0.5);
            } else {
                ctx.moveTo(0, Math.floor(height - barHeight) + 0.5);
                ctx.lineTo(width, Math.floor(height - barHeight) + 0.5);
                ctx.moveTo(0, height - 0.5);
                ctx.lineTo(width, height - 0.5);
            }
            ctx.stroke();

            ctx.fillStyle = textColor;
            ctx.font = `${fontSize}px 'Courier New', monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const textY = position === 'top' ? barHeight / 2 : height - barHeight / 2;
            ctx.fillText(text, width / 2, textY);
        }

        if (this.watermarkSettings) {
            const { text, size, opacity, color, position, angle } = this.watermarkSettings;

            ctx.globalAlpha = opacity;
            ctx.fillStyle = color;
            ctx.font = `bold ${size}px 'Courier New', monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            if (position === 'tile') {
                const stepX = size * 6;
                const stepY = size * 3;
                ctx.save();
                ctx.rotate(angle * Math.PI / 180);
                for (let y = -height; y < height * 2; y += stepY) {
                    for (let x = -width; x < width * 2; x += stepX) {
                        ctx.fillText(text, x, y);
                    }
                }
                ctx.restore();
            } else {
                let x, y;
                const padding = size;
                switch (position) {
                    case 'topLeft': x = padding + size * 2; y = padding + size; break;
                    case 'topRight': x = width - padding - size * 2; y = padding + size; break;
                    case 'bottomLeft': x = padding + size * 2; y = height - padding - size; break;
                    case 'bottomRight': x = width - padding - size * 2; y = height - padding - size; break;
                    default: x = width / 2; y = height / 2;
                }
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(angle * Math.PI / 180);
                ctx.fillText(text, 0, 0);
                ctx.restore();
            }

            ctx.globalAlpha = 1;
        }
    }

    async computeImageHash(arrayBuffer) {
        // Computes SHA-256 hash of image data
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async loadImageFromUrl() {
        // Fetches and loads an image from URL with CORS proxy fallback
        const input = document.getElementById('imageUrlInput');
        const url = input?.value.trim();
        if (!url) return;

        const btn = document.getElementById('fetchUrlBtn');
        const span = btn?.querySelector('span');
        if (span) span.textContent = '...';

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error('Failed to fetch');
            const blob = await response.blob();
            if (!blob.type.startsWith('image/')) throw new Error('Not an image');
            this.loadImageFromBlob(blob);
            input.value = '';
        } catch {
            try {
                const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
                const response = await fetch(proxyUrl);
                if (!response.ok) throw new Error('Proxy failed');
                const blob = await response.blob();
                this.loadImageFromBlob(blob);
                input.value = '';
            } catch {
                alert('Could not load image from URL. The server may block cross-origin requests.');
            }
        } finally {
            if (span) span.textContent = 'URL';
        }
    }

    async reverseImageSearch(engine) {
        // Copies image to clipboard and opens reverse image search engine
        if (!this.originalImage) {
            alert('Please load an image first.');
            return;
        }

        const exportCanvas = this.createExportCanvas(false);
        try {
            const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        } catch {}

        const urls = {
            google: 'https://images.google.com/',
            yandex: 'https://yandex.com/images/',
            tineye: 'https://tineye.com/',
            bing: 'https://www.bing.com/images/search?q=&FORM=SBIIRP'
        };

        const btn = document.getElementById('search' + engine.charAt(0).toUpperCase() + engine.slice(1));
        const origText = btn?.querySelector('span:last-child')?.textContent;

        window.open(urls[engine], '_blank');

        if (btn) {
            const span = btn.querySelector('span:last-child');
            if (span) {
                span.textContent = 'Copied & opened';
                setTimeout(() => { span.textContent = origText; }, 2000);
            }
        }
    }

    async runOCR() {
        // Runs Tesseract.js OCR on the current image with progress tracking
        if (!this.originalImage) {
            alert('Please load an image first.');
            return;
        }

        const progressEl = document.getElementById('ocrProgress');
        const progressFill = document.getElementById('ocrProgressFill');
        const progressText = document.getElementById('ocrProgressText');
        const resultEl = document.getElementById('ocrResult');
        const textEl = document.getElementById('ocrText');
        const confidenceEl = document.getElementById('ocrConfidence');
        const runBtn = document.getElementById('runOcr');
        const lang = document.getElementById('ocrLanguage')?.value || 'eng';

        progressEl.style.display = 'block';
        resultEl.style.display = 'none';
        runBtn.disabled = true;
        runBtn.textContent = 'PROCESSING...';
        progressFill.style.width = '0%';
        progressText.textContent = 'Initializing Tesseract...';

        try {
            const dataUrl = this.canvas.toDataURL('image/png');

            const worker = await Tesseract.createWorker(lang, 1, {
                logger: (m) => {
                    if (m.status) {
                        progressText.textContent = m.status;
                    }
                    if (typeof m.progress === 'number') {
                        progressFill.style.width = Math.round(m.progress * 100) + '%';
                    }
                }
            });

            const { data } = await worker.recognize(dataUrl);

            textEl.textContent = data.text || '(No text found)';
            confidenceEl.textContent = `Confidence: ${Math.round(data.confidence)}%`;
            resultEl.style.display = 'block';

            await worker.terminate();
        } catch (err) {
            textEl.textContent = 'OCR failed: ' + (err.message || 'Unknown error');
            resultEl.style.display = 'block';
            confidenceEl.textContent = '';
        } finally {
            progressEl.style.display = 'none';
            runBtn.disabled = false;
            runBtn.textContent = 'EXTRACT TEXT';
        }
    }

    copyOcrText() {
        // Copies extracted OCR text to clipboard
        const text = document.getElementById('ocrText')?.textContent;
        if (text) {
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copyOcrText');
                btn.textContent = 'COPIED';
                setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
            }).catch(() => {});
        }
    }

    updateColorPalette() {
        // Extracts dominant colors from image via quantized sampling and renders swatches
        const el = document.getElementById('colorPalette');
        if (!el || !this.imageData) return;

        const data = this.imageData.data;
        const colorMap = {};
        const step = Math.max(1, Math.floor(data.length / 4 / 10000));

        for (let i = 0; i < data.length; i += 4 * step) {
            const r = Math.round(data[i] / 24) * 24;
            const g = Math.round(data[i + 1] / 24) * 24;
            const b = Math.round(data[i + 2] / 24) * 24;
            const key = `${r},${g},${b}`;
            colorMap[key] = (colorMap[key] || 0) + 1;
        }

        const sorted = Object.entries(colorMap).sort((a, b) => b[1] - a[1]);
        const totalSampled = sorted.reduce((sum, [, count]) => sum + count, 0);

        const palette = [];
        for (const [key, count] of sorted) {
            if (palette.length >= 8) break;
            const [r, g, b] = key.split(',').map(Number);

            const tooSimilar = palette.some(p => {
                const dr = Math.abs(p.r - r);
                const dg = Math.abs(p.g - g);
                const db = Math.abs(p.b - b);
                return dr + dg + db < 60;
            });

            if (!tooSimilar) {
                palette.push({ r, g, b, count });
            }
        }

        if (palette.length === 0) {
            el.innerHTML = '<p class="no-data">No colors detected</p>';
            return;
        }

        el.innerHTML = palette.map(c => {
            const hex = rgbToHex(
                Math.min(255, c.r),
                Math.min(255, c.g),
                Math.min(255, c.b)
            );
            const pct = ((c.count / totalSampled) * 100).toFixed(1);
            return `<div class="palette-swatch" data-hex="${hex}" title="Click to copy">
                <div class="palette-color" style="background:${hex};"></div>
                <div class="palette-info">
                    <span class="palette-hex">${hex}</span>
                    <span class="palette-percent">${pct}%</span>
                </div>
            </div>`;
        }).join('');

        el.querySelectorAll('.palette-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                const hex = swatch.dataset.hex;
                navigator.clipboard.writeText(hex).then(() => {
                    const hexEl = swatch.querySelector('.palette-hex');
                    const orig = hexEl.textContent;
                    hexEl.textContent = 'COPIED';
                    setTimeout(() => { hexEl.textContent = orig; }, 1000);
                }).catch(() => {});
            });
        });
    }

    updateMeasurement(startX, startY, endX, endY) {
        // Calculates and displays measurement distance, delta, and angle
        const dx = Math.abs(endX - startX);
        const dy = Math.abs(endY - startY);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(endY - startY, endX - startX) * (180 / Math.PI);

        document.getElementById('measureDistance').textContent = dist.toFixed(1) + ' px';
        document.getElementById('measureDx').textContent = Math.round(dx) + ' px';
        document.getElementById('measureDy').textContent = Math.round(dy) + ' px';
        document.getElementById('measureAngle').textContent = angle.toFixed(1) + '\u00B0';
        document.getElementById('measureResult').style.display = 'block';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splashScreen');
    if (splash) {
        setTimeout(() => {
            splash.classList.add('fade-out');
            splash.addEventListener('transitionend', () => splash.remove());
        }, 1400);
    }
    new ImageForensicsTool();
});
