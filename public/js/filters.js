/*
 * Image Filters
 *
 * Contains pixel manipulation functions for applying visual effects
 * to images. Includes color transformations, edge detection using
 * Sobel operators, convolution kernels for emboss/sharpen, median
 * filtering for noise reduction, and box blur with multiple passes.
 */

export function applyGrayscale(data) {
    // Converts image to grayscale using luminance weights
    for (let i = 0; i < data.length; i += 4) {
        const gray = 0.2989 * data[i] + 0.5870 * data[i + 1] + 0.1140 * data[i + 2];
        data[i] = data[i + 1] = data[i + 2] = gray;
    }
}

export function applyInvert(data) {
    // Inverts all RGB color values to create negative effect
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
    }
}

export function applyEdgeDetection(data, width, height) {
    // Detects edges using Sobel operator convolution
    const output = new Uint8ClampedArray(data.length);
    const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let pixelX = 0, pixelY = 0;

            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    const idx = ((y + ky) * width + (x + kx)) * 4;
                    const gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                    const kernelIdx = (ky + 1) * 3 + (kx + 1);
                    pixelX += gray * sobelX[kernelIdx];
                    pixelY += gray * sobelY[kernelIdx];
                }
            }

            const magnitude = Math.sqrt(pixelX * pixelX + pixelY * pixelY);
            const idx = (y * width + x) * 4;
            output[idx] = output[idx + 1] = output[idx + 2] = Math.min(255, magnitude);
            output[idx + 3] = 255;
        }
    }

    for (let i = 0; i < data.length; i++) data[i] = output[i];
}

export function applyEmboss(data, width, height) {
    // Creates 3D raised effect using emboss convolution kernel
    const output = new Uint8ClampedArray(data.length);
    const kernel = [-2, -1, 0, -1, 1, 1, 0, 1, 2];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                        sum += data[idx] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                output[(y * width + x) * 4 + c] = Math.min(255, Math.max(0, sum + 128));
            }
            output[(y * width + x) * 4 + 3] = 255;
        }
    }

    for (let i = 0; i < data.length; i++) data[i] = output[i];
}

export function applyDenoising(data, width, height) {
    // Reduces noise using 3x3 median filter
    const output = new Uint8ClampedArray(data);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            for (let c = 0; c < 3; c++) {
                const values = [];
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        values.push(data[((y + ky) * width + (x + kx)) * 4 + c]);
                    }
                }
                values.sort((a, b) => a - b);
                output[(y * width + x) * 4 + c] = values[4];
            }
        }
    }

    for (let i = 0; i < data.length; i++) data[i] = output[i];
}

export function equalizeHistogram(data) {
    // Improves contrast by redistributing intensity values
    const histogram = new Array(256).fill(0);
    const cdf = new Array(256).fill(0);

    for (let i = 0; i < data.length; i += 4) {
        const gray = Math.round(0.2989 * data[i] + 0.5870 * data[i + 1] + 0.1140 * data[i + 2]);
        histogram[gray]++;
    }

    cdf[0] = histogram[0];
    for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + histogram[i];

    const pixels = data.length / 4;
    const min = cdf.find(val => val > 0);

    for (let i = 0; i < data.length; i += 4) {
        const gray = Math.round(0.2989 * data[i] + 0.5870 * data[i + 1] + 0.1140 * data[i + 2]);
        const newVal = Math.round(((cdf[gray] - min) / (pixels - min)) * 255);
        const ratio = Math.min(4, newVal / (gray || 1));
        data[i] = Math.min(255, data[i] * ratio);
        data[i + 1] = Math.min(255, data[i + 1] * ratio);
        data[i + 2] = Math.min(255, data[i + 2] * ratio);
    }
}

export function applySharpen(data, width, height, amount) {
    // Enhances edges using unsharp mask convolution
    const output = new Uint8ClampedArray(data);
    const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                        sum += data[idx] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                const idx = (y * width + x) * 4 + c;
                output[idx] = Math.min(255, Math.max(0, data[idx] + (sum - data[idx]) * amount));
            }
        }
    }

    for (let i = 0; i < data.length; i++) data[i] = output[i];
}

