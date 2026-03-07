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
        const ratio = newVal / (gray || 1);
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
