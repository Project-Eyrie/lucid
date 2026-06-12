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

function escapeHtml(value) {
    // Escapes HTML special characters; metadata values are attacker-
    // controllable (crafted EXIF tags) and must never reach innerHTML raw
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info', duration = 3000) {
    // Shows a non-blocking toast notification (replaces alert())
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
        toast.classList.remove('visible');
        toast.addEventListener('transitionend', () => toast.remove());
        setTimeout(() => toast.remove(), 500);
    }, duration);
}

const PREFS_KEY = 'lucid.prefs';

function loadPrefs() {
    // Loads persisted UI preferences from localStorage
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
        return {};
    }
}

function savePrefs(partial) {
    // Merges and persists UI preferences to localStorage
    try {
        const prefs = { ...loadPrefs(), ...partial };
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
}

export { clamp, getCanvasCoordinates, rgbToHex, debounce, throttle, escapeHtml, showToast, loadPrefs, savePrefs };
