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
import { HistoryManager } from './history.js';
import { computeELA, parseJPEGInternals, estimateJPEGQuality, extractEmbeddedThumbnail } from './forensics.js';
import { perspectiveWarp } from './perspective.js';
import { SuperResolver, DOWNLOADABLE_MODELS, preprocessForText, backProject, postprocessForText } from './superres.js';
import * as Filters from './filters.js';
import { debounce, throttle, rgbToHex, escapeHtml, showToast, loadPrefs, savePrefs } from './utils.js';

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

        // Ordered list of applied destructive filters; the render
        // pipeline replays these from the original image every time, so
        // filters, blurs, and enhancements always compose consistently
        // and are individually undoable.
        this.appliedFilters = [];
        this.elaActive = false;
        this.comparing = false;
        this.perspectivePoints = null; // null = inactive, [] = collecting
        this.superResolver = null;     // lazy: built on first use
        this.srBusy = false;
        this.currentFile = null;
        this.prefs = loadPrefs();

        this.magnifierSettings = {
            level: 3, size: 150, enhancement: 'none',
            showGrid: false, showPixelInfo: true, showCrosshair: true,
            enabled: true, visible: true,
            ...(this.prefs.magnifier || {})
        };

        this.enhancements = {
            brightness: 0, contrast: 0, saturation: 0,
            sharpen: 0, sharpenRadius: 2, sharpenThreshold: 0,
            gamma: 1.0, balanceR: 0, balanceG: 0, balanceB: 0
        };

        this.sectionEnabled = {
            adjustments: true,
            colorBalance: true,
            curves: true
        };

        this.history = new HistoryManager(50);
        this.history.onChange = () => this.updateHistoryUI();

        this.magnifier = new Magnifier(this.magnifierCanvas, this.magnifierCtx, this.magnifierSettings);
        this.annotations = new AnnotationManager(this.annotationCanvas, this.annotationCtx, this.canvas, this.ctx);
        this.annotations.onAction = (action) => this.recordAnnotationAction(action);
        this.transform = new TransformManager(this.canvas, this.annotationCanvas, this.overlayCanvas);
        this.applyEnhancementsDebounced = debounce(() => this.applyEnhancements(), 50);
        this.curvesEditor = new CurvesEditor(
            document.getElementById('curvesCanvas'),
            () => this.applyEnhancementsDebounced()
        );
        this.histogram = new HistogramDisplay(document.getElementById('histogramCanvas'));

        this.initEventListeners();
        this.restorePrefs();
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

        document.getElementById('sharpenRadius')?.addEventListener('input', (e) => {
            this.enhancements.sharpenRadius = parseInt(e.target.value);
            e.target.parentElement.querySelector('.value').textContent = e.target.value + 'px';
            this.applyEnhancementsDebounced();
        });

        document.getElementById('sharpenThreshold')?.addEventListener('input', (e) => {
            this.enhancements.sharpenThreshold = parseInt(e.target.value);
            e.target.parentElement.querySelector('.value').textContent = e.target.value;
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
            this.updateZoomStatus(parseInt(e.target.value));
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
                if (this.perspectivePoints) {
                    this.addPerspectivePoint(e);
                } else {
                    this.annotations.endDrawing(e);
                }
            }
        });

        this.annotationCanvas.addEventListener('mouseleave', (e) => {
            if (this.annotations.isDrawing && !this.spacePressed && !this.colorPickerActive) {
                this.annotations.endDrawing(e);
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
            this.annotations.clearBlurs();
            this.history.clear();
            this.applyEnhancements();
        });
        document.getElementById('undoAnnotation').addEventListener('click', () => this.undo());
        document.getElementById('undoBtn')?.addEventListener('click', () => this.undo());
        document.getElementById('redoBtn')?.addEventListener('click', () => this.redo());

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

            // Single-key annotation tool selection
            const toolKeys = { r: 'rect', c: 'circle', b: 'blur', t: 'text', l: 'line', u: 'measure' };
            if (toolKeys[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                this.selectTool(toolKeys[e.key]);
            }

            if (e.key === 'Escape') {
                if (this.perspectivePoints) {
                    this.cancelPerspective();
                } else {
                    this.deselectTool();
                }
            }

            if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (e.shiftKey) this.redo();
                else this.undo();
            }
            if (e.key === 'y' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.redo();
            }

            // Hold backslash to flash the unmodified original (before/after)
            if (e.key === '\\' && !this.comparing) {
                e.preventDefault();
                this.startCompare();
            }

            // Only hijack Space when nothing focusable holds focus —
            // otherwise it breaks keyboard activation of buttons/checkboxes
            if (e.key === ' ' && (e.target === document.body || e.target.tagName === 'CANVAS')) {
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
            if (e.key === '\\') {
                this.endCompare();
            }
        });

        document.getElementById('toggleAnnotations')?.addEventListener('click', () => {
            const btn = document.getElementById('toggleAnnotations');
            const visible = this.annotations.toggle();
            btn.classList.toggle('active', visible);
            this.updateAnnotationVisibilityUI();
            this.overlayCanvas.style.opacity = visible ? '1' : '0';
            // Re-render the full pipeline: when hidden, blurs are simply
            // not applied; when shown they are recomputed from live pixels
            this.applyEnhancements();
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
            if (newZoom === currentZoom) return;

            // Keep the image point under the cursor fixed: the transformed
            // bounding rect's center equals layoutCenter + pan, so the pan
            // correction is proportional to the cursor's offset from it
            const rect = this.canvas.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const ratio = newZoom / currentZoom;
            this.transform.transform.panX += (1 - ratio) * (e.clientX - cx);
            this.transform.transform.panY += (1 - ratio) * (e.clientY - cy);

            this.transform.setZoom(newZoom);
            const zoomEl = document.getElementById('zoomLevel');
            zoomEl.value = newZoom;
            zoomEl.parentElement.querySelector('.value').textContent = newZoom + '%';
            this.updateZoomStatus(newZoom);
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

        // Drag & drop image loading onto the canvas area
        wrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            wrapper.classList.add('drag-over');
        });
        wrapper.addEventListener('dragleave', () => wrapper.classList.remove('drag-over'));
        wrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            wrapper.classList.remove('drag-over');
            const file = e.dataTransfer?.files?.[0];
            if (file && (file.type.startsWith('image/') || /\.(heic|heif|tiff?|bmp)$/i.test(file.name))) {
                this.loadImageFile(file);
            } else if (file) {
                showToast('Dropped file is not an image.', 'error');
            }
        });

        // Fit / 1:1 zoom buttons
        document.getElementById('zoomFit')?.addEventListener('click', () => this.zoomToFit());
        document.getElementById('zoomActual')?.addEventListener('click', () => this.setZoomTo(100));

        // Before/after compare (hold)
        const compareBtn = document.getElementById('compareBtn');
        if (compareBtn) {
            compareBtn.addEventListener('mousedown', () => this.startCompare());
            compareBtn.addEventListener('touchstart', () => this.startCompare());
            ['mouseup', 'mouseleave', 'touchend'].forEach(ev =>
                compareBtn.addEventListener(ev, () => this.endCompare()));
        }

        // Forensics: Error Level Analysis
        document.getElementById('elaQuality')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + '%';
        });
        document.getElementById('elaAmplify')?.addEventListener('input', (e) => {
            e.target.parentElement.querySelector('.value').textContent = e.target.value + 'x';
        });
        document.getElementById('runEla')?.addEventListener('click', () => this.runELA());
        document.getElementById('exitEla')?.addEventListener('click', () => this.exitELA());

        // Perspective correction
        document.getElementById('perspectiveBtn')?.addEventListener('click', () => this.togglePerspective());

        // ML super-resolution
        document.getElementById('srModel')?.addEventListener('change', (e) => {
            const choice = e.target.value;
            document.getElementById('srCustomRow').style.display = choice === 'custom' ? 'flex' : 'none';
            const urlRow = document.getElementById('srUrlRow');
            if (urlRow) {
                urlRow.style.display = DOWNLOADABLE_MODELS[choice] ? 'flex' : 'none';
                if (DOWNLOADABLE_MODELS[choice]) {
                    const urlInput = document.getElementById('srModelUrl');
                    if (urlInput && !urlInput.dataset.userEdited) {
                        urlInput.value = DOWNLOADABLE_MODELS[choice].url;
                    }
                }
            }
            document.getElementById('saveSrModel')?.classList.add('hidden');
            this.superResolver = null; // force re-init on model switch
        });
        document.getElementById('srModelUrl')?.addEventListener('input', (e) => {
            e.target.dataset.userEdited = '1';
            this.superResolver = null;
        });
        document.getElementById('srModelFile')?.addEventListener('change', () => {
            this.superResolver = null;
        });
        document.getElementById('saveSrModel')?.addEventListener('click', () => {
            if (this.superResolver?.saveModelToDisk()) {
                showToast('Model saved — load it via CUSTOM .ONNX for fully offline use.', 'success', 4000);
            }
        });
        document.getElementById('runSuperRes')?.addEventListener('click', () => this.runSuperResolution());

        // Persist UI preferences
        ['magLevel', 'magSize', 'magEnhance', 'magGrid', 'magPixelInfo', 'magCrosshair'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                const m = this.magnifierSettings;
                savePrefs({ magnifier: {
                    level: m.level, size: m.size, enhancement: m.enhancement,
                    showGrid: m.showGrid, showPixelInfo: m.showPixelInfo, showCrosshair: m.showCrosshair
                } });
            });
        });
        ['annotationColor', 'lineWidth'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', (e) => {
                savePrefs({ [id]: e.target.value });
            });
        });
    }

    restorePrefs() {
        // Restores persisted UI preferences into controls
        const p = this.prefs;
        if (p.annotationColor) {
            const el = document.getElementById('annotationColor');
            if (el) el.value = p.annotationColor;
        }
        if (p.lineWidth) {
            const el = document.getElementById('lineWidth');
            if (el) {
                el.value = p.lineWidth;
                el.parentElement.querySelector('.value').textContent = p.lineWidth;
            }
        }
        if (p.panelWidth) {
            const panel = document.querySelector('.control-panel');
            if (panel) panel.style.width = p.panelWidth + 'px';
        }
        if (p.magnifier) {
            const m = this.magnifierSettings;
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
            const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
            set('magLevel', m.level);
            document.getElementById('magLevel')?.parentElement.querySelector('.value') &&
                (document.getElementById('magLevel').parentElement.querySelector('.value').textContent = m.level + 'x');
            set('magSize', m.size);
            document.getElementById('magSize')?.parentElement.querySelector('.value') &&
                (document.getElementById('magSize').parentElement.querySelector('.value').textContent = m.size);
            set('magEnhance', m.enhancement);
            setCheck('magGrid', m.showGrid);
            setCheck('magPixelInfo', m.showPixelInfo);
            setCheck('magCrosshair', m.showCrosshair);
        }
    }

    updateZoomStatus(zoom) {
        // Mirrors the current zoom level in the status bar
        const el = document.getElementById('zoomStatus');
        if (el) el.textContent = zoom + '%';
    }

    zoomToFit() {
        // Sets zoom so the whole image fits inside the canvas wrapper
        if (!this.originalImage) return;
        const wrapper = document.querySelector('.canvas-wrapper');
        const pad = 40;
        const baseW = this.canvas.offsetWidth || this.canvas.width;
        const baseH = this.canvas.offsetHeight || this.canvas.height;
        const scale = Math.min(
            (wrapper.clientWidth - pad) / baseW,
            (wrapper.clientHeight - pad) / baseH
        );
        this.setZoomTo(Math.max(10, Math.min(500, Math.round(scale * 100))));
    }

    setZoomTo(zoom) {
        // Sets an absolute zoom level, recentering the pan
        this.transform.transform.panX = 0;
        this.transform.transform.panY = 0;
        this.transform.setZoom(zoom);
        const zoomEl = document.getElementById('zoomLevel');
        if (zoomEl) {
            zoomEl.value = zoom;
            zoomEl.parentElement.querySelector('.value').textContent = zoom + '%';
        }
        this.updateZoomStatus(zoom);
    }

    startCompare() {
        // Temporarily shows the unmodified original image (hold to view)
        if (!this.originalImage || this.comparing) return;
        this.comparing = true;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.originalImage, 0, 0);
        this.annotationCanvas.style.opacity = '0';
        this.overlayCanvas.style.opacity = '0';
        document.getElementById('compareBtn')?.classList.add('active');
    }

    endCompare() {
        // Restores the processed view after a compare hold
        if (!this.comparing) return;
        this.comparing = false;
        this.annotationCanvas.style.opacity = this.annotations.visible ? '1' : '0';
        this.overlayCanvas.style.opacity = this.annotations.visible ? '1' : '0';
        document.getElementById('compareBtn')?.classList.remove('active');
        this.applyEnhancements();
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
        // Loads image file from the file input
        const file = e.target.files[0];
        if (!file) return;
        this.loadImageFile(file);
    }

    loadImageFile(file) {
        // Loads an image File and initializes the canvas. Metadata
        // extraction runs immediately and independently of decoding, so
        // formats the browser cannot render (HEIC, TIFF) still yield
        // their hash and EXIF data instead of failing silently.
        this.currentFile = file;
        this.extractEXIF(file);

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
            };
            img.onerror = () => {
                showToast(
                    `This browser cannot display ${file.type || 'this format'} — metadata and hash were still extracted (see METADATA tab).`,
                    'warning', 6000
                );
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }

    loadImageFromBlob(blob, sourceLabel = 'Clipboard') {
        // Loads image from a Blob (paste, clipboard, URL fetch). Blobs
        // fetched from URLs retain their metadata, so the full EXIF path
        // runs here too — previously URL loads never showed any EXIF.
        this.currentFile = blob;
        this.extractEXIF(blob, sourceLabel);

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
            };
            img.onerror = () => showToast('Failed to load image.', 'error');
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
                        this.loadImageFromBlob(blob, 'Clipboard');
                        return;
                    }
                }
            }
            showToast('No image found in clipboard.', 'warning');
        } catch {
            showToast('Could not read clipboard. Try Ctrl+V instead.', 'error');
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
        // Syncs annotation and overlay canvas style dimensions with the
        // main canvas layout size. offsetWidth/offsetHeight are used
        // because getBoundingClientRect() includes the CSS zoom/rotation
        // transform — measuring it while zoomed double-applied the scale
        // and misaligned the overlay layers after a window resize.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const w = this.canvas.offsetWidth;
                const h = this.canvas.offsetHeight;
                const canvasStyle = {
                    position: 'absolute',
                    width: `${w}px`,
                    height: `${h}px`,
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
        // Re-renders the full pipeline from the original image:
        // enhancements -> destructive filters (replayed in order) ->
        // blur regions. Because every layer is recomputed from the
        // source, undoing any step or toggling visibility can never
        // leave stale pixels behind.
        if (!this.originalImage || this.comparing) return;
        this.elaActive = false;
        document.getElementById('exitEla')?.classList.add('hidden');
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

        // Replay destructive filters in application order
        const w = this.canvas.width, h = this.canvas.height;
        for (const type of this.appliedFilters) {
            this.runFilter(type, this.imageData.data, w, h);
        }

        this.ctx.putImageData(this.imageData, 0, 0);

        if (this.annotations.visible) {
            this.annotations.applyBlursTo(this.ctx);
            this.imageData = this.ctx.getImageData(0, 0, w, h);
        }

        this.updateHistogram();
        this.updateEnhanceTabIndicator();
    }

    runFilter(type, data, w, h) {
        // Executes a single named filter against pixel data
        switch (type) {
            case 'grayscale': Filters.applyGrayscale(data); break;
            case 'invert': Filters.applyInvert(data); break;
            case 'edge': Filters.applyEdgeDetection(data, w, h); break;
            case 'emboss': Filters.applyEmboss(data, w, h); break;
            case 'histogram': Filters.equalizeHistogram(data); break;
            case 'clahe': Filters.applyCLAHE(data, w, h); break;
            case 'noise': Filters.applyDenoising(data, w, h); break;
            case 'whitebalance': Filters.applyAutoWhiteBalance(data); break;
            case 'dehaze': Filters.applyDehaze(data, w, h); break;
        }
    }

    applyFilter(type) {
        // Adds a destructive filter to the pipeline as an undoable command
        if (!this.originalImage) return;

        this.appliedFilters.push(type);
        this.history.push({
            label: 'Filter: ' + type,
            undo: () => {
                const idx = this.appliedFilters.lastIndexOf(type);
                if (idx !== -1) this.appliedFilters.splice(idx, 1);
                this.updateFilterButtons();
                this.applyEnhancements();
            },
            redo: () => {
                this.appliedFilters.push(type);
                this.updateFilterButtons();
                this.applyEnhancements();
            }
        });
        this.updateFilterButtons();
        this.applyEnhancements();
    }

    updateFilterButtons() {
        // Reflects which filters are currently in the pipeline
        document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
            const count = this.appliedFilters.filter(f => f === btn.dataset.filter).length;
            btn.classList.toggle('active', count > 0);
            if (count > 1) btn.dataset.count = count;
            else btn.removeAttribute('data-count');
        });
    }

    updateEnhanceTabIndicator() {
        // Marks the Enhance tab when any non-default adjustment is active
        const d = this.enhancements;
        const modified = d.brightness !== 0 || d.contrast !== 0 || d.saturation !== 0 ||
            d.sharpen !== 0 || d.gamma !== 1.0 ||
            d.balanceR !== 0 || d.balanceG !== 0 || d.balanceB !== 0 ||
            !this.curvesEditor.isIdentity() || this.appliedFilters.length > 0;
        document.querySelector('.tab-btn[data-tab="enhance"]')?.classList.toggle('modified', modified);
    }

    recordAnnotationAction(action) {
        // Records annotation/blur actions from the AnnotationManager on
        // the unified history stack, in strict chronological order
        if (action.type === 'annotation') {
            const ann = action.data;
            this.history.push({
                label: 'Annotation: ' + ann.tool,
                undo: () => this.annotations.removeAnnotation(ann),
                redo: () => this.annotations.addAnnotation(ann)
            });
        } else if (action.type === 'blur') {
            const region = action.data;
            this.history.push({
                label: `Blur region (${region.width}\u00D7${region.height})`,
                undo: () => {
                    this.annotations.removeBlurRegion(region);
                    this.applyEnhancements();
                },
                redo: () => {
                    this.annotations.addBlurRegion(region);
                    this.applyEnhancements();
                }
            });
            // Render the new blur through the live pipeline immediately
            this.applyEnhancements();
        }
    }

    undo() {
        // Reverts the most recent action of any type
        if (!this.history.undo()) showToast('Nothing to undo.', 'info', 1500);
    }

    redo() {
        // Re-applies the most recently undone action
        if (!this.history.redo()) showToast('Nothing to redo.', 'info', 1500);
    }

    updateHistoryUI() {
        // Renders the session history (audit trail) and button states
        const list = document.getElementById('historyList');
        if (list) {
            const entries = this.history.entries();
            list.innerHTML = entries.length === 0
                ? '<p class="no-data">No actions yet</p>'
                : entries.map((label, i) =>
                    `<div class="history-entry"><span class="history-num">${i + 1}</span>${escapeHtml(label)}</div>`
                ).join('');
            list.scrollTop = list.scrollHeight;
        }
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = !this.history.canUndo;
        if (redoBtn) redoBtn.disabled = !this.history.canRedo;
    }

    async runELA() {
        // Renders an Error Level Analysis view: the image is re-encoded
        // as JPEG at a known quality and the amplified difference is
        // shown. Edited-and-resaved regions compress differently and
        // stand out against the uniform error level of untouched areas.
        if (!this.originalImage) {
            showToast('Please load an image first.', 'warning');
            return;
        }
        const quality = parseInt(document.getElementById('elaQuality')?.value || 75) / 100;
        const amplify = parseInt(document.getElementById('elaAmplify')?.value || 15);
        const btn = document.getElementById('runEla');
        if (btn) { btn.disabled = true; btn.textContent = 'ANALYZING...'; }

        try {
            // Analyze the unmodified original so enhancement settings
            // don't contaminate the error levels
            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = this.canvas.width;
            srcCanvas.height = this.canvas.height;
            srcCanvas.getContext('2d').drawImage(this.originalImage, 0, 0);

            const elaData = await computeELA(srcCanvas, quality, amplify);
            this.ctx.putImageData(elaData, 0, 0);
            this.imageData = elaData;
            this.elaActive = true;
            this.updateHistogram();
            document.getElementById('exitEla')?.classList.remove('hidden');
            showToast('ELA view active — uniform noise is normal; bright, sharply-bounded regions warrant a closer look.', 'info', 6000);
        } catch (err) {
            showToast('ELA failed: ' + (err.message || 'unknown error'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'RUN ELA'; }
        }
    }

    exitELA() {
        // Leaves the ELA view and restores the normal pipeline
        this.elaActive = false;
        this.applyEnhancements();
    }

    togglePerspective() {
        // Starts or cancels four-point perspective correction
        if (this.perspectivePoints) {
            this.cancelPerspective();
            return;
        }
        if (!this.originalImage) {
            showToast('Please load an image first.', 'warning');
            return;
        }
        if (this.transform.transform.rotate !== 0 || this.transform.transform.flipH || this.transform.transform.flipV) {
            showToast('Reset rotation/flip before perspective correction.', 'warning');
            return;
        }
        this.perspectivePoints = [];
        this.deselectTool();
        document.getElementById('perspectiveBtn')?.classList.add('active');
        showToast('Click the 4 corners of the region to straighten (Esc to cancel).', 'info', 5000);
    }

    cancelPerspective() {
        // Cancels perspective point collection and clears markers
        this.perspectivePoints = null;
        document.getElementById('perspectiveBtn')?.classList.remove('active');
        this.annotations.redraw();
    }

    addPerspectivePoint(e) {
        // Collects a perspective corner point; warps after the fourth
        const rect = this.annotationCanvas.getBoundingClientRect();
        const scaleX = this.annotationCanvas.width / rect.width;
        const scaleY = this.annotationCanvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        this.perspectivePoints.push({ x, y });

        // Marker feedback
        const ctx = this.annotationCtx;
        const scale = this.annotations.getScaleFactor();
        ctx.save();
        ctx.fillStyle = '#78e030';
        ctx.strokeStyle = '#000';
        ctx.beginPath();
        ctx.arc(x, y, 6 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#000';
        ctx.font = `bold ${10 * scale}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(this.perspectivePoints.length), x, y);
        ctx.restore();

        if (this.perspectivePoints.length === 4) {
            this.applyPerspective(this.perspectivePoints);
            this.perspectivePoints = null;
            document.getElementById('perspectiveBtn')?.classList.remove('active');
        }
    }

    applyPerspective(corners) {
        // Warps the marked quadrilateral to an upright rectangle and
        // swaps it in as the working image (undoable, like crop)
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = this.canvas.width;
        srcCanvas.height = this.canvas.height;
        srcCanvas.getContext('2d').drawImage(this.canvas, 0, 0);

        const warped = perspectiveWarp(srcCanvas, corners);
        if (!warped) {
            showToast('Could not compute perspective warp from those points.', 'error');
            this.annotations.redraw();
            return;
        }

        this.swapWorkingImage(warped.toDataURL(), 'Perspective correction');
    }

    swapWorkingImage(dataUrl, label) {
        // Replaces the working image (crop / perspective), recording an
        // undoable command that restores the previous image and state
        const prevImage = this.originalImage;
        const prevFilters = [...this.appliedFilters];
        const prevBlurs = [...this.annotations.blurRegions];
        const prevAnnotations = [...this.annotations.annotations];

        const newImage = new Image();
        newImage.onload = () => {
            const applyNew = () => {
                this.originalImage = newImage;
                this.annotations.reset();
                this.appliedFilters = [];
                this.resetTransformUI();
                this.setupCanvas();
                this.updateFilterButtons();
                this.applyEnhancements();
                this.updateStatusBar();
                this.updateThumbnail();
            };

            applyNew();

            this.history.push({
                label,
                undo: () => {
                    this.originalImage = prevImage;
                    this.annotations.annotations = [...prevAnnotations];
                    this.annotations.blurRegions = [...prevBlurs];
                    this.appliedFilters = [...prevFilters];
                    this.resetTransformUI();
                    this.setupCanvas();
                    this.updateFilterButtons();
                    this.applyEnhancements();
                    this.annotations.redraw();
                    this.updateStatusBar();
                    this.updateThumbnail();
                },
                redo: applyNew
            });
        };
        newImage.src = dataUrl;
    }

    resetTransformUI() {
        // Resets transform state and its UI controls
        this.transform.reset();
        document.getElementById('zoomLevel').value = 100;
        document.getElementById('rotateAngle').value = 0;
        document.getElementById('zoomLevel').parentElement.querySelector('.value').textContent = '100%';
        document.getElementById('rotateAngle').parentElement.querySelector('.value').textContent = '0°';
        document.getElementById('flipH').classList.remove('active');
        document.getElementById('flipV').classList.remove('active');
        this.updateZoomStatus(100);
    }

    setSrProgress(text, fraction = null) {
        // Updates the super-resolution progress UI
        const wrap = document.getElementById('srProgress');
        const fill = document.getElementById('srProgressFill');
        const label = document.getElementById('srProgressText');
        if (!wrap) return;
        if (text === null) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'block';
        if (label) label.textContent = text;
        if (fill && fraction !== null) fill.style.width = Math.round(fraction * 100) + '%';
    }

    async runSuperResolution() {
        // Upscales the working image with an in-browser neural network.
        // TEXT/PLATE mode wraps the model in a forensic pipeline:
        // denoise -> SR -> iterative back-projection (consistency with
        // the true source pixels, suppressing hallucinated strokes) ->
        // stroke-tuned sharpening. The result replaces the working
        // image as an undoable command, exactly like crop.
        if (this.srBusy) return;
        if (!this.originalImage) {
            showToast('Please load an image first.', 'warning');
            return;
        }

        const W = this.originalImage.width;
        const H = this.originalImage.height;
        const megapixels = (W * H) / 1e6;
        const mode = document.getElementById('srMode')?.value || 'general';
        const passes = parseInt(document.getElementById('srPasses')?.value || '1');
        const modelChoice = document.getElementById('srModel')?.value || 'builtin';

        // Neural upscaling cost grows with area; protect the tab.
        if (W * H > 2048 * 2048) {
            showToast('Image is too large for in-browser super-resolution (max ~4 MP). Crop to the region of interest first.', 'warning', 6000);
            return;
        }
        if (modelChoice === 'realesrgan' && W * H > 512 * 512) {
            showToast('Real-ESRGAN is a heavy model on CPU — above ~0.25 MP expect several minutes. Cropping to the region of interest first is strongly recommended.', 'warning', 7000);
        } else if (megapixels > 1) {
            showToast(`Large image (${megapixels.toFixed(1)} MP) — this may take a while. For faster results, crop to the region of interest first.`, 'info', 5000);
        }

        const btn = document.getElementById('runSuperRes');
        this.srBusy = true;
        if (btn) { btn.disabled = true; btn.textContent = 'WORKING...'; }

        try {
            // Initialize (or reuse) the requested model
            if (!this.superResolver) {
                this.setSrProgress('Loading ONNX Runtime...', 0);
                const resolver = new SuperResolver();
                if (modelChoice === 'custom') {
                    const fileInput = document.getElementById('srModelFile');
                    const file = fileInput?.files?.[0];
                    if (!file) {
                        showToast('Choose a .onnx model file first.', 'warning');
                        return;
                    }
                    this.setSrProgress('Initializing custom model...', 0);
                    await resolver.loadCustom(await file.arrayBuffer(), file.name);
                    this.setSrProgress('Probing model scale...', 0);
                    await resolver.probeScale();
                } else if (DOWNLOADABLE_MODELS[modelChoice]) {
                    const def = DOWNLOADABLE_MODELS[modelChoice];
                    const url = document.getElementById('srModelUrl')?.value?.trim() || def.url;
                    // Integrity check only applies to the pinned default
                    // URL — a user-supplied mirror may be a different
                    // (legitimate) build of the same model
                    const expectedHash = url === def.url ? def.sha256 : null;
                    await resolver.loadFromUrl(url, def.label, def.filename,
                        (status, fraction) => this.setSrProgress(status, fraction ?? 0), expectedHash);
                    this.setSrProgress('Probing model scale...', 0);
                    await resolver.probeScale();
                    document.getElementById('saveSrModel')?.classList.remove('hidden');
                } else {
                    await resolver.loadBuiltin((status) => this.setSrProgress(status, 0));
                }
                this.superResolver = resolver;
            }
            const scale = this.superResolver.scale;

            // Run on the unmodified working image, like ELA: enhancement
            // settings stay non-destructive and re-apply to the result
            let current = document.createElement('canvas');
            current.width = W;
            current.height = H;
            current.getContext('2d').drawImage(this.originalImage, 0, 0);

            if (mode === 'text') {
                this.setSrProgress('Denoising (text mode)...', 0);
                preprocessForText(current);
                await new Promise(r => setTimeout(r, 0));
            }

            for (let pass = 1; pass <= passes; pass++) {
                // Re-check area before each pass: 2-pass at 3x is 9x total
                if (current.width * current.height * scale * scale > 2048 * 2048 * 1.2) {
                    showToast(`Stopped after pass ${pass - 1}: the next pass would exceed the in-browser size limit.`, 'warning', 5000);
                    break;
                }

                const passLabel = passes > 1 ? ` (pass ${pass}/${passes})` : '';
                const result = await this.superResolver.upscale(current, (done, total) => {
                    this.setSrProgress(`Processing tile ${done}/${total}${passLabel}...`, done / total);
                });

                // Back-projection: enforce that downscaling the result
                // reproduces the actual observed pixels. In TEXT mode
                // this is the key anti-hallucination step; in GENERAL
                // mode one light iteration still tightens edges.
                const ibpIterations = mode === 'text' ? 3 : 1;
                await backProject(current, result, ibpIterations, 0.75, (it, total) => {
                    this.setSrProgress(`Back-projection ${it}/${total}${passLabel}...`, it / total);
                });

                current = result;
            }

            if (mode === 'text') {
                this.setSrProgress('Stroke enhancement...', 1);
                postprocessForText(current);
                await new Promise(r => setTimeout(r, 0));
            }

            this.setSrProgress('Finalizing...', 1);
            const totalScale = Math.round(current.width / W);
            const modeLabel = mode === 'text' ? ', text/plate mode' : '';
            this.swapWorkingImage(current.toDataURL(), `Super-resolution (${totalScale}x, ${this.superResolver.label}${modeLabel})`);
            showToast(`Upscaled ${W}\u00D7${H} \u2192 ${current.width}\u00D7${current.height} with ${this.superResolver.label}${modeLabel}. Ctrl+Z to revert.`, 'success', 5000);
        } catch (err) {
            console.error('Super-resolution failed:', err);
            showToast('Super-resolution failed: ' + (err.message || 'unknown error'), 'error', 6000);
            this.superResolver = null;
        } finally {
            this.srBusy = false;
            this.setSrProgress(null);
            if (btn) { btn.disabled = false; btn.textContent = 'UPSCALE IMAGE'; }
        }
    }

    toggleCrop() {
        // Toggles crop mode and applies crop when selection exists.
        // Crop selection is drawn in untransformed canvas space, so it
        // cannot be meaningfully mapped while the view is rotated or
        // flipped — refuse to enter crop mode in that state.
        if (!this.transform.cropMode &&
            (this.transform.transform.rotate !== 0 || this.transform.transform.flipH || this.transform.transform.flipV)) {
            showToast('Reset rotation/flip before cropping — the selection would not match the rotated view.', 'warning', 4500);
            return;
        }

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
        // Crops image to specified rectangle (undoable)
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = rect.width;
        tempCanvas.height = rect.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(this.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);

        this.swapWorkingImage(tempCanvas.toDataURL(), `Crop (${rect.width}\u00D7${rect.height})`);
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
        this.currentFile = null;
        this.watermarkSettings = null;
        this.captionSettings = null;
        this.colorPickerActive = false;
        this.comparing = false;
        this.elaActive = false;
        this.appliedFilters = [];
        this.cancelPerspective?.();
        this.history.clear();
        this.updateHistoryUI();
        this.updateFilterButtons();
        document.getElementById('exitEla')?.classList.add('hidden');
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
        this.comparing = false;
        this.elaActive = false;
        this.cancelPerspective();
        document.getElementById('exitEla')?.classList.add('hidden');
        this.history.clear();
        this.updateHistoryUI();
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
        // Resets all enhancement, filter, and transform values
        this.enhancements = {
            brightness: 0, contrast: 0, saturation: 0,
            sharpen: 0, sharpenRadius: 2, sharpenThreshold: 0,
            gamma: 1.0, balanceR: 0, balanceG: 0, balanceB: 0
        };
        this.appliedFilters = [];
        this.updateFilterButtons();
        this.transform.reset();
        this.updateZoomStatus(100);
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
            this.applyEnhancements();
        }
    }

    resetAdjustments() {
        // Resets adjustment sliders only
        this.enhancements = {
            brightness: 0, contrast: 0, saturation: 0,
            sharpen: 0, sharpenRadius: 2, sharpenThreshold: 0,
            gamma: 1.0, balanceR: 0, balanceG: 0, balanceB: 0
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
            this.applyEnhancements();
        }
    }

    resetFilters() {
        // Clears all applied destructive filters and re-renders
        if (!this.originalImage) return;
        this.appliedFilters = [];
        this.updateFilterButtons();
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
        this.updateZoomStatus(100);
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
            showToast('Could not copy to clipboard.', 'error');
        }
    }

    async extractEXIF(file, sourceLabel = null) {
        // Extracts and displays file metadata, hash, EXIF data, JPEG
        // internals (quantization tables), and the embedded thumbnail.
        // All values are HTML-escaped: EXIF strings are attacker-
        // controllable, and unescaped innerHTML here was an XSS vector.
        const el = document.getElementById('exifContent');
        let html = '';

        let arrayBuffer = null;
        let imageHash = '';
        try {
            arrayBuffer = await file.arrayBuffer();
            imageHash = await this.computeImageHash(arrayBuffer);
        } catch {
            imageHash = 'Unable to compute';
        }

        html += '<div class="meta-section"><h4>FILE INFO</h4><table class="exif-table">';
        if (sourceLabel) {
            html += `<tr><td class="exif-key">Source</td><td class="exif-value">${escapeHtml(sourceLabel)}</td></tr>`;
        }
        if (file.name) {
            html += `<tr><td class="exif-key">Name</td><td class="exif-value">${escapeHtml(file.name)}</td></tr>`;
        }
        html += `<tr><td class="exif-key">Size</td><td class="exif-value">${escapeHtml(this.formatFileSize(file.size))}</td></tr>`;
        html += `<tr><td class="exif-key">Type</td><td class="exif-value">${escapeHtml(file.type || 'Unknown')}</td></tr>`;
        if (file.lastModified) {
            html += `<tr><td class="exif-key">Modified</td><td class="exif-value">${escapeHtml(new Date(file.lastModified).toLocaleString())}</td></tr>`;
        }
        html += '</table></div>';

        html += '<div class="meta-section"><h4>FILE HASH</h4><table class="exif-table">';
        html += `<tr><td class="exif-key">SHA-256</td><td class="exif-value hash-value">${escapeHtml(imageHash)}` +
            ` <button class="copy-meta-btn" data-copy="${escapeHtml(imageHash)}" title="Copy hash">COPY</button></td></tr>`;
        html += '</table></div>';

        let exifData = null;
        let parseError = null;
        try {
            // Full option set: the full exifr build parses PNG/TIFF
            // containers plus IPTC and ICC blocks the lite build lacked
            exifData = await exifr.parse(file, {
                translateKeys: true,
                translateValues: true,
                iptc: true,
                icc: true,
                xmp: true
            });
        } catch (err) {
            parseError = err;
            console.error('EXIF parse error:', err);
        }

        if (exifData && Object.keys(exifData).length > 0) {
            const cameraFields = ['Make', 'Model', 'LensModel', 'Software'];
            const settingsFields = ['ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'Flash', 'WhiteBalance', 'Orientation'];
            // exifr translates tag 0x0132 (DateTime) to ModifyDate and
            // DateTimeDigitized to CreateDate — the old names never matched
            const dateFields = ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'OffsetTimeOriginal'];

            const cameraData = this.filterExifFields(exifData, cameraFields);
            const settingsData = this.filterExifFields(exifData, settingsFields);
            const dateData = this.filterExifFields(exifData, dateFields);

            if (Object.keys(cameraData).length > 0) {
                html += '<div class="meta-section"><h4>CAMERA</h4>' + this.buildExifTable(cameraData) + '</div>';
            }
            if (Object.keys(settingsData).length > 0) {
                html += '<div class="meta-section"><h4>SETTINGS</h4>' + this.buildExifTable(settingsData) + '</div>';
            }
            if (Object.keys(dateData).length > 0) {
                html += '<div class="meta-section"><h4>DATE/TIME</h4>' + this.buildExifTable(dateData) + '</div>';
            }

            if (exifData.latitude && exifData.longitude) {
                const lat = Number(exifData.latitude);
                const lon = Number(exifData.longitude);
                const d = 0.005;
                const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
                html += `<div class="meta-section"><h4>LOCATION</h4>
                    <div class="gps-info">
                        <table class="exif-table">
                            <tr><td class="exif-key">Latitude</td><td class="exif-value">${lat.toFixed(6)}</td></tr>
                            <tr><td class="exif-key">Longitude</td><td class="exif-value">${lon.toFixed(6)}</td></tr>
                            ${exifData.GPSAltitude !== undefined ? `<tr><td class="exif-key">Altitude</td><td class="exif-value">${escapeHtml(String(exifData.GPSAltitude))} m</td></tr>` : ''}
                        </table>
                        <iframe class="gps-map-embed" loading="lazy"
                            src="https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat},${lon}"></iframe>
                        <div class="gps-links">
                            <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}" target="_blank" rel="noopener" class="map-link">OPENSTREETMAP</a>
                            <a href="https://maps.google.com/?q=${lat},${lon}" target="_blank" rel="noopener" class="map-link">GOOGLE MAPS</a>
                        </div>
                    </div>
                </div>`;
            }

            // Collapsible raw dump of every parsed field
            const rawRows = Object.entries(exifData)
                .filter(([, v]) => typeof v !== 'object' || v instanceof Date)
                .map(([k, v]) => {
                    const val = v instanceof Date ? v.toLocaleString() : String(v);
                    return `<tr><td class="exif-key">${escapeHtml(k)}</td><td class="exif-value">${escapeHtml(val)}</td></tr>`;
                }).join('');
            if (rawRows) {
                html += `<div class="meta-section"><details class="raw-exif">
                    <summary>RAW METADATA DUMP (${Object.keys(exifData).length} fields)</summary>
                    <table class="exif-table">${rawRows}</table>
                </details></div>`;
            }
        } else if (parseError) {
            html += '<div class="meta-section"><h4>EXIF DATA</h4><p class="no-data">Could not parse metadata for this format' +
                ` (${escapeHtml(parseError.message || 'parser error')})</p></div>`;
        } else {
            html += '<div class="meta-section"><h4>EXIF DATA</h4><p class="no-data">No EXIF data present in this file</p></div>';
        }

        // JPEG internals: quantization tables fingerprint the encoder
        if (arrayBuffer) {
            const jpeg = parseJPEGInternals(arrayBuffer);
            if (jpeg && jpeg.quantTables.length > 0) {
                html += '<div class="meta-section"><h4>JPEG INTERNALS</h4>';
                if (jpeg.frame) {
                    html += `<table class="exif-table">
                        <tr><td class="exif-key">Encoding</td><td class="exif-value">${jpeg.progressive ? 'Progressive' : 'Baseline'}</td></tr>
                        <tr><td class="exif-key">Bit depth</td><td class="exif-value">${jpeg.frame.bitDepth}</td></tr>
                        <tr><td class="exif-key">Components</td><td class="exif-value">${jpeg.frame.components}</td></tr>
                        <tr><td class="exif-key">Est. quality</td><td class="exif-value">~${estimateJPEGQuality(jpeg.quantTables[0].values)} (IJG scale)</td></tr>
                    </table>`;
                }
                html += '<p class="section-hint">Quantization tables are a fingerprint of the encoding software/quality — re-saving an image replaces them.</p>';
                jpeg.quantTables.forEach((qt) => {
                    const labels = ['LUMINANCE', 'CHROMINANCE'];
                    html += `<div class="quant-table-wrap"><div class="quant-label">DQT ${qt.id} ${labels[qt.id] || ''} (${qt.precision}-bit)</div><div class="quant-table">`;
                    html += qt.values.map(v => `<span>${v}</span>`).join('');
                    html += '</div></div>';
                });
                html += '</div>';
            }
        }

        el.innerHTML = html;

        el.querySelectorAll('.copy-meta-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.copy).then(() => {
                    btn.textContent = 'COPIED';
                    setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
                }).catch(() => {});
            });
        });

        // Embedded EXIF thumbnail: appended asynchronously; a thumbnail
        // that doesn't match the main image betrays post-capture editing
        this.appendEmbeddedThumbnail(file, el);
    }

    async appendEmbeddedThumbnail(file, el) {
        // Extracts and displays the EXIF-embedded thumbnail for comparison
        try {
            const thumbUrl = await extractEmbeddedThumbnail(file);
            if (!thumbUrl) return;
            const section = document.createElement('div');
            section.className = 'meta-section';
            section.innerHTML = `<h4>EMBEDDED THUMBNAIL</h4>
                <p class="section-hint">Cameras embed this at capture time. If it doesn't match the main image, the file was edited after capture.</p>
                <div class="thumb-compare"><img class="embedded-thumb" alt="Embedded EXIF thumbnail"></div>`;
            section.querySelector('img').src = thumbUrl;
            el.appendChild(section);
        } catch {}
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
        // Builds HTML table from EXIF key-value pairs (all values escaped)
        let html = '<table class="exif-table">';
        Object.entries(data).forEach(([key, value]) => {
            const displayKey = key.replace(/([A-Z])/g, ' $1').trim();
            let displayValue = value;
            if (value instanceof Date) {
                displayValue = value.toLocaleString();
            }
            html += `<tr><td class="exif-key">${escapeHtml(displayKey)}</td><td class="exif-value">${escapeHtml(String(displayValue))}</td></tr>`;
        });
        html += '</table>';
        return html;
    }

    computeImageStats() {
        // Analyzes the working image (downsampled for speed) and returns
        // luminance percentiles and channel means for adaptive presets
        const maxDim = 320;
        const scale = Math.min(1, maxDim / Math.max(this.originalImage.width, this.originalImage.height));
        const w = Math.max(1, Math.round(this.originalImage.width * scale));
        const h = Math.max(1, Math.round(this.originalImage.height * scale));

        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(this.originalImage, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;

        const hist = new Uint32Array(256);
        let rSum = 0, gSum = 0, bSum = 0;
        const n = w * h;
        for (let i = 0; i < data.length; i += 4) {
            rSum += data[i];
            gSum += data[i + 1];
            bSum += data[i + 2];
            hist[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
        }

        const percentile = (p) => {
            const target = n * p;
            let acc = 0;
            for (let v = 0; v < 256; v++) {
                acc += hist[v];
                if (acc >= target) return v;
            }
            return 255;
        };

        return {
            p1: percentile(0.01),
            median: percentile(0.5),
            p99: percentile(0.99),
            rMean: rSum / n,
            gMean: gSum / n,
            bMean: bSum / n
        };
    }

    applyPreset(preset) {
        // Applies an enhancement preset (single pipeline pass, undoable).
        // 'Auto' presets are adaptive: they analyze the image histogram
        // and channel means and compute slider values from what they
        // find, so the resulting settings are visible and auditable in
        // the sliders rather than being a black box.
        if (!this.originalImage) return;

        const clampVal = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

        // Adaptive building blocks ------------------------------------
        const autoGamma = (stats, targetLuma, lo, hi) => {
            // Gamma that maps the median luminance onto targetLuma
            const m = clampVal(stats.median, 4, 250) / 255;
            return clampVal(Math.log(m) / Math.log(targetLuma / 255), lo, hi);
        };
        const autoContrast = (stats, targetSpread, strength, max) => {
            // Contrast proportional to how compressed the histogram is
            const spread = Math.max(8, stats.p99 - stats.p1);
            return clampVal((targetSpread - spread) * strength, 0, max);
        };
        const autoBrightness = (stats, strength, max) => {
            // Recenters the histogram midpoint toward 128
            const mid = (stats.p1 + stats.p99) / 2;
            return clampVal(((128 - mid) / 2.55) * strength, -max, max);
        };
        const autoBalance = (stats, strength, max) => {
            // Gray-world channel shifts mapped onto the balance sliders
            const avg = (stats.rMean + stats.gMean + stats.bMean) / 3;
            return {
                balanceR: clampVal((avg - stats.rMean) * strength, -max, max),
                balanceG: clampVal((avg - stats.gMean) * strength, -max, max),
                balanceB: clampVal((avg - stats.bMean) * strength, -max, max)
            };
        };

        // Preset definitions: static objects or stats-driven functions -
        const presets = {
            auto: (s) => ({
                // Smart auto: exposure + contrast + white balance, all
                // measured from this image rather than fixed numbers
                gamma: autoGamma(s, 118, 0.65, 1.9),
                contrast: autoContrast(s, 220, 0.35, 35),
                brightness: autoBrightness(s, 0.3, 15),
                saturation: 8,
                sharpen: 12,
                ...autoBalance(s, 0.7, 35)
            }),
            levels: (s) => ({
                // Pure tonal stretch (no color changes)
                gamma: autoGamma(s, 122, 0.7, 1.8),
                contrast: autoContrast(s, 250, 0.5, 45),
                brightness: autoBrightness(s, 0.5, 25),
                saturation: 0,
                sharpen: 0
            }),
            color: (s) => ({
                // Cast correction only
                brightness: 0, contrast: 0, gamma: 1.0, sharpen: 0,
                saturation: 5,
                ...autoBalance(s, 0.9, 45)
            }),
            lowlight: (s) => ({
                // Shadow lift scaled to how dark the image actually is
                gamma: autoGamma(s, 140, 1.0, 2.2),
                brightness: clampVal((90 - s.median) / 2.55 * 0.4, 0, 30),
                contrast: 15,
                saturation: 5,
                sharpen: 10
            }),
            forensic: { contrast: 40, sharpen: 50, saturation: -30, gamma: 0.9, brightness: 5 },
            document: { contrast: 35, saturation: -60, sharpen: 45, sharpenRadius: 1, gamma: 1.05, brightness: 0 },
            clarity: { contrast: 20, sharpen: 40, saturation: 0, gamma: 1.0, brightness: 0 },
            vivid: { saturation: 40, contrast: 25, brightness: 5, sharpen: 15, gamma: 1.05 },
            muted: { saturation: -40, contrast: -10, brightness: -5, sharpen: 0, gamma: 1.0 }
        };

        const def = presets[preset];
        if (!def) return;

        const settings = typeof def === 'function' ? def(this.computeImageStats()) : def;
        const prev = { ...this.enhancements };

        const apply = () => {
            this.enhancements.brightness = Math.round(settings.brightness ?? 0);
            this.enhancements.contrast = Math.round(settings.contrast ?? 0);
            this.enhancements.saturation = Math.round(settings.saturation ?? 0);
            this.enhancements.sharpen = Math.round(settings.sharpen ?? 0);
            this.enhancements.sharpenRadius = settings.sharpenRadius ?? 2;
            this.enhancements.gamma = Math.round((settings.gamma ?? 1.0) * 100) / 100;
            this.enhancements.balanceR = Math.round(settings.balanceR ?? 0);
            this.enhancements.balanceG = Math.round(settings.balanceG ?? 0);
            this.enhancements.balanceB = Math.round(settings.balanceB ?? 0);
            this.syncEnhancementSliders();
            document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelector(`[data-preset="${preset}"]`)?.classList.add('active');
            this.applyEnhancements();
        };

        apply();

        this.history.push({
            label: 'Preset: ' + preset,
            undo: () => {
                this.enhancements = { ...prev };
                this.syncEnhancementSliders();
                document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
                this.applyEnhancements();
            },
            redo: apply
        });
    }

    syncEnhancementSliders() {
        // Mirrors current enhancement state into the slider UI
        const set = (id, value, text) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = value;
            const v = el.parentElement.querySelector('.value');
            if (v) v.textContent = text !== undefined ? text : String(value);
        };
        set('brightness', this.enhancements.brightness);
        set('contrast', this.enhancements.contrast);
        set('saturation', this.enhancements.saturation);
        set('sharpen', this.enhancements.sharpen);
        set('gamma', this.enhancements.gamma * 100, this.enhancements.gamma.toFixed(2));
        set('sharpenRadius', this.enhancements.sharpenRadius, this.enhancements.sharpenRadius + 'px');
        set('sharpenThreshold', this.enhancements.sharpenThreshold);
        set('balanceR', this.enhancements.balanceR);
        set('balanceG', this.enhancements.balanceG);
        set('balanceB', this.enhancements.balanceB);
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

                if (!panel.classList.contains('collapsed')) {
                    this.prefs.panelWidth = panel.offsetWidth;
                    savePrefs(this.prefs);
                }
            }
        });

        handle.addEventListener('dblclick', () => {
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                panel.style.width = defaultWidth + 'px';
                this.prefs.panelWidth = defaultWidth;
                savePrefs(this.prefs);
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
            showToast('Please load an image first.', 'warning');
            return;
        }

        const text = document.getElementById('watermarkText')?.value.trim();
        if (!text) {
            showToast('Please enter watermark text.', 'warning');
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
            showToast('Please load an image first.', 'warning');
            return;
        }

        const text = document.getElementById('captionText')?.value.trim();
        if (!text) {
            showToast('Please enter caption text.', 'warning');
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
            this.loadImageFromBlob(blob, 'URL: ' + url);
            input.value = '';
        } catch {
            try {
                const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
                const response = await fetch(proxyUrl);
                if (!response.ok) throw new Error('Proxy failed');
                const blob = await response.blob();
                this.loadImageFromBlob(blob, 'URL (via proxy): ' + url);
                input.value = '';
            } catch {
                showToast('Could not load image from URL. The server may block cross-origin requests.', 'error', 5000);
            }
        } finally {
            if (span) span.textContent = 'URL';
        }
    }

    async reverseImageSearch(engine) {
        // Copies image to clipboard and opens reverse image search engine
        if (!this.originalImage) {
            showToast('Please load an image first.', 'warning');
            return;
        }

        const exportCanvas = this.createExportCanvas(false);
        try {
            const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        } catch {}

        const urls = {
            google: 'https://lens.google.com/',
            yandex: 'https://yandex.com/images/',
            tineye: 'https://tineye.com/',
            bing: 'https://www.bing.com/visualsearch'
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
            showToast('Please load an image first.', 'warning');
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
