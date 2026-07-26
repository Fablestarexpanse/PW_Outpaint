// PW Outpaint - interactive outpaint framing widget.
// Pairs with pw_outpaint.py (node class "PWOutpaint").
//
// Portions of the frame-interaction geometry are adapted from
// ComfyUI_RaykoStudio (https://github.com/Raykosan/ComfyUI_RaykoStudio),
// Copyright 2025-2026 Raykosan (RaykoStudio), Apache License 2.0.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "PWOutpaint";
const CANVAS_H = 320;
const CTRL_H = 250;
const MARGIN = 22;
const OVERHANG = 1; // crop box must overlap the source by at least this many px
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 5.0;

const ASPECT_CHIPS = [
    ["16:9", 16 / 9], ["9:16", 9 / 16], ["21:9", 21 / 9], ["9:21", 9 / 21],
    ["4:3", 4 / 3], ["3:4", 3 / 4], ["1:1", 1], ["3:2", 3 / 2], ["2:3", 2 / 3],
];
const SNAP_MODES = [
    ["center", "Center"], ["top", "Top"], ["bottom", "Bottom"],
    ["left", "Left"], ["right", "Right"], ["fitW", "Fit W"], ["fitH", "Fit H"],
];

// ---------------------------------------------------------------------------
// design tokens (soft flat surfaces, theme-friendly)
// ---------------------------------------------------------------------------

const T = {
    surface: "rgba(0,0,0,0.35)",
    surfaceBorder: "1px solid rgba(255,255,255,0.08)",
    panel: "#1c1c1c",
    btn: "#2b2b2b",
    btnHover: "#343434",
    btnActive: "#444444",
    border: "#3f3f3f",
    text: "#cccccc",
    textBright: "#ffffff",
    textDim: "rgba(255,255,255,0.55)",
    textFaint: "rgba(255,255,255,0.35)",
    okBg: "rgba(80,200,120,0.12)",
    okBorder: "rgba(80,200,120,0.45)",
    okText: "#9fe6b8",
    dangerBg: "rgba(230,90,90,0.12)",
    dangerBorder: "rgba(230,90,90,0.45)",
    dangerText: "#f2a6a6",
};

function styleSoftButton(btn, active = false) {
    btn.classList.add("comfy-btn");
    btn.style.border = `1px solid ${active ? "rgba(255,255,255,0.35)" : T.border}`;
    btn.style.background = active ? T.btnActive : T.btn;
    btn.style.color = active ? T.textBright : T.text;
    btn.style.borderRadius = "4px";
    btn.style.padding = "4px 8px";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "11px";
    btn.style.lineHeight = "1.2";
    btn._active = active;
}

function styleSoftField(field) {
    field.classList.add("comfy-input");
    field.style.borderRadius = "4px";
    field.style.border = `1px solid ${T.border}`;
    field.style.background = T.panel;
    field.style.color = T.textBright;
    field.style.padding = "4px 6px";
    field.style.boxSizing = "border-box";
    field.style.fontSize = "11px";
}

let queueWasRunning = false;
let batchResetTimer = null;
let liveNodes = [];

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const crToSrc = (cr, sf, scale) => ({ x: (cr.x - sf.x) / scale, y: (cr.y - sf.y) / scale, w: cr.w / scale, h: cr.h / scale });
const srcToCr = (s, sf, scale) => ({ x: sf.x + s.x * scale, y: sf.y + s.y * scale, w: s.w * scale, h: s.h * scale });

function quantize(s, grid) {
    return {
        x: Math.round(s.x / grid) * grid,
        y: Math.round(s.y / grid) * grid,
        w: Math.max(grid, Math.round(s.w / grid) * grid),
        h: Math.max(grid, Math.round(s.h / grid) * grid),
    };
}

function clampToValid(s, srcW, srcH) {
    const c = { ...s };
    if (c.x >= srcW - OVERHANG) c.x = srcW - OVERHANG;
    if (c.y >= srcH - OVERHANG) c.y = srcH - OVERHANG;
    if (c.x + c.w <= OVERHANG) c.x = OVERHANG - c.w;
    if (c.y + c.h <= OVERHANG) c.y = OVERHANG - c.h;
    return c;
}

function applyCanvasRect(canvasCr, st) {
    let s = crToSrc(canvasCr, st.sf, st.scale);
    s = quantize(s, st.grid);
    s = clampToValid(s, st.srcW, st.srcH);
    st.cr = srcToCr(s, st.sf, st.scale);
}

function toWorld(e, wrapEl, view) {
    const rect = wrapEl.getBoundingClientRect();
    return { x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom };
}

