/*
 * Curves Editor
 *
 * Interactive tone curve editor using a canvas-based UI. Users click
 * to add control points, drag to adjust, and double-click to remove.
 * Uses monotone cubic Hermite interpolation to generate a 256-entry
 * lookup table for pixel remapping.
 */

export class CurvesEditor {
    constructor(canvas, onChange) {
        // Initializes curve editor with canvas, callback, and default control points
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.onChange = onChange;
        this.points = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
        this.dragging = null;
        this.lut = this.buildLUT();
        this.initListeners();
        this.draw();
    }

    initListeners() {
        // Binds mouse interaction events for point manipulation
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.onMouseUp());
        this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
        this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    getMousePos(e) {
        // Converts mouse position to 0-255 curve coordinate space
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: Math.round((e.clientX - rect.left) / rect.width * 255),
            y: Math.round(255 - (e.clientY - rect.top) / rect.height * 255)
        };
    }

    onMouseDown(e) {
        // Starts dragging existing point or adds new one
        e.preventDefault();
        const pos = this.getMousePos(e);

        for (let i = 0; i < this.points.length; i++) {
            const dx = pos.x - this.points[i].x;
            const dy = pos.y - this.points[i].y;
            if (Math.sqrt(dx * dx + dy * dy) < 12) {
                this.dragging = i;
                return;
            }
        }

        this.addPoint(pos.x, pos.y);
    }

    addPoint(x, y) {
        // Inserts a new control point sorted by x position
        x = Math.max(0, Math.min(255, x));
        y = Math.max(0, Math.min(255, y));
        let idx = this.points.findIndex(p => p.x > x);
        if (idx === -1) idx = this.points.length;
        this.points.splice(idx, 0, { x, y });
        this.dragging = idx;
        this.updateLUT();
    }

    onMouseMove(e) {
        // Updates dragged point position with neighbor constraints
        if (this.dragging === null) return;
        const pos = this.getMousePos(e);
        const pt = this.points[this.dragging];

        if (this.dragging === 0) {
            pt.y = Math.max(0, Math.min(255, pos.y));
        } else if (this.dragging === this.points.length - 1) {
            pt.y = Math.max(0, Math.min(255, pos.y));
        } else {
            const minX = this.points[this.dragging - 1].x + 1;
            const maxX = this.points[this.dragging + 1].x - 1;
            pt.x = Math.max(minX, Math.min(maxX, pos.x));
            pt.y = Math.max(0, Math.min(255, pos.y));
        }

        this.updateLUT();
    }

    onMouseUp() {
        // Ends point drag operation
        this.dragging = null;
    }

    onDblClick(e) {
        // Removes control point near double-click position
        e.preventDefault();
        const pos = this.getMousePos(e);
        for (let i = 1; i < this.points.length - 1; i++) {
            const dx = pos.x - this.points[i].x;
            const dy = pos.y - this.points[i].y;
            if (Math.sqrt(dx * dx + dy * dy) < 12) {
                this.points.splice(i, 1);
                this.updateLUT();
                return;
            }
        }
    }

    updateLUT() {
        // Rebuilds lookup table and triggers change callback
        this.lut = this.buildLUT();
        this.draw();
        this.onChange(this.lut);
    }

    buildLUT() {
        // Generates 256-entry LUT via monotone cubic Hermite interpolation
        const lut = new Uint8Array(256);
        const n = this.points.length;
        if (n < 2) {
            for (let i = 0; i < 256; i++) lut[i] = i;
            return lut;
        }

        const xs = this.points.map(p => p.x);
        const ys = this.points.map(p => p.y);

        const ds = [];
        for (let i = 0; i < n - 1; i++) {
            ds.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1));
        }

        const ms = new Array(n);
        ms[0] = ds[0];
        ms[n - 1] = ds[n - 2];
        for (let i = 1; i < n - 1; i++) {
            if (ds[i - 1] * ds[i] <= 0) {
                ms[i] = 0;
            } else {
                ms[i] = (ds[i - 1] + ds[i]) / 2;
            }
        }

        for (let i = 0; i < n - 1; i++) {
            if (Math.abs(ds[i]) < 1e-6) {
                ms[i] = 0;
                ms[i + 1] = 0;
            } else {
                const a = ms[i] / ds[i];
                const b = ms[i + 1] / ds[i];
                const s = a * a + b * b;
                if (s > 9) {
                    const t = 3 / Math.sqrt(s);
                    ms[i] = t * a * ds[i];
                    ms[i + 1] = t * b * ds[i];
                }
            }
        }

        for (let x = 0; x < 256; x++) {
            if (x <= xs[0]) {
                lut[x] = Math.max(0, Math.min(255, Math.round(ys[0])));
                continue;
            }
            if (x >= xs[n - 1]) {
                lut[x] = Math.max(0, Math.min(255, Math.round(ys[n - 1])));
                continue;
            }

            let seg = 0;
            for (let i = 0; i < n - 1; i++) {
                if (x >= xs[i] && x <= xs[i + 1]) { seg = i; break; }
            }

            const h = xs[seg + 1] - xs[seg] || 1;
            const t = (x - xs[seg]) / h;
            const t2 = t * t;
            const t3 = t2 * t;
            const val = (2 * t3 - 3 * t2 + 1) * ys[seg]
                + (t3 - 2 * t2 + t) * h * ms[seg]
                + (-2 * t3 + 3 * t2) * ys[seg + 1]
                + (t3 - t2) * h * ms[seg + 1];
            lut[x] = Math.max(0, Math.min(255, Math.round(val)));
        }

        return lut;
    }

    draw() {
        // Renders curve canvas with grid, reference line, curve, and control points
        const ctx = this.ctx;
        const w = 256, h = 256;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
            const p = i * 64;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(w, p); ctx.stroke();
        }

        ctx.strokeStyle = '#333';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(w, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = 0; x < 256; x++) {
            const y = 255 - this.lut[x];
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        for (const pt of this.points) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(pt.x, 255 - pt.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    reset() {
        // Restores default linear curve with two endpoints
        this.points = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
        this.updateLUT();
    }

    isIdentity() {
        // Returns true if curve is unchanged from default
        return this.points.length === 2 &&
            this.points[0].x === 0 && this.points[0].y === 0 &&
            this.points[1].x === 255 && this.points[1].y === 255;
    }

    getLUT() {
        // Returns current 256-entry lookup table
        return this.lut;
    }
}