export function applyBlur(data, width, height, strength) {
    // Applies smooth blur using 3-pass box blur algorithm
    const radius = Math.max(2, Math.floor(strength / 3));
    const passes = 3;

    for (let pass = 0; pass < passes; pass++) {
        const temp = new Uint8ClampedArray(data);

        for (let y = 0; y < height; y++) {
            let r = 0, g = 0, b = 0, a = 0, count = 0;

            for (let x = 0; x <= radius && x < width; x++) {
                const idx = (y * width + x) * 4;
                r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
                count++;
            }

            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                temp[idx] = r / count;
                temp[idx + 1] = g / count;
                temp[idx + 2] = b / count;
                temp[idx + 3] = a / count;

                const addX = x + radius + 1;
                if (addX < width) {
                    const addIdx = (y * width + addX) * 4;
                    r += data[addIdx]; g += data[addIdx + 1]; b += data[addIdx + 2]; a += data[addIdx + 3];
                    count++;
                }

                const remX = x - radius;
                if (remX >= 0) {
                    const remIdx = (y * width + remX) * 4;
                    r -= data[remIdx]; g -= data[remIdx + 1]; b -= data[remIdx + 2]; a -= data[remIdx + 3];
                    count--;
                }
            }
        }

        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0, count = 0;

            for (let y = 0; y <= radius && y < height; y++) {
                const idx = (y * width + x) * 4;
                r += temp[idx]; g += temp[idx + 1]; b += temp[idx + 2]; a += temp[idx + 3];
                count++;
            }

            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * 4;
                data[idx] = r / count;
                data[idx + 1] = g / count;
                data[idx + 2] = b / count;
                data[idx + 3] = a / count;

                const addY = y + radius + 1;
                if (addY < height) {
                    const addIdx = (addY * width + x) * 4;
                    r += temp[addIdx]; g += temp[addIdx + 1]; b += temp[addIdx + 2]; a += temp[addIdx + 3];
                    count++;
                }

                const remY = y - radius;
                if (remY >= 0) {
                    const remIdx = (remY * width + x) * 4;
                    r -= temp[remIdx]; g -= temp[remIdx + 1]; b -= temp[remIdx + 2]; a -= temp[remIdx + 3];
                    count--;
                }
            }
        }
    }
}

export function applyCLAHE(data, width, height, clipLimit = 2.5, tiles = 8) {
    // Contrast-limited adaptive histogram equalization on the luminance
    // channel. The image is divided into a tiles x tiles grid; each tile
    // gets its own clipped, equalized mapping, and per-pixel results are
    // bilinearly interpolated between the four surrounding tile mappings.
    // Far better than global equalization for shadows and low light,
    // and color-safe because chroma ratios are preserved.
    const tileW = Math.ceil(width / tiles);
    const tileH = Math.ceil(height / tiles);
    const nBins = 256;

    const luma = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        luma[p] = Math.round(0.2989 * data[i] + 0.5870 * data[i + 1] + 0.1140 * data[i + 2]);
    }

    const luts = [];
    for (let ty = 0; ty < tiles; ty++) {
        luts.push([]);
        for (let tx = 0; tx < tiles; tx++) {
            const x0 = tx * tileW, y0 = ty * tileH;
            const x1 = Math.min(width, x0 + tileW);
            const y1 = Math.min(height, y0 + tileH);

            const hist = new Uint32Array(nBins);
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    hist[luma[y * width + x]]++;
                }
            }

            const tilePixels = (x1 - x0) * (y1 - y0) || 1;
            const limit = Math.max(1, Math.round((clipLimit * tilePixels) / nBins));

            let excess = 0;
            for (let b = 0; b < nBins; b++) {
                if (hist[b] > limit) {
                    excess += hist[b] - limit;
                    hist[b] = limit;
                }
            }
            const bonus = excess / nBins;
            const lut = new Uint8Array(nBins);
            let cdf = 0;
            for (let b = 0; b < nBins; b++) {
                cdf += hist[b] + bonus;
                lut[b] = Math.min(255, Math.round((cdf / tilePixels) * 255));
            }
            luts[ty].push(lut);
        }
    }

    for (let y = 0; y < height; y++) {
        const gy = (y - tileH / 2) / tileH;
        const ty0 = Math.max(0, Math.min(tiles - 1, Math.floor(gy)));
        const ty1 = Math.min(tiles - 1, ty0 + 1);
        const fy = Math.max(0, Math.min(1, gy - ty0));

        for (let x = 0; x < width; x++) {
            const gx = (x - tileW / 2) / tileW;
            const tx0 = Math.max(0, Math.min(tiles - 1, Math.floor(gx)));
            const tx1 = Math.min(tiles - 1, tx0 + 1);
            const fx = Math.max(0, Math.min(1, gx - tx0));

            const p = y * width + x;
            const l = luma[p];
            const mapped =
                luts[ty0][tx0][l] * (1 - fx) * (1 - fy) +
                luts[ty0][tx1][l] * fx * (1 - fy) +
                luts[ty1][tx0][l] * (1 - fx) * fy +
                luts[ty1][tx1][l] * fx * fy;

            const ratio = Math.min(4, mapped / (l || 1));
            const i = p * 4;
            data[i] = Math.min(255, data[i] * ratio);
            data[i + 1] = Math.min(255, data[i + 1] * ratio);
            data[i + 2] = Math.min(255, data[i + 2] * ratio);
        }
    }
}

