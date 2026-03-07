/*
 * Utility Functions
 *
 * Provides common helper functions used throughout the application
 * including value clamping, coordinate conversion, color formatting,
 * and rate limiting utilities for event handling.
 */

function clamp(val, min, max) {
    // Constrains a value between minimum and maximum bounds
    return Math.min(max, Math.max(min, val));
}

function getCanvasCoordinates(canvas, e) {
    // Converts mouse event coordinates to canvas pixel coordinates
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

function rgbToHex(r, g, b) {
    // Converts RGB values to uppercase hex color string
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

function debounce(fn, delay) {
    // Delays function execution until after wait period of inactivity
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
}

function throttle(fn, limit) {
    // Limits function execution to once per specified time period
    let inThrottle = false;
    return (...args) => {
        if (!inThrottle) {
            fn(...args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

export { clamp, getCanvasCoordinates, rgbToHex, debounce, throttle };
