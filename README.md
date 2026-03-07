<div align="center">

<img src="lucid-logo.png" alt="Lucid" width="120" height="120" />

# Lucid

> Browser-based image enhancement, analysis, and forensics tool for investigators and analysts.

[![Status](https://img.shields.io/badge/status-active-success.svg)]()
[![In Project Eyrie](https://img.shields.io/badge/IN-PROJECT%20EYRIE-b45309?style=for-the-badge&labelColor=0f172a)](https://github.com/Project-Eyrie)
![WEB](https://img.shields.io/badge/TYPE-WEB-0369a1?style=for-the-badge&labelColor=0f172a)

</div>

---

## Overview

**Lucid** is a client-side image intelligence platform built for digital forensics investigators, OSINT analysts, and anyone who needs to examine images in detail. It provides professional-grade enhancement, annotation, metadata extraction, and reverse image search — all running entirely in the browser with no server-side processing.

---

## Features

- **Real-time Enhancement** — Brightness, contrast, saturation, gamma, color balance, interactive curves editor, and six auto-enhancement presets
- **Forensic Filters** — Edge detection, emboss, histogram equalization, grayscale, invert, and denoise
- **Annotation Tools** — Draw shapes, arrows, text labels, blur sensitive regions, and measure pixel distances
- **Metadata & OSINT** — EXIF extraction, SHA-256 hashing, GPS mapping, OCR text extraction, and reverse image search via Google Lens, Yandex, TinEye, and Bing

---

## How to Use

### About the App

Load an image via file upload, clipboard paste, or URL. The main canvas displays your image with real-time enhancements applied. Use the tabbed sidebar on the right to access enhancement controls, transform tools, magnifier settings, annotation tools, OSINT utilities, and metadata. All processing happens client-side — nothing is uploaded to any server.

### Interface

| Area | Description |
|------|-------------|
| **Header Bar** | File operations, view toggles, export controls, and image info |
| **Sidebar** | Tabbed control panel with Enhance, Transform, Magnify, Annotate, OSINT, and Metadata tabs |
| **Canvas** | Main image display with annotation and overlay layers |
| **Status Bar** | Cursor coordinates, pixel RGB values, and picked color display |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `A` | Toggle annotation visibility |
| `M` | Toggle magnifier |
| `P` | Activate color picker |
| `Space + Drag` | Pan when zoomed |
| `Ctrl+Z` | Undo last annotation or blur |
| `Ctrl+V` | Paste image from clipboard |
| `Scroll` | Zoom in/out |

> On macOS, substitute `Ctrl` with `Cmd`.

---

## Notes

- Requires a modern browser with ES6 module support (Chrome, Firefox, Safari, Edge)
- Minimum screen width of 1024px required for full functionality
- All image data is processed locally in the browser and never leaves your machine
- Supported formats: JPG, PNG, GIF, BMP, WebP, TIFF, HEIC/HEIF

---

<div align="center">
  Part of Project Eyrie — by <a href="https://notalex.sh">notalex.sh</a>
</div>
