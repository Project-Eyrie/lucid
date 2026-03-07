/*
 * Histogram Display
 *
 * Renders RGB and luminance channel histograms for the current
 * image data. Displays as filled semi-transparent overlapping
 * area charts on a canvas element.
 */

export class HistogramDisplay {
    constructor(canvas) {
        // Sets up canvas context for histogram rendering
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    update(imageData) {
        // Computes per-channel histograms from image data and redraws
        if (!imageData) return;
        const data = imageData.data;
        const rHist = new Uint32Array(256);
        const gHist = new Uint32Array(256);
        const bHist = new Uint32Array(256);
        const lHist = new Uint32Array(256);

        for (let i = 0; i < data.length; i += 4) {
            rHist[data[i]]++;
            gHist[data[i + 1]]++;
            bHist[data[i + 2]]++;
            const l = Math.round(0.2989 * data[i] + 0.5870 * data[i + 1] + 0.1140 * data[i + 2]);
            lHist[l]++;
        }

        this.draw(rHist, gHist, bHist, lHist);
    }

    draw(rHist, gHist, bHist, lHist) {
        // Renders overlapping filled area charts for each channel
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, w, h);

        let max = 0;
        for (let i = 1; i < 255; i++) {
            max = Math.max(max, rHist[i], gHist[i], bHist[i]);
        }
        if (max === 0) return;

        this.drawChannel(ctx, lHist, max, 'rgba(255, 255, 255, 0.2)', w, h);
        this.drawChannel(ctx, rHist, max, 'rgba(255, 50, 50, 0.4)', w, h);
        this.drawChannel(ctx, gHist, max, 'rgba(50, 255, 50, 0.4)', w, h);
        this.drawChannel(ctx, bHist, max, 'rgba(80, 120, 255, 0.4)', w, h);
    }

    drawChannel(ctx, hist, max, color, w, h) {
        // Draws a single channel as a filled area path
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < 256; i++) {
            const x = (i / 255) * w;
            const barH = Math.min(h, (hist[i] / max) * h);
            ctx.lineTo(x, h - barH);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
    }
}