function sizeForRatio(srcW, srcH, targetAR, grid) {
    let w, h;
    const tryH = srcW / targetAR;
    if (tryH >= srcH) { w = srcW; h = tryH; } else { h = srcH; w = srcH * targetAR; }
    return {
        w: Math.max(grid, Math.ceil(w / grid) * grid),
        h: Math.max(grid, Math.ceil(h / grid) * grid),
    };
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

function createState() {
    return {
        srcW: 1280, srcH: 720,
        scale: 1,
        sf: { x: 0, y: 0, w: 0, h: 0 },
        cr: { x: 0, y: 0, w: 0, h: 0 },
        cropAR: 16 / 9,
        arLocked: false,
        initialized: false,
        view: { zoom: 1.0, panX: 0, panY: 0 },
        grid: 16,
        maskColor: "#ff0000",
        bgColor: "#141414",
        fillColor: "#808080",
        batchMode: false,
        hasPreset: false,
    };
}

function initLayout(st, wrapEl) {
    const W = wrapEl.clientWidth;
    if (W <= 0) return false;
    const maxW = W - MARGIN * 2;
    const maxH = wrapEl.clientHeight - MARGIN * 2;
    const ar = st.srcW / st.srcH;
    let sfW, sfH;
    if (maxW / ar <= maxH) { sfW = maxW; sfH = Math.round(maxW / ar); }
    else { sfH = maxH; sfW = Math.round(maxH * ar); }
    st.sf = {
        x: Math.round((W - sfW) / 2),
        y: Math.max(MARGIN, Math.round((wrapEl.clientHeight - sfH) / 2)),
        w: sfW, h: sfH,
    };
    st.scale = sfW / st.srcW;
    st.view = { zoom: 1.0, panX: 0, panY: 0 };
    const def = clampToValid({ x: 0, y: 0, w: st.srcW, h: st.srcH }, st.srcW, st.srcH);
    st.cr = srcToCr(def, st.sf, st.scale);
    st.cropAR = st.srcW / st.srcH;
    st.arLocked = false;
    st.initialized = true;
    return true;
}

function stateJSON(st) {
    const s = quantize(crToSrc(st.cr, st.sf, st.scale), st.grid);
    return JSON.stringify({
        v: 1, x: s.x, y: s.y, w: s.w, h: s.h,
        maskColor: st.maskColor, bgColor: st.bgColor, fillColor: st.fillColor,
    });
}

function syncWidgets(st, widgets, node) {
    if (widgets.cropState) widgets.cropState.value = stateJSON(st);
    if (node?.graph) node.graph.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function mkEl(tag, css, extra) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (extra) Object.assign(el, extra);
    return el;
}

function mkSoftBtn(label, opts = {}) {
    const b = mkEl("button", "", { textContent: label, type: "button" });
    styleSoftButton(b, false);
    if (opts.title) b.title = opts.title;
    if (opts.flex) b.style.flex = opts.flex;
    b.onmouseenter = () => { if (!b._active) b.style.background = T.btnHover; };
    b.onmouseleave = () => { b.style.background = b._active ? T.btnActive : T.btn; };
    return b;
}

// Unified swatch: color block + hex label in one rounded control (click to pick).
function mkColorSwatch(label, defaultColor, title) {
    const row = mkEl("div", `display:flex;align-items:center;gap:5px;font-size:10px;color:${T.textDim};`);
    if (title) row.title = title;
    const lbl = mkEl("span", "min-width:26px;text-align:right;", { textContent: label });
    const host = mkEl("div", `display:inline-flex;align-items:stretch;border-radius:4px;border:1px solid ${T.border};overflow:hidden;cursor:pointer;height:24px;box-sizing:border-box;`);
    const block = mkEl("div", `flex:0 0 20px;background:${defaultColor};border-right:1px solid ${T.border};`);
    const hexLabel = mkEl("div", `display:flex;align-items:center;justify-content:center;padding:0 6px;font-size:10px;color:#aaaaaa;background:${T.panel};letter-spacing:0.5px;font-family:monospace;user-select:none;`, { textContent: defaultColor.toUpperCase() });
    const picker = mkEl("input", "position:absolute;opacity:0;width:0;height:0;pointer-events:none;", { type: "color", value: defaultColor });
    host.append(block, hexLabel, picker);
    host.addEventListener("click", () => picker.click());
    row.append(lbl, host);
    return { row, host, block, hexLabel, picker };
}

function syncColorSwatch(input, value) {
    input.picker.value = value;
    input.block.style.background = value;
    input.hexLabel.textContent = value.toUpperCase();
}

function buildUI() {
    const root = mkEl("div", `width:100%;box-sizing:border-box;padding:6px;font-family:system-ui,sans-serif;font-size:12px;color:${T.text};position:relative;`);

    // --- canvas area ---
    const wrap = mkEl("div", `position:relative;min-height:${CANVAS_H}px;background:${T.surface};border:${T.surfaceBorder};border-radius:8px;overflow:hidden;user-select:none;touch-action:none;cursor:default;`);
    const sfEl = mkEl("div", "position:absolute;background:rgba(0,0,0,0.4);overflow:hidden;border:1px solid rgba(255,255,255,0.06);");
    const imageEl = mkEl("img", "position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:none;");
    imageEl.alt = "";
    const srcLabel = mkEl("div", `position:absolute;bottom:5px;right:7px;font-size:9px;color:${T.textFaint};font-family:monospace;pointer-events:none;`);
    srcLabel.textContent = "source";
    const noDataMsg = mkEl("div", `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:${T.textFaint};pointer-events:none;text-align:center;padding:8px;`);
    noDataMsg.textContent = "Run the workflow to load the image";
    const waitingMsg = mkEl("div", "position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:12px;color:rgba(255,255,255,0.85);pointer-events:none;text-align:center;padding:8px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,0.8);");
    waitingMsg.textContent = "Adjust the frame, then press Accept";
    sfEl.append(imageEl, srcLabel, noDataMsg, waitingMsg);

    const mkShade = () => mkEl("div", "position:absolute;pointer-events:none;display:none;");
    const shades = { top: mkShade(), bottom: mkShade(), left: mkShade(), right: mkShade() };

    const cropBox = mkEl("div", "position:absolute;cursor:move;border:1.5px solid rgba(255,255,255,0.92);background:rgba(255,255,255,0.04);box-shadow:0 0 0 1px rgba(0,0,0,0.35);will-change:left,top,width,height;display:none;");
    const HANDLE = "position:absolute;width:10px;height:10px;background:#ffffff;border:1px solid rgba(0,0,0,0.55);border-radius:2px;box-shadow:0 1px 3px rgba(0,0,0,0.4);";
    const corners = {
        tl: mkEl("div", HANDLE + "top:0;left:0;transform:translate(-50%,-50%);cursor:nw-resize;"),
        tr: mkEl("div", HANDLE + "top:0;right:0;transform:translate(50%,-50%);cursor:ne-resize;"),
        bl: mkEl("div", HANDLE + "bottom:0;left:0;transform:translate(-50%,50%);cursor:sw-resize;"),
        br: mkEl("div", HANDLE + "bottom:0;right:0;transform:translate(50%,50%);cursor:se-resize;"),
    };
    const EDGE = "position:absolute;background:#ffffff;border:1px solid rgba(0,0,0,0.55);border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,0.4);pointer-events:auto;";
    const edges = {
        t: mkEl("div", EDGE + "width:16px;height:6px;top:0;left:50%;transform:translate(-50%,-50%);cursor:n-resize;"),
        b: mkEl("div", EDGE + "width:16px;height:6px;bottom:0;left:50%;transform:translate(-50%,50%);cursor:s-resize;"),
        l: mkEl("div", EDGE + "width:6px;height:16px;left:0;top:50%;transform:translate(-50%,-50%);cursor:w-resize;"),
        r: mkEl("div", EDGE + "width:6px;height:16px;right:0;top:50%;transform:translate(50%,-50%);cursor:e-resize;"),
    };
    for (const [dir, el] of Object.entries({ ...corners, ...edges })) {
        el.dataset.dir = dir;
        cropBox.appendChild(el);
    }

    const sizeLabel = mkEl("div", "position:absolute;font-family:monospace;font-size:11px;font-weight:600;color:rgba(255,255,255,0.9);background:rgba(0,0,0,0.55);padding:2px 9px;border-radius:999px;pointer-events:none;white-space:nowrap;transform:translateX(-50%);");
    const PAD_CSS = "position:absolute;font-family:monospace;font-size:10px;pointer-events:none;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.8);";
    const padLabels = { t: mkEl("div", PAD_CSS), b: mkEl("div", PAD_CSS), l: mkEl("div", PAD_CSS), r: mkEl("div", PAD_CSS) };

    const viewport = mkEl("div", "position:absolute;inset:0;transform-origin:0 0;");
    viewport.append(sfEl, shades.top, shades.bottom, shades.left, shades.right, cropBox, sizeLabel, padLabels.t, padLabels.b, padLabels.l, padLabels.r);
    wrap.appendChild(viewport);

    const zoomBtn = mkEl("button", `position:absolute;bottom:6px;left:7px;padding:2px 9px;font-size:10px;font-family:monospace;background:rgba(0,0,0,0.55);color:${T.textDim};border:1px solid rgba(255,255,255,0.12);border-radius:999px;cursor:pointer;z-index:10;`);
    zoomBtn.title = "Click to reset view (scroll = zoom, middle-drag = pan)";
    zoomBtn.textContent = "100%";
    wrap.appendChild(zoomBtn);

    // --- controls ---
    const ctrl = mkEl("div", "display:flex;flex-direction:column;gap:5px;margin-top:7px;");

    const presetRow = mkEl("div", "display:flex;align-items:center;gap:6px;justify-content:center;width:100%;position:relative;");
    const savePresetBtn = mkSoftBtn("Save preset", { title: "Save current frame as a named preset", flex: "1" });
    const loadPresetBtn = mkSoftBtn("Load preset", { title: "Load a saved preset", flex: "1" });
    presetRow.append(savePresetBtn, loadPresetBtn);

    const presetListOverlay = mkEl("div", `position:absolute;display:none;top:50%;left:50%;transform:translate(-50%,-50%);flex-direction:column;max-height:200px;overflow-y:auto;background:${T.panel};border:1px solid ${T.border};border-radius:8px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.6);min-width:190px;padding:5px;`);
    const presetNamePanel = mkEl("div", `position:absolute;display:none;top:50%;left:50%;transform:translate(-50%,-50%);background:${T.panel};padding:10px;border:1px solid ${T.border};border-radius:8px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.6);width:220px;text-align:center;`);
    const nameField = mkEl("input", "width:100%;margin-bottom:6px;", { placeholder: "Preset name..." });
    styleSoftField(nameField);
    nameField.style.background = "#111111";
    const nameBtns = mkEl("div", "display:flex;gap:5px;");
    const nameOk = mkSoftBtn("Save", { flex: "1" });
    const nameCancel = mkSoftBtn("Cancel", { flex: "1" });
    nameBtns.append(nameOk, nameCancel);
    presetNamePanel.append(nameField, nameBtns);
    root.append(presetListOverlay, presetNamePanel);

    const sizeRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    const mkDimInput = () => {
        const el = mkEl("input", "", { type: "number", min: 8, step: 8, value: "" });
        styleSoftField(el);
        el.style.width = "58px";
        el.style.fontFamily = "monospace";
        el.style.textAlign = "right";
        el.style.padding = "2px 5px";
        return el;
    };
    const wLabel = mkEl("span", `font-size:10px;color:${T.textDim};`, { textContent: "W" });
    const wInput = mkDimInput();
    const hLabel = mkEl("span", `font-size:10px;color:${T.textDim};`, { textContent: "H" });
    const hInput = mkDimInput();
    const arBtn = mkSoftBtn("AR free", { title: "Toggle aspect-ratio lock" });
    const resetBtn = mkSoftBtn("Reset");
    sizeRow.append(wLabel, wInput, hLabel, hInput, arBtn, resetBtn);

    const chipRow = mkEl("div", "display:flex;gap:4px;overflow-x:auto;padding-bottom:2px;flex-wrap:nowrap;");
    const chipBtns = ASPECT_CHIPS.map(([label, ratio]) => {
        const btn = mkSoftBtn(label);
        btn.style.borderRadius = "999px";
        btn.style.padding = "2px 9px";
        btn.style.fontSize = "10px";
        btn.style.fontFamily = "monospace";
        btn.style.flexShrink = "0";
        btn.dataset.ratio = ratio;
        chipRow.appendChild(btn);
        return btn;
    });

    const snapRow = mkEl("div", "display:flex;align-items:center;gap:0;");
    const snapLabel = mkEl("span", `font-size:10px;color:${T.textDim};margin-right:5px;`, { textContent: "Snap" });
    const snapBtns = SNAP_MODES.map(([key, label], i) => {
        const first = i === 0, last = i === SNAP_MODES.length - 1;
        const b = mkSoftBtn(label);
        b.style.borderRadius = first ? "4px 0 0 4px" : (last ? "0 4px 4px 0" : "0");
        if (!first) b.style.borderLeft = "none";
        b.style.padding = "2px 7px";
        b.style.fontSize = "10px";
        b.style.whiteSpace = "nowrap";
        b.dataset.snap = key;
        return b;
    });
    snapRow.append(snapLabel, ...snapBtns);

    const maskColorInput = mkColorSwatch("mask", "#ff0000", "Mask overlay color (also used in mask_image output)");
    const bgColorInput = mkColorSwatch("bg", "#141414", "Background color of the mask_image output");
    const fillColorInput = mkColorSwatch("fill", "#808080", "Fill color when fill_mode is solid_color");
    const colorRow = mkEl("div", "display:flex;align-items:center;gap:10px;flex-wrap:wrap;");
    colorRow.append(maskColorInput.row, bgColorInput.row, fillColorInput.row);

    const mkActionBtn = (label, tone) => {
        const b = mkEl("button", "padding:6px 12px;font-size:11px;font-weight:600;border-radius:4px;cursor:pointer;width:100%;text-align:center;display:none;letter-spacing:0.3px;", { textContent: label, type: "button" });
        if (tone === "ok") {
            b.style.border = `1px solid ${T.okBorder}`;
            b.style.background = T.okBg;
            b.style.color = T.okText;
        } else if (tone === "danger") {
            b.style.border = `1px solid ${T.dangerBorder}`;
            b.style.background = T.dangerBg;
            b.style.color = T.dangerText;
        } else {
            b.style.border = `1px solid ${T.border}`;
            b.style.background = T.btn;
            b.style.color = T.text;
        }
        return b;
    };
    const batchBtn = mkActionBtn("Batch off", "neutral");
    batchBtn.title = "Reuse this frame automatically on the rest of the queue";
    batchBtn.style.marginTop = "2px";
    batchBtn.dataset.active = "false";
    const acceptBtn = mkActionBtn("Accept", "ok");
    const cancelBtn = mkActionBtn("Cancel", "danger");

    ctrl.append(presetRow, sizeRow, chipRow, snapRow, colorRow, batchBtn, acceptBtn, cancelBtn);
    root.append(wrap, ctrl);

    return {
        root, wrap, viewport, zoomBtn, sfEl, imageEl, srcLabel, noDataMsg, waitingMsg,
        shades, cropBox, sizeLabel, padLabels, edges,
        savePresetBtn, loadPresetBtn, presetListOverlay, presetNamePanel, nameField, nameOk, nameCancel,
        wInput, hInput, arBtn, resetBtn, chipBtns, snapBtns,
        maskColorInput, bgColorInput, fillColorInput,
        batchBtn, acceptBtn, cancelBtn,
    };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function updateShadeColors(st, dom) {
    const color = st.maskColor + "40";
    for (const el of Object.values(dom.shades)) el.style.backgroundColor = color;
    for (const el of Object.values(dom.padLabels)) el.style.color = st.maskColor;
}

function render(st, dom) {
    if (!st.initialized) return;
    const { sf, cr, srcW, srcH, view } = st;
    dom.viewport.style.transform = `translate(${view.panX}px,${view.panY}px) scale(${view.zoom})`;
    dom.zoomBtn.textContent = Math.round(view.zoom * 100) + "%";
    Object.assign(dom.sfEl.style, { left: sf.x + "px", top: sf.y + "px", width: sf.w + "px", height: sf.h + "px" });
    dom.srcLabel.textContent = `${srcW} x ${srcH}`;
    dom.cropBox.style.display = "block";
    Object.assign(dom.cropBox.style, { left: cr.x + "px", top: cr.y + "px", width: cr.w + "px", height: cr.h + "px" });

    // shade the parts of the crop box that fall outside the source image
    const ix1 = Math.max(cr.x, sf.x), iy1 = Math.max(cr.y, sf.y);
    const ix2 = Math.min(cr.x + cr.w, sf.x + sf.w), iy2 = Math.min(cr.y + cr.h, sf.y + sf.h);
    const setShade = (el, x, y, w, h) => {
        if (w > 0 && h > 0) {
            el.style.display = "block";
            Object.assign(el.style, { position: "absolute", pointerEvents: "none", left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
        } else el.style.display = "none";
    };
    setShade(dom.shades.top, cr.x, cr.y, cr.w, Math.max(0, iy1 - cr.y));
    setShade(dom.shades.bottom, cr.x, iy2, cr.w, Math.max(0, cr.y + cr.h - iy2));
    setShade(dom.shades.left, cr.x, iy1, Math.max(0, ix1 - cr.x), iy2 - iy1);
    setShade(dom.shades.right, ix2, iy1, Math.max(0, cr.x + cr.w - ix2), iy2 - iy1);

    const s = crToSrc(cr, sf, st.scale);
    const outW = Math.round(s.w), outH = Math.round(s.h);
    dom.sizeLabel.textContent = `${outW} x ${outH}`;
    dom.sizeLabel.style.display = "block";
    dom.sizeLabel.style.left = (cr.x + cr.w / 2) + "px";
    dom.sizeLabel.style.top = (cr.y + cr.h - 22) + "px";

    const padT = Math.max(0, -s.y), padB = Math.max(0, s.y + s.h - srcH);
    const padL = Math.max(0, -s.x), padR = Math.max(0, s.x + s.w - srcW);
    const showPad = (el, text, show, cx, cy) => {
        el.textContent = text;
        el.style.display = show ? "block" : "none";
        if (show) { el.style.left = cx + "px"; el.style.top = cy + "px"; el.style.transform = "translate(-50%,-50%)"; }
    };
    showPad(dom.padLabels.t, `+${Math.round(padT)}`, padT > 0.5, cr.x + cr.w / 2, cr.y + (padT * st.scale) / 2);
    showPad(dom.padLabels.b, `+${Math.round(padB)}`, padB > 0.5, cr.x + cr.w / 2, cr.y + cr.h - (padB * st.scale) / 2);
    showPad(dom.padLabels.l, `+${Math.round(padL)}`, padL > 0.5, cr.x + (padL * st.scale) / 2, cr.y + cr.h / 2);
    showPad(dom.padLabels.r, `+${Math.round(padR)}`, padR > 0.5, cr.x + cr.w - (padR * st.scale) / 2, cr.y + cr.h / 2);

    if (document.activeElement !== dom.wInput) dom.wInput.value = outW || "";
    if (document.activeElement !== dom.hInput) dom.hInput.value = outH || "";

    const actualAR = st.arLocked ? st.cropAR : s.w / s.h;
    for (const btn of dom.chipBtns) {
        const active = Math.abs(parseFloat(btn.dataset.ratio) - actualAR) < 0.005;
        btn.style.border = `1px solid ${active ? "rgba(255,255,255,0.35)" : T.border}`;
        btn.style.color = active ? T.textBright : T.text;
        btn.style.background = active ? T.btnActive : T.btn;
        btn._active = active;
    }
    syncColorSwatch(dom.maskColorInput, st.maskColor);
    syncColorSwatch(dom.bgColorInput, st.bgColor);
    syncColorSwatch(dom.fillColorInput, st.fillColor);
    updateShadeColors(st, dom);
}

function fitCropInView(st, dom) {
    const wrapW = dom.wrap.clientWidth, wrapH = dom.wrap.clientHeight;
    if (wrapW <= 0 || wrapH <= 0) return;
    const bx1 = Math.min(st.sf.x, st.cr.x), by1 = Math.min(st.sf.y, st.cr.y);
    const bx2 = Math.max(st.sf.x + st.sf.w, st.cr.x + st.cr.w), by2 = Math.max(st.sf.y + st.sf.h, st.cr.y + st.cr.h);
    const bw = bx2 - bx1, bh = by2 - by1;
    const fitZoom = Math.min((wrapW - MARGIN * 2) / bw, (wrapH - MARGIN * 2) / bh);
    const needsZoomOut = fitZoom < st.view.zoom;
    const z = needsZoomOut ? Math.max(ZOOM_MIN, fitZoom) : st.view.zoom;
    const scL = bx1 * z + st.view.panX, scT = by1 * z + st.view.panY;
    const scR = bx2 * z + st.view.panX, scB = by2 * z + st.view.panY;
    const outOfBounds = scL < 0 || scT < 0 || scR > wrapW || scB > wrapH;
    if (!needsZoomOut && !outOfBounds) return;
    st.view.zoom = z;
    st.view.panX = (wrapW - bw * z) / 2 - bx1 * z;
    st.view.panY = (wrapH - bh * z) / 2 - by1 * z;
}

function setArLocked(st, dom, locked) {
    st.arLocked = locked;
    if (locked && st.cr.h > 0) st.cropAR = st.cr.w / st.cr.h;
    dom.arBtn.textContent = locked ? "AR locked" : "AR free";
    styleSoftButton(dom.arBtn, locked);
    dom.arBtn.style.padding = "4px 8px";
}

function setBatchVisual(st, dom, on) {
    st.batchMode = on;
    dom.batchBtn.dataset.active = on ? "true" : "false";
    dom.batchBtn.textContent = on ? "Batch on" : "Batch off";
    dom.batchBtn.style.border = `1px solid ${on ? T.okBorder : T.border}`;
    dom.batchBtn.style.background = on ? T.okBg : T.btn;
    dom.batchBtn.style.color = on ? T.okText : T.text;
}

function setUIActive(dom, active) {
    const opacity = active ? "1" : "0.45";
    const pointerEvents = active ? "auto" : "none";
    const targets = [
        dom.savePresetBtn, dom.loadPresetBtn, ...dom.chipBtns, ...dom.snapBtns,
        dom.arBtn, dom.resetBtn, dom.wInput, dom.hInput, dom.batchBtn,
        dom.maskColorInput.host, dom.bgColorInput.host, dom.fillColorInput.host,
    ];
    for (const el of targets) {
        el.style.opacity = opacity;
        el.style.pointerEvents = pointerEvents;
    }
}

function flashMessage(dom, text, ms = 2000) {
    dom.noDataMsg.textContent = text;
    dom.noDataMsg.style.display = "flex";
    setTimeout(() => { dom.noDataMsg.style.display = "none"; }, ms);
}

function resetNodeState(st, dom, widgets) {
    const keep = { maskColor: st.maskColor, bgColor: st.bgColor, fillColor: st.fillColor, grid: st.grid };
    Object.assign(st, createState(), keep);
    setArLocked(st, dom, false);
    dom.wInput.value = "";
    dom.hInput.value = "";
    syncColorSwatch(dom.maskColorInput, st.maskColor);
    syncColorSwatch(dom.bgColorInput, st.bgColor);
    syncColorSwatch(dom.fillColorInput, st.fillColor);
    dom.waitingMsg.style.display = "none";
    dom.acceptBtn.style.display = "none";
    dom.acceptBtn.textContent = "Accept";
    dom.acceptBtn.disabled = false;
    dom.cancelBtn.style.display = "none";
    dom.batchBtn.style.display = "none";
    setBatchVisual(st, dom, false);
    dom.presetNamePanel.style.display = "none";
    dom.presetListOverlay.style.display = "none";
    dom.noDataMsg.style.display = "none";
    if (dom.imageEl.src?.startsWith("blob:")) URL.revokeObjectURL(dom.imageEl.src);
    dom.imageEl.style.display = "none";
    updateShadeColors(st, dom);
    syncWidgets(st, widgets, null);
    setUIActive(dom, false);
}

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

async function postJSON(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function setCropFromSrcRect(st, dom, widgets, node, s) {
    s = clampToValid(quantize(s, st.grid), st.srcW, st.srcH);
    st.cr = srcToCr(s, st.sf, st.scale);
    if (!st.arLocked) st.cropAR = s.w / s.h;
    fitCropInView(st, dom);
    render(st, dom);
    syncWidgets(st, widgets, node);
}

function wireColors(st, dom, widgets, node) {
    const bind = (input, key) => {
        input.picker.addEventListener("input", (e) => {
            st[key] = e.target.value;
            syncColorSwatch(input, st[key]);
            updateShadeColors(st, dom);
            syncWidgets(st, widgets, node);
        });
    };
    bind(dom.maskColorInput, "maskColor");
    bind(dom.bgColorInput, "bgColor");
    bind(dom.fillColorInput, "fillColor");
}

function wirePresets(st, dom, widgets, node) {
    dom.savePresetBtn.addEventListener("click", () => {
        dom.presetListOverlay.style.display = "none";
        dom.presetNamePanel.style.display = "block";
        dom.nameField.value = "";
        dom.nameField.focus();
    });

    const performSave = async () => {
        const name = dom.nameField.value.trim();
        if (!name) return;
        const preset = {
            crop_state: stateJSON(st),
            cropAR: st.cropAR,
            arLocked: st.arLocked,
        };
        try {
            const r = await postJSON("/pw_outpaint/save_preset", { name, preset_data: preset });
            dom.presetNamePanel.style.display = "none";
            flashMessage(dom, r.ok ? `Preset "${name}" saved` : "Save failed");
        } catch (e) {
            flashMessage(dom, "Error: " + e.message);
        }
    };
    dom.nameOk.addEventListener("click", performSave);
    dom.nameCancel.addEventListener("click", () => { dom.presetNamePanel.style.display = "none"; });
    dom.nameField.addEventListener("keydown", (e) => {
        if (e.key === "Enter") performSave();
        if (e.key === "Escape") dom.presetNamePanel.style.display = "none";
    });

    const applyPreset = async (name) => {
        dom.presetListOverlay.style.display = "none";
        if (st.srcW < 32 || st.srcH < 32) { flashMessage(dom, "Wait for the image to load first"); return; }
        try {
            const res = await postJSON("/pw_outpaint/load_preset", { name });
            if (!res.ok) throw new Error("Load failed");
            const data = await res.json();
            st.cropAR = data.cropAR || 16 / 9;
            setArLocked(st, dom, data.arLocked ?? true);
            if (data.crop_state) {
                try {
                    const p = JSON.parse(data.crop_state);
                    if (p.maskColor) st.maskColor = p.maskColor;
                    if (p.bgColor) st.bgColor = p.bgColor;
                    if (p.fillColor) st.fillColor = p.fillColor;
                    if (Number.isFinite(p.w) && p.w > 0) {
                        setCropFromSrcRect(st, dom, widgets, node, { x: p.x, y: p.y, w: p.w, h: p.h });
                    }
                } catch { /* ignore malformed preset */ }
            }
            updateShadeColors(st, dom);
            render(st, dom);
            syncWidgets(st, widgets, node);
        } catch (e) {
            flashMessage(dom, "Error: " + e.message);
        }
    };

    dom.loadPresetBtn.addEventListener("click", async () => {
        dom.presetNamePanel.style.display = "none";
        if (dom.presetListOverlay.style.display === "flex") { dom.presetListOverlay.style.display = "none"; return; }
        dom.presetListOverlay.innerHTML = `<div style='padding:8px;color:${T.textDim};text-align:center;'>Loading...</div>`;
        dom.presetListOverlay.style.display = "flex";
        try {
            const res = await postJSON("/pw_outpaint/list_presets", {});
            const list = await res.json();
            dom.presetListOverlay.innerHTML = "";
            if (!list.length) { dom.presetListOverlay.textContent = "No presets found"; return; }
            for (const name of list) {
                const row = mkEl("div", "display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);");
                const nameSpan = mkEl("span", `flex:1;cursor:pointer;color:${T.text};font-size:12px;border-radius:3px;padding:1px 4px;`, { textContent: name });
                nameSpan.onmouseenter = () => nameSpan.style.background = T.btnHover;
                nameSpan.onmouseleave = () => nameSpan.style.background = "transparent";
                nameSpan.onclick = () => applyPreset(name);
                const delBtn = mkEl("span", `cursor:pointer;margin-left:8px;font-size:12px;opacity:0.6;color:${T.dangerText};`, { textContent: "✕", title: "Delete preset" });
                delBtn.onmouseenter = () => delBtn.style.opacity = "1";
                delBtn.onmouseleave = () => delBtn.style.opacity = "0.6";
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    try {
                        const r = await postJSON("/pw_outpaint/delete_preset", { name });
                        if (r.ok) { dom.loadPresetBtn.click(); flashMessage(dom, `Preset "${name}" deleted`); }
                        else flashMessage(dom, "Delete failed");
                    } catch (err) { flashMessage(dom, "Error: " + err.message); }
                };
                row.append(nameSpan, delBtn);
                dom.presetListOverlay.appendChild(row);
            }
        } catch {
            dom.presetListOverlay.textContent = "Error loading";
        }
    });

    document.addEventListener("click", (e) => {
        if (!dom.presetListOverlay?.contains(e.target) && !dom.loadPresetBtn?.contains(e.target)) dom.presetListOverlay.style.display = "none";
        if (!dom.presetNamePanel?.contains(e.target) && e.target !== dom.savePresetBtn) dom.presetNamePanel.style.display = "none";
    });
}

function wireControls(st, dom, widgets, node) {
    dom.arBtn.addEventListener("click", () => setArLocked(st, dom, !st.arLocked));

    const sizeChanged = (axis) => {
        const input = axis === "w" ? dom.wInput : dom.hInput;
        const raw = parseInt(input.value, 10);
        const snapped = Math.max(st.grid, Math.round(raw / st.grid) * st.grid) || st.grid;
        let s = crToSrc(st.cr, st.sf, st.scale);
        const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        if (axis === "w") {
            s.w = snapped;
            if (st.arLocked) s.h = Math.max(st.grid, Math.round(snapped / st.cropAR / st.grid) * st.grid);
        } else {
            s.h = snapped;
            if (st.arLocked) s.w = Math.max(st.grid, Math.round(snapped * st.cropAR / st.grid) * st.grid);
        }
        s.x = Math.round((cx - s.w / 2) / st.grid) * st.grid;
        s.y = Math.round((cy - s.h / 2) / st.grid) * st.grid;
        setCropFromSrcRect(st, dom, widgets, node, s);
    };
    dom.wInput.addEventListener("change", () => sizeChanged("w"));
    dom.hInput.addEventListener("change", () => sizeChanged("h"));

    dom.resetBtn.addEventListener("click", () => {
        initLayout(st, dom.wrap);
        setArLocked(st, dom, false);
        fitCropInView(st, dom);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });

    for (const btn of dom.chipBtns) {
        btn.addEventListener("click", () => {
            const targetAR = parseFloat(btn.dataset.ratio);
            setArLocked(st, dom, true);
            st.cropAR = targetAR;
            const { w, h } = sizeForRatio(st.srcW, st.srcH, targetAR, st.grid);
            const s = {
                x: Math.round((st.srcW / 2 - w / 2) / st.grid) * st.grid,
                y: Math.round((st.srcH / 2 - h / 2) / st.grid) * st.grid,
                w, h,
            };
            setCropFromSrcRect(st, dom, widgets, node, s);
        });
    }

    for (const btn of dom.snapBtns) {
        btn.addEventListener("click", () => {
            const mode = btn.dataset.snap;
            const g = st.grid;
            let s = crToSrc(st.cr, st.sf, st.scale);
            const { srcW, srcH } = st;
            if (mode === "center") { s.x = Math.round((srcW - s.w) / 2 / g) * g; s.y = Math.round((srcH - s.h) / 2 / g) * g; }
            else if (mode === "top") s.y = 0;
            else if (mode === "bottom") s.y = Math.round((srcH - s.h) / g) * g;
            else if (mode === "left") s.x = 0;
            else if (mode === "right") s.x = Math.round((srcW - s.w) / g) * g;
            else if (mode === "fitW") {
                s.w = srcW;
                if (st.arLocked) s.h = Math.round(s.w / st.cropAR / g) * g;
                s.x = 0;
                s.y = Math.round((srcH - s.h) / 2 / g) * g;
            } else if (mode === "fitH") {
                s.h = srcH;
                if (st.arLocked) s.w = Math.round(s.h * st.cropAR / g) * g;
                s.y = 0;
                s.x = Math.round((srcW - s.w) / 2 / g) * g;
            }
            s = clampToValid(quantize(s, g), srcW, srcH);
            st.cr = srcToCr(s, st.sf, st.scale);
            if (!st.arLocked) st.cropAR = s.w / s.h;
            render(st, dom);
            syncWidgets(st, widgets, node);
        });
    }
}

function wireViewport(st, dom, widgets, node) {
    const { wrap } = dom;

    wrap.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const newZoom = clamp(st.view.zoom * factor, ZOOM_MIN, ZOOM_MAX);
        st.view.panX = sx - (sx - st.view.panX) * (newZoom / st.view.zoom);
        st.view.panY = sy - (sy - st.view.panY) * (newZoom / st.view.zoom);
        st.view.zoom = newZoom;
        render(st, dom);
    }, { passive: false });

    dom.zoomBtn.addEventListener("click", () => {
        st.view = { zoom: Infinity, panX: 0, panY: 0 };
        fitCropInView(st, dom);
        render(st, dom);
    });

    let drag = null;
    let pan = null;

    wrap.addEventListener("pointerdown", (e) => {
        if (e.button === 1) {
            pan = { sx: e.clientX, sy: e.clientY, ox: st.view.panX, oy: st.view.panY };
            wrap.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        const handle = e.target.closest("[data-dir]");
        const inBox = dom.cropBox.contains(e.target);
        if (!handle && !inBox) return;
        e.preventDefault();
        wrap.setPointerCapture(e.pointerId);
        const wc = toWorld(e, wrap, st.view);
        drag = {
            type: handle ? "resize" : "move",
            dir: handle?.dataset.dir,
            sx: wc.x, sy: wc.y,
            sb: { ...st.cr },
            ar: st.arLocked ? st.cropAR : null,
        };
    });

    wrap.addEventListener("pointermove", (e) => {
        if (pan) {
            st.view.panX = pan.ox + (e.clientX - pan.sx);
            st.view.panY = pan.oy + (e.clientY - pan.sy);
            render(st, dom);
            return;
        }
        if (!drag) return;
        const wc = toWorld(e, wrap, st.view);
        const dx = wc.x - drag.sx, dy = wc.y - drag.sy;
        const minPx = st.grid;

        if (drag.type === "move") {
            applyCanvasRect({ x: drag.sb.x + dx, y: drag.sb.y + dy, w: drag.sb.w, h: drag.sb.h }, st);
            render(st, dom);
            return;
        }

        let { x, y, w, h } = { ...drag.sb };
        const { dir, ar } = drag;
        if (dir === "br") {
            w = Math.max(minPx, w + dx);
            h = ar ? Math.round(w / ar) : Math.max(minPx, h + dy);
        } else if (dir === "bl") {
            const nw = Math.max(minPx, w - dx); x += w - nw; w = nw;
            h = ar ? Math.round(w / ar) : Math.max(minPx, h + dy);
        } else if (dir === "tr") {
            w = Math.max(minPx, w + dx);
            const nh = ar ? Math.round(w / ar) : Math.max(minPx, h - dy);
            y += h - nh; h = nh;
        } else if (dir === "tl") {
            const nw = Math.max(minPx, w - dx); x += w - nw; w = nw;
            const nh = ar ? Math.round(w / ar) : Math.max(minPx, h - dy);
            y += h - nh; h = nh;
        } else if (dir === "t") {
            const nh = Math.max(minPx, h - dy);
            const nw = ar ? Math.round(nh * ar) : w;
            if (ar) x += Math.round((w - nw) / 2);
            y += h - nh; h = nh; w = nw;
        } else if (dir === "b") {
            const nh = Math.max(minPx, h + dy);
            const nw = ar ? Math.round(nh * ar) : w;
            if (ar) x += Math.round((w - nw) / 2);
            h = nh; w = nw;
        } else if (dir === "l") {
            const nw = Math.max(minPx, w - dx);
            const nh = ar ? Math.round(nw / ar) : h;
            if (ar) y += Math.round((h - nh) / 2);
            x += w - nw; w = nw; h = nh;
        } else if (dir === "r") {
            const nw = Math.max(minPx, w + dx);
            const nh = ar ? Math.round(nw / ar) : h;
            if (ar) y += Math.round((h - nh) / 2);
            w = nw; h = nh;
        }
        applyCanvasRect({ x, y, w, h }, st);
        render(st, dom);
    });

    wrap.addEventListener("pointerup", () => {
        if (pan) { pan = null; return; }
        if (!drag) return;
        const wasResize = drag.type === "resize";
        if (wasResize && st.arLocked) {
            let s = quantize(crToSrc(st.cr, st.sf, st.scale), st.grid);
            s.h = Math.max(st.grid, Math.round(s.w / st.cropAR / st.grid) * st.grid);
            s = clampToValid(s, st.srcW, st.srcH);
            st.cr = srcToCr(s, st.sf, st.scale);
        }
        if (wasResize && !st.arLocked) {
            const s = crToSrc(st.cr, st.sf, st.scale);
            st.cropAR = s.w / s.h;
        }
        if (wasResize) fitCropInView(st, dom);
        drag = null;
        render(st, dom);
        syncWidgets(st, widgets, node);
    });

    wrap.addEventListener("pointercancel", () => { pan = null; drag = null; });
}

// ---------------------------------------------------------------------------
// batch lifecycle: reset when the queue drains
// ---------------------------------------------------------------------------

api.addEventListener("status", (e) => {
    const remaining = e.detail?.exec_info?.queue_remaining;
    if (remaining > 0) {
        queueWasRunning = true;
        if (batchResetTimer) { clearTimeout(batchResetTimer); batchResetTimer = null; }
    } else if (remaining === 0 && queueWasRunning) {
        queueWasRunning = false;
        if (batchResetTimer) return;
        batchResetTimer = setTimeout(() => {
            for (const { st, dom, widgets, node } of liveNodes) {
                if (!st.batchMode && !st.hasPreset) continue;
                st.batchMode = false;
                st.hasPreset = false;
                setBatchVisual(st, dom, false);
                postJSON("/pw_outpaint/clear_preset", { node_id: String(node.id) }).catch(() => {});
                resetNodeState(st, dom, widgets);
                flashMessage(dom, "Batch complete. Node reset.", 3000);
            }
            batchResetTimer = null;
        }, 2000);
    }
});

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "PWOutpaint",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;

            const widgets = {
                cropState: node.widgets?.find((w) => w.name === "crop_state"),
                gridSnap: node.widgets?.find((w) => w.name === "grid_snap"),
            };
            if (widgets.cropState) {
                widgets.cropState.hidden = true;
                widgets.cropState.computeSize = () => [0, -4];
            }
            if (node.inputs) {
                for (let i = node.inputs.length - 1; i >= 0; i--) {
                    if (node.inputs[i].name === "crop_state") node.removeInput(i);
                }
            }

            const st = createState();
            const dom = buildUI();

            // keep the JS grid in sync with the grid_snap widget
            if (widgets.gridSnap) {
                st.grid = parseInt(widgets.gridSnap.value, 10) || 16;
                const origCallback = widgets.gridSnap.callback;
                widgets.gridSnap.callback = function (value, ...rest) {
                    const r = origCallback?.call(this, value, ...rest);
                    st.grid = parseInt(value, 10) || 16;
                    if (st.initialized) {
                        applyCanvasRect(st.cr, st);
                        render(st, dom);
                        syncWidgets(st, widgets, node);
                    }
                    return r;
                };
            }

            wireColors(st, dom, widgets, node);
            wirePresets(st, dom, widgets, node);
            wireControls(st, dom, widgets, node);
            wireViewport(st, dom, widgets, node);
            setUIActive(dom, false);

            const domWidget = node.addDOMWidget("pw_outpaint_canvas", "custom", dom.root, { serialize: false, hideOnZoom: false });
            domWidget.computeSize = () => [520, CANVAS_H + CTRL_H];
            node.setSize([Math.max(node.size[0], 540), Math.max(node.size[1], CANVAS_H + CTRL_H + 10)]);

            node._pwHeartbeat = null;
            const stopHeartbeat = () => {
                if (node._pwHeartbeat) { clearInterval(node._pwHeartbeat); node._pwHeartbeat = null; }
            };
            const startHeartbeat = () => {
                stopHeartbeat();
                node._pwHeartbeat = setInterval(() => {
                    postJSON("/pw_outpaint/heartbeat", { node_id: String(node.id) }).catch(() => {});
                }, 3000);
            };

            liveNodes.push({ st, dom, widgets, node });

            const loadPreviewImage = (nodeId, onReady) => {
                const url = api.apiURL(`/view?filename=pw_outpaint_${nodeId}.png&type=temp&subfolder=pw_outpaint&t=${Date.now()}`);
                const img = new Image();
                img.onload = () => {
                    dom.imageEl.src = url;
                    dom.imageEl.style.display = "block";
                    fitCropInView(st, dom);
                    render(st, dom);
                    onReady?.();
                };
                img.src = url;
            };

            const onShow = (event) => {
                const data = event.detail || event;
                if (String(data.node_id) !== String(node.id)) return;
                const hadActivePreset = st.batchMode && st.hasPreset;
                resetNodeState(st, dom, widgets);
                st.srcW = data.image_width;
                st.srcH = data.image_height;
                if (!initLayout(st, dom.wrap)) return;

                if (hadActivePreset) {
                    st.batchMode = true;
                    st.hasPreset = true;
                    dom.noDataMsg.style.display = "flex";
                    dom.noDataMsg.textContent = `Applying saved frame to ${st.srcW}x${st.srcH}...`;
                    loadPreviewImage(data.node_id, async () => {
                        try {
                            await postJSON("/pw_outpaint/decision", { node_id: String(node.id), decision: "approve", crop_state: "", batch_mode: true });
                            startHeartbeat();
                            flashMessage(dom, `Batch: ${st.srcW}x${st.srcH} processed`, 1000);
                        } catch (err) {
                            console.error("PW Outpaint batch auto-approve failed:", err);
                        }
                    });
                    startHeartbeat();
                } else {
                    dom.waitingMsg.style.display = "flex";
                    dom.acceptBtn.style.display = "block";
                    dom.cancelBtn.style.display = "block";
                    dom.batchBtn.style.display = "block";
                    setBatchVisual(st, dom, false);
                    loadPreviewImage(data.node_id);
                    startHeartbeat();
                    setUIActive(dom, true);
                }
            };
            api.addEventListener("pw_outpaint.show", onShow);

            dom.batchBtn.addEventListener("click", async () => {
                setBatchVisual(st, dom, !st.batchMode);
                try {
                    await postJSON("/pw_outpaint/batch_toggle", { node_id: String(node.id), enabled: st.batchMode });
                } catch { /* server unreachable; visual state only */ }
            });

            dom.acceptBtn.addEventListener("click", async () => {
                dom.acceptBtn.textContent = "Sending...";
                dom.acceptBtn.disabled = true;
                try {
                    const resp = await postJSON("/pw_outpaint/decision", {
                        node_id: String(node.id),
                        decision: "approve",
                        crop_state: stateJSON(st),
                        batch_mode: st.batchMode,
                    });
                    if (resp.ok) {
                        stopHeartbeat();
                        if (st.batchMode) {
                            st.hasPreset = true;
                            dom.waitingMsg.style.display = "none";
                            dom.acceptBtn.style.display = "none";
                            dom.cancelBtn.style.display = "none";
                            dom.batchBtn.style.display = "none";
                            flashMessage(dom, "Frame saved. Batch mode armed.");
                        } else {
                            resetNodeState(st, dom, widgets);
                            flashMessage(dom, "Accepted. Continuing...", 1500);
                            postJSON("/pw_outpaint/clear_preset", { node_id: String(node.id) }).catch(() => {});
                        }
                        setUIActive(dom, false);
                    } else {
                        dom.acceptBtn.textContent = "Accept";
                        dom.acceptBtn.disabled = false;
                    }
                } catch (err) {
                    console.error("PW Outpaint accept failed:", err);
                    dom.acceptBtn.textContent = "Accept";
                    dom.acceptBtn.disabled = false;
                }
            });

            dom.cancelBtn.addEventListener("click", async () => {
                stopHeartbeat();
                resetNodeState(st, dom, widgets);
                try { await postJSON("/pw_outpaint/decision", { node_id: String(node.id), decision: "cancel" }); } catch { }
                setUIActive(dom, false);
            });

            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (!st.initialized && initLayout(st, dom.wrap)) {
                    fitCropInView(st, dom);
                    render(st, dom);
                    syncWidgets(st, widgets, node);
                }
            }));

            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                st.batchMode = false;
                st.hasPreset = false;
                api.removeEventListener("pw_outpaint.show", onShow);
                stopHeartbeat();
                liveNodes = liveNodes.filter((n) => n.node !== node);
                postJSON("/pw_outpaint/clear_preset", { node_id: String(node.id) }).catch(() => {});
                postJSON("/pw_outpaint/cleanup", { node_id: String(node.id) }).catch(() => {});
                if (origOnRemoved) origOnRemoved.call(this);
            };

            return result;
        };
    },
});
