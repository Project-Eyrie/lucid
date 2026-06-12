/*
 * Image Enhancements
 *
 * Provides real-time image adjustment functions for brightness,
 * contrast, saturation, gamma, color balance, and curves.
 * These non-destructive adjustments are applied in sequence to
 * modify the visual appearance of images while preserving the
 * original data.
 */

import { clamp } from './utils.js';
import { applyUnsharpMask } from './filters.js';

function applyBrightness(data, brightness) {
    // Shifts all pixel values lighter or darker
    const adj = brightness * 2.55;
    for (let i = 0; i < data.length; i += 4) {
        data[i] = clamp(data[i] + adj, 0, 255);
        data[i + 1] = clamp(data[i + 1] + adj, 0, 255);
        data[i + 2] = clamp(data[i + 2] + adj, 0, 255);
    }
}

function applyContrast(data, contrast) {
    // Adjusts difference between light and dark areas
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < data.length; i += 4) {
        data[i] = clamp(factor * (data[i] - 128) + 128, 0, 255);
        data[i + 1] = clamp(factor * (data[i + 1] - 128) + 128, 0, 255);
        data[i + 2] = clamp(factor * (data[i + 2] - 128) + 128, 0, 255);
    }
}

function applySaturation(data, saturation) {
    // Adjusts color intensity toward or away from grayscale
    const sat = 1 + saturation / 100;
    for (let i = 0; i < data.length; i += 4) {
        const gray = 0.2989 * data[i] + 0.5870 * data[i + 1] + 0.1140 * data[i + 2];
        data[i] = clamp(gray + sat * (data[i] - gray), 0, 255);
        data[i + 1] = clamp(gray + sat * (data[i + 1] - gray), 0, 255);
        data[i + 2] = clamp(gray + sat * (data[i + 2] - gray), 0, 255);
    }
}

function applyGamma(data, gamma) {
    // Applies gamma correction using a precomputed lookup table
    if (gamma === 1.0) return;
    const inv = 1.0 / gamma;
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        lut[i] = clamp(Math.round(255 * Math.pow(i / 255, inv)), 0, 255);
    }
    for (let i = 0; i < data.length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
    }
}

function applyColorBalance(data, rShift, gShift, bShift) {
    // Shifts individual RGB channels for color balance adjustment
    if (rShift === 0 && gShift === 0 && bShift === 0) return;
    for (let i = 0; i < data.length; i += 4) {
        data[i] = clamp(data[i] + rShift, 0, 255);
        data[i + 1] = clamp(data[i + 1] + gShift, 0, 255);
        data[i + 2] = clamp(data[i + 2] + bShift, 0, 255);
    }
}

function applyCurvesLUT(data, lut) {
    // Remaps pixel values through a curves lookup table
    if (!lut) return;
    for (let i = 0; i < data.length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
    }
}

export function processEnhancements(imageData, enhancements, width, height, curvesLUT) {
    // Applies all enabled enhancements in sequence
    const data = imageData.data;

    if (enhancements.brightness !== 0) {
        applyBrightness(data, enhancements.brightness);
    }

    if (enhancements.gamma !== 1.0) {
        applyGamma(data, enhancements.gamma);
    }

    if (enhancements.contrast !== 0) {
        applyContrast(data, enhancements.contrast);
    }

    if (enhancements.saturation !== 0) {
        applySaturation(data, enhancements.saturation);
    }

    if (enhancements.balanceR !== 0 || enhancements.balanceG !== 0 || enhancements.balanceB !== 0) {
        applyColorBalance(data, enhancements.balanceR, enhancements.balanceG, enhancements.balanceB);
    }

    if (curvesLUT) {
        applyCurvesLUT(data, curvesLUT);
    }

    if (enhancements.sharpen > 0) {
        applyUnsharpMask(
            data, width, height,
            enhancements.sharpen / 100 * 2,
            enhancements.sharpenRadius ?? 2,
            enhancements.sharpenThreshold ?? 0
        );
    }
}