export function applyUnsharpMask(data, width, height, amount, radius = 2, threshold = 0) {
    // Gaussian-style unsharp mask: out = orig + amount * (orig - blurred),
    // applied only where the local difference exceeds the threshold.
    // The radius parameter (via the box-blur approximation of a Gaussian)
    // is what allows sharpening at different detail scales — something
    // the old fixed 3x3 kernel could not do.
    if (amount <= 0) return;
    const blurred = new Uint8ClampedArray(data);
    blurWorking(blurred, width, height, Math.max(1, Math.round(radius)));

    for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const diff = data[i + c] - blurred[i + c];
            if (Math.abs(diff) <= threshold) continue;
            data[i + c] = Math.min(255, Math.max(0, data[i + c] + diff * amount));
        }
    }
}

function blurWorking(data, width, height, radius) {
    // 3-pass box blur on a working buffer (approximates a Gaussian)
    const temp = new Uint8ClampedArray(data.length);
    for (let pass = 0; pass < 3; pass++) {
        temp.set(data);

        for (let y = 0; y < height; y++) {
            let r = 0, g = 0, b = 0, count = 0;
            for (let x = 0; x <= radius && x < width; x++) {
                const idx = (y * width + x) * 4;
                r += data[idx]; g += data[idx + 1]; b += data[idx + 2];
                count++;
            }
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                temp[idx] = r / count;
                temp[idx + 1] = g / count;
                temp[idx + 2] = b / count;

                const addX = x + radius + 1;
                if (addX < width) {
                    const ai = (y * width + addX) * 4;
                    r += data[ai]; g += data[ai + 1]; b += data[ai + 2];
                    count++;
                }
                const remX = x - radius;
                if (remX >= 0) {
                    const ri = (y * width + remX) * 4;
                    r -= data[ri]; g -= data[ri + 1]; b -= data[ri + 2];
                    count--;
                }
            }
        }

        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, count = 0;
            for (let y = 0; y <= radius && y < height; y++) {
                const idx = (y * width + x) * 4;
                r += temp[idx]; g += temp[idx + 1]; b += temp[idx + 2];
                count++;
            }
            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * 4;
                data[idx] = r / count;
                data[idx + 1] = g / count;
                data[idx + 2] = b / count;

                const addY = y + radius + 1;
                if (addY < height) {
                    const ai = (addY * width + x) * 4;
                    r += temp[ai]; g += temp[ai + 1]; b += temp[ai + 2];
                    count++;
                }
                const remY = y - radius;
                if (remY >= 0) {
                    const ri = (remY * width + x) * 4;
                    r -= temp[ri]; g -= temp[ri + 1]; b -= temp[ri + 2];
                    count--;
                }
            }
        }
    }
}

export function applyAutoWhiteBalance(data) {
    // Gray-world white balance: scales each channel so its mean matches
    // the overall mean. Common fix for color casts in outdoor and
    // mixed-lighting surveillance stills.
    let rSum = 0, gSum = 0, bSum = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        gSum += data[i + 1];
        bSum += data[i + 2];
    }
    const rMean = rSum / pixels || 1;
    const gMean = gSum / pixels || 1;
    const bMean = bSum / pixels || 1;
    const target = (rMean + gMean + bMean) / 3;

    const rScale = target / rMean;
    const gScale = target / gMean;
    const bScale = target / bMean;

    for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.min(255, data[i] * rScale);
        data[i + 1] = Math.min(255, data[i + 1] * gScale);
        data[i + 2] = Math.min(255, data[i + 2] * bScale);
    }
}

export function applyDehaze(data, width, height, strength = 0.85) {
    // Simplified dark channel prior dehaze. The dark channel (per-pixel
    // RGB minimum, smoothed) estimates haze density; atmospheric light
    // is sampled from the haziest pixels; the scene is then recovered as
    // J = (I - A) / t + A with transmission t derived from the dark channel.
    const n = width * height;
    const dark = new Uint8ClampedArray(n * 4);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 4) {
        const m = Math.min(data[i], data[i + 1], data[i + 2]);
        dark[p] = dark[p + 1] = dark[p + 2] = m;
        dark[p + 3] = 255;
    }
    blurWorking(dark, width, height, Math.max(3, Math.round(Math.min(width, height) / 100)));

    const hist = new Uint32Array(256);
    for (let p = 0; p < n; p++) hist[dark[p * 4]]++;
    const top = Math.max(1, Math.floor(n * 0.001));
    let threshold = 255, seen = 0;
    while (threshold > 0 && seen + hist[threshold] < top) {
        seen += hist[threshold];
        threshold--;
    }
    let aR = 0, aG = 0, aB = 0, count = 0;
    for (let p = 0; p < n && count < top; p++) {
        if (dark[p * 4] >= threshold) {
            const i = p * 4;
            aR += data[i]; aG += data[i + 1]; aB += data[i + 2];
            count++;
        }
    }
    aR /= count; aG /= count; aB /= count;
    const aMax = Math.max(aR, aG, aB, 1);

    for (let p = 0; p < n; p++) {
        const i = p * 4;
        const t = Math.max(0.1, 1 - strength * (dark[i] / aMax));
        data[i] = Math.min(255, Math.max(0, (data[i] - aR) / t + aR));
        data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] - aG) / t + aG));
        data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] - aB) / t + aB));
    }
}
