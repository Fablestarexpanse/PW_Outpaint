// PW Outpaint - canvas-based outpaint framing editor.
// Pairs with pw_outpaint.py (node class "PWOutpaint").
//
// The frame is modeled as four paddings around the source image. The editor
// renders everything on a single <canvas>: the image, a tinted preview of the
// new area, the frame border with drag handles, and dimension readouts.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "PWOutpaint";
const EDITOR_H = 300;
const REST_H = 205;    // controls below the editor, at rest
const ACTIVE_H = 315;  // controls while Batch/Accept/Cancel are shown
const VIEW_MARGIN = 26;
const HANDLE_R = 5;
const HIT_RANGE = 9;

const ASPECTS = [
    ["free", "Free"], ["1", "1:1"], [String(16 / 9), "16:9"], [String(9 / 16), "9:16"],
    [String(4 / 3), "4:3"], [String(3 / 4), "3:4"], [String(21 / 9), "21:9"], [String(9 / 21), "9:21"],
    [String(3 / 2), "3:2"], [String(2 / 3), "2:3"],
];
const SCALES = [1.25, 1.5, 2];

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
    okBg: "rgba(80,200,120,0.12)",
    okBorder: "rgba(80,200,120,0.45)",
    okText: "#9fe6b8",
    dangerBg: "rgba(230,90,90,0.12)",
    dangerBorder: "rgba(230,90,90,0.45)",
    dangerText: "#f2a6a6",
};

let queueWasRunning = false;
let batchResetTimer = null;
let liveNodes = [];

// ---------------------------------------------------------------------------
// small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, css, props) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (props) Object.assign(node, props);
    return node;
}

function softBtn(label, opts = {}) {
    const b = el("button", "", { textContent: label, type: "button" });
    b.classList.add("comfy-btn");
    Object.assign(b.style, {
        border: `1px solid ${T.border}`, background: T.btn, color: T.text,
        borderRadius: "4px", padding: "3px 8px", cursor: "pointer",
        fontSize: "11px", lineHeight: "1.2",
    });
    if (opts.title) b.title = opts.title;
    if (opts.flex) b.style.flex = opts.flex;
    b.onmouseenter = () => { if (!b._on) b.style.background = T.btnHover; };
    b.onmouseleave = () => { b.style.background = b._on ? T.btnActive : T.btn; };
    return b;
}

function setBtnOn(b, on) {
    b._on = on;
    b.style.background = on ? T.btnActive : T.btn;
    b.style.color = on ? T.textBright : T.text;
    b.style.borderColor = on ? "rgba(255,255,255,0.35)" : T.border;
}

function numField(width) {
    const f = el("input", "", { type: "number", min: 0, step: 8, value: "0" });
    f.classList.add("comfy-input");
    Object.assign(f.style, {
        borderRadius: "4px", border: `1px solid ${T.border}`, background: T.panel,
        color: T.textBright, padding: "2px 5px", boxSizing: "border-box",
        fontSize: "11px", fontFamily: "monospace", textAlign: "right", width,
    });
    return f;
}

// Unified swatch: color block + hex readout in one control (click to pick).
function colorSwatch(label, initial, title) {
    const row = el("div", `display:flex;align-items:center;gap:5px;font-size:10px;color:${T.textDim};`);
    if (title) row.title = title;
    const tag = el("span", "min-width:26px;text-align:right;", { textContent: label });
    const host = el("div", `display:inline-flex;align-items:stretch;border-radius:4px;border:1px solid ${T.border};overflow:hidden;cursor:pointer;height:22px;box-sizing:border-box;`);
    const block = el("div", `flex:0 0 18px;background:${initial};border-right:1px solid ${T.border};`);
    const hex = el("div", `display:flex;align-items:center;padding:0 6px;font-size:10px;color:#aaaaaa;background:${T.panel};letter-spacing:0.5px;font-family:monospace;user-select:none;`, { textContent: initial.toUpperCase() });
    const picker = el("input", "position:absolute;opacity:0;width:0;height:0;pointer-events:none;", { type: "color", value: initial });
    host.append(block, hex, picker);
    host.addEventListener("click", () => picker.click());
    row.append(tag, host);
    const sync = (v) => { picker.value = v; block.style.background = v; hex.textContent = v.toUpperCase(); };
    return { row, host, picker, sync };
}

async function postJSON(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// editor: state + math
// ---------------------------------------------------------------------------

function freshState() {
    return {
        srcW: 0, srcH: 0, img: null,
        pads: { l: 0, t: 0, r: 0, b: 0 },
        anchor: { fx: 0.5, fy: 0.5 },
        grid: 16,
        colors: { mask: "#ff0000", bg: "#141414", fill: "#808080" },
        view: { scale: 1, ox: 0, oy: 0 },
        waiting: false, batch: false, armed: false,
        hover: null, drag: null,
    };
}

const outW = (st) => st.srcW + st.pads.l + st.pads.r;
const outH = (st) => st.srcH + st.pads.t + st.pads.b;
const gridRound = (v, g) => Math.round(v / g) * g;
const gridCeil = (v, g) => Math.ceil(v / g) * g;

// Split extra pixels between the two sides of one axis according to the
// anchor fraction, keeping the first side on the snap grid when possible.
function splitExtra(extra, fraction, grid) {
    const first = Math.min(extra, Math.max(0, gridRound(extra * fraction, grid)));
    return [first, extra - first];
}

function setOutputSize(st, w, h) {
    const ow = Math.max(st.srcW, gridRound(w, st.grid));
    const oh = Math.max(st.srcH, gridRound(h, st.grid));
    [st.pads.l, st.pads.r] = splitExtra(ow - st.srcW, st.anchor.fx, st.grid);
    [st.pads.t, st.pads.b] = splitExtra(oh - st.srcH, st.anchor.fy, st.grid);
}

function applyAspect(st, ratio) {
    let w = Math.max(st.srcW, st.srcH * ratio);
    let h = w / ratio;
    if (h < st.srcH) { h = st.srcH; w = h * ratio; }
    setOutputSize(st, gridCeil(w, st.grid), gridCeil(h, st.grid));
}

// View transform: world (source-image pixels) -> canvas CSS pixels.
const wx = (st, x) => (x + st.pads.l) * st.view.scale + st.view.ox;
const wy = (st, y) => (y + st.pads.t) * st.view.scale + st.view.oy;

function fitView(st, cw, ch) {
    const fw = outW(st), fh = outH(st);
    if (fw <= 0 || fh <= 0 || cw <= 0 || ch <= 0) return;
    st.view.scale = Math.min((cw - VIEW_MARGIN * 2) / fw, (ch - VIEW_MARGIN * 2) / fh);
    st.view.ox = (cw - fw * st.view.scale) / 2;
    st.view.oy = (ch - fh * st.view.scale) / 2;
    st.view.fittedFor = cw + "x" + ch;
}

// Screen-space frame rectangle {x0,y0,x1,y1}.
function frameRect(st) {
    return {
        x0: wx(st, -st.pads.l), y0: wy(st, -st.pads.t),
        x1: wx(st, st.srcW + st.pads.r), y1: wy(st, st.srcH + st.pads.b),
    };
}

// What is under the cursor: "nw","n","ne","e","se","s","sw","w","move" or null.
function hitTest(st, mx, my) {
    const r = frameRect(st);
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const near = (px, py) => Math.abs(mx - px) <= HIT_RANGE && Math.abs(my - py) <= HIT_RANGE;
    if (near(r.x0, r.y0)) return "nw";
    if (near(r.x1, r.y0)) return "ne";
    if (near(r.x0, r.y1)) return "sw";
    if (near(r.x1, r.y1)) return "se";
    if (near(cx, r.y0)) return "n";
    if (near(cx, r.y1)) return "s";
    if (near(r.x0, cy)) return "w";
    if (near(r.x1, cy)) return "e";
    const insideX = mx > r.x0 && mx < r.x1, insideY = my > r.y0 && my < r.y1;
    if (insideX && Math.abs(my - r.y0) <= HIT_RANGE - 2) return "n";
    if (insideX && Math.abs(my - r.y1) <= HIT_RANGE - 2) return "s";
    if (insideY && Math.abs(mx - r.x0) <= HIT_RANGE - 2) return "w";
    if (insideY && Math.abs(mx - r.x1) <= HIT_RANGE - 2) return "e";
    if (insideX && insideY) return "move";
    return null;
}

const CURSORS = {
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    move: "move",
};

// Apply a drag (world-space deltas) to the paddings captured at drag start.
function dragPads(st, mode, start, dwx, dwy) {
    const g = st.grid;
    const p = { ...start };
    if (mode === "move") {
        const shiftX = Math.max(-start.r, Math.min(start.l, gridRound(dwx, g)));
        const shiftY = Math.max(-start.b, Math.min(start.t, gridRound(dwy, g)));
        p.l = start.l - shiftX; p.r = start.r + shiftX;
        p.t = start.t - shiftY; p.b = start.b + shiftY;
        st.pads = p;
        return;
    }
    const snapSide = (raw) => Math.max(0, gridRound(raw, g));
    if (mode.includes("e")) p.r = snapSide(start.r + dwx);
    if (mode.includes("w")) p.l = snapSide(start.l - dwx);
    if (mode.includes("s")) p.b = snapSide(start.b + dwy);
    if (mode.includes("n")) p.t = snapSide(start.t - dwy);
    st.pads = p;
}

// ---------------------------------------------------------------------------
// editor: rendering
// ---------------------------------------------------------------------------

function pill(ctx, x, y, text) {
    ctx.font = "600 11px monospace";
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 9, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 0.5);
}

function draw(st, canvas) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // the canvas may have had zero size when the frame arrived (node off-screen);
    // refit once real dimensions are available or whenever they change
    if (st.img && !st.drag && st.view.fittedFor !== cw + "x" + ch) {
        fitView(st, cw, ch);
    }

    if (!st.img) {
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Run the workflow to load the image", cw / 2, ch / 2);
        return;
    }

    const s = st.view.scale;
    const r = frameRect(st);
    const ix0 = wx(st, 0), iy0 = wy(st, 0);
    const iw = st.srcW * s, ih = st.srcH * s;

    // tint the new (outpainted) strips with the mask color
    ctx.fillStyle = st.colors.mask + "38";
    if (st.pads.t > 0) ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, iy0 - r.y0);
    if (st.pads.b > 0) ctx.fillRect(r.x0, iy0 + ih, r.x1 - r.x0, r.y1 - iy0 - ih);
    if (st.pads.l > 0) ctx.fillRect(r.x0, iy0, ix0 - r.x0, ih);
    if (st.pads.r > 0) ctx.fillRect(ix0 + iw, iy0, r.x1 - ix0 - iw, ih);

    ctx.drawImage(st.img, ix0, iy0, iw, ih);

    // frame border + drag handles
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const spots = [[r.x0, r.y0], [cx, r.y0], [r.x1, r.y0], [r.x1, cy], [r.x1, r.y1], [cx, r.y1], [r.x0, r.y1], [r.x0, cy]];
    for (const [hx, hy] of spots) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(hx - HANDLE_R, hy - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2, 2);
        ctx.fill();
        ctx.stroke();
    }

    // pad readouts on each extended side
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = st.colors.mask;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 3;
    if (st.pads.t > 0) ctx.fillText(`+${st.pads.t}`, cx, (r.y0 + iy0) / 2);
    if (st.pads.b > 0) ctx.fillText(`+${st.pads.b}`, cx, (iy0 + ih + r.y1) / 2);
    if (st.pads.l > 0) ctx.fillText(`+${st.pads.l}`, (r.x0 + ix0) / 2, cy);
    if (st.pads.r > 0) ctx.fillText(`+${st.pads.r}`, (ix0 + iw + r.x1) / 2, cy);
    ctx.shadowBlur = 0;

    pill(ctx, cx, r.y1 - 16, `${outW(st)} × ${outH(st)}`);
}

// ---------------------------------------------------------------------------
// widget plumbing
// ---------------------------------------------------------------------------

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name) ?? null;
}

function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    w.computeSize = () => [0, -4];
}

function pushToWidgets(st, ui) {
    if (ui.w.padL) ui.w.padL.value = st.pads.l;
    if (ui.w.padT) ui.w.padT.value = st.pads.t;
    if (ui.w.padR) ui.w.padR.value = st.pads.r;
    if (ui.w.padB) ui.w.padB.value = st.pads.b;
    if (ui.w.style) ui.w.style.value = JSON.stringify(st.colors);
    ui.node.graph?.setDirtyCanvas(true, true);
}

function pullFromWidgets(st, ui) {
    st.pads = {
        l: Math.max(0, parseInt(ui.w.padL?.value, 10) || 0),
        t: Math.max(0, parseInt(ui.w.padT?.value, 10) || 0),
        r: Math.max(0, parseInt(ui.w.padR?.value, 10) || 0),
        b: Math.max(0, parseInt(ui.w.padB?.value, 10) || 0),
    };
    try {
        const style = JSON.parse(ui.w.style?.value || "{}");
        for (const k of ["mask", "bg", "fill"]) {
            if (/^#[0-9a-f]{6}$/i.test(style[k] || "")) st.colors[k] = style[k];
        }
    } catch { /* keep defaults */ }
    st.grid = parseInt(ui.w.grid?.value, 10) || 16;
}

// ---------------------------------------------------------------------------
// UI assembly per node
// ---------------------------------------------------------------------------

function buildEditor(node) {
    const st = freshState();
    const root = el("div", `width:100%;box-sizing:border-box;padding:6px;font-family:system-ui,sans-serif;font-size:12px;color:${T.text};position:relative;`);

    const canvas = el("canvas", `display:block;width:100%;height:${EDITOR_H}px;background:${T.surface};border:${T.surfaceBorder};border-radius:8px;touch-action:none;`);
    canvas.tabIndex = 0;

    // status row
    const statusRow = el("div", "display:flex;align-items:center;justify-content:space-between;margin-top:5px;gap:8px;");
    const statusText = el("div", `font-size:11px;color:${T.textDim};flex:1;`, { textContent: "Idle" });
    const fitBtn = softBtn("Fit view", { title: "Refit the frame in the editor (or double-click the canvas)" });
    statusRow.append(statusText, fitBtn);

    // paddings row
    const padsRow = el("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:4px;");
    const padInputs = {};
    padsRow.append(el("span", `font-size:10px;color:${T.textDim};`, { textContent: "Pad" }));
    for (const [key, tag] of [["l", "L"], ["t", "T"], ["r", "R"], ["b", "B"]]) {
        padsRow.append(el("span", `font-size:10px;color:${T.textDim};`, { textContent: tag }));
        const f = numField("52px");
        padInputs[key] = f;
        padsRow.append(f);
    }

    // output row: W/H, aspect menu, scale shortcuts
    const outRow = el("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:2px;");
    outRow.append(el("span", `font-size:10px;color:${T.textDim};`, { textContent: "Out" }));
    const wField = numField("58px");
    const hField = numField("58px");
    const aspectSel = el("select", "");
    aspectSel.classList.add("comfy-input");
    Object.assign(aspectSel.style, {
        borderRadius: "4px", border: `1px solid ${T.border}`, background: T.panel,
        color: T.textBright, fontSize: "11px", padding: "2px 4px", cursor: "pointer",
    });
    for (const [value, label] of ASPECTS) aspectSel.append(el("option", "", { value, textContent: label }));
    const scaleBtns = SCALES.map((k) => {
        const b = softBtn(`×${k}`, { title: `Extend the canvas to ${k}× the source size` });
        b.style.padding = "3px 7px";
        b.style.fontFamily = "monospace";
        return b;
    });
    outRow.append(wField, el("span", `font-size:10px;color:${T.textDim};`, { textContent: "×" }), hField, aspectSel, ...scaleBtns);

    // anchor grid + colors
    const midRow = el("div", "display:flex;align-items:flex-start;gap:14px;margin-top:4px;");
    const anchorWrap = el("div", "display:flex;align-items:center;gap:6px;");
    anchorWrap.append(el("span", `font-size:10px;color:${T.textDim};`, { textContent: "Anchor" }));
    const anchorGrid = el("div", "display:grid;grid-template-columns:repeat(3,16px);grid-auto-rows:16px;gap:2px;");
    const anchorBtns = [];
    for (const fy of [0, 0.5, 1]) {
        for (const fx of [0, 0.5, 1]) {
            const b = el("button", `border:1px solid ${T.border};background:${T.btn};border-radius:3px;cursor:pointer;padding:0;`, { type: "button", title: "Where the source sits inside the output" });
            b.dataset.fx = fx;
            b.dataset.fy = fy;
            anchorBtns.push(b);
            anchorGrid.appendChild(b);
        }
    }
    anchorWrap.appendChild(anchorGrid);
    const swMask = colorSwatch("mask", st.colors.mask, "Mask overlay color (also used in mask_image output)");
    const swBg = colorSwatch("bg", st.colors.bg, "Background color of the mask_image output");
    const swFill = colorSwatch("fill", st.colors.fill, "Fill color when fill_mode is solid_color");
    const colorCol = el("div", "display:flex;flex-direction:column;gap:3px;");
    colorCol.append(swMask.row, swBg.row, swFill.row);
    midRow.append(anchorWrap, colorCol);

    // presets
    const presetRow = el("div", "display:flex;align-items:center;gap:6px;margin-top:4px;");
    const saveBtn = softBtn("Save preset", { flex: "1" });
    const loadBtn = softBtn("Load preset", { flex: "1" });
    presetRow.append(saveBtn, loadBtn);

    const listOverlay = el("div", `position:absolute;display:none;top:50%;left:50%;transform:translate(-50%,-50%);flex-direction:column;max-height:200px;overflow-y:auto;background:${T.panel};border:1px solid ${T.border};border-radius:8px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.6);min-width:190px;padding:5px;`);
    const namePanel = el("div", `position:absolute;display:none;top:50%;left:50%;transform:translate(-50%,-50%);background:${T.panel};padding:10px;border:1px solid ${T.border};border-radius:8px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.6);width:220px;`);
    const nameField = el("input", `width:100%;margin-bottom:6px;box-sizing:border-box;border-radius:4px;border:1px solid ${T.border};background:#111;color:${T.textBright};padding:4px 6px;font-size:11px;`, { placeholder: "Preset name..." });
    const nameRow = el("div", "display:flex;gap:5px;");
    const nameOk = softBtn("Save", { flex: "1" });
    const nameCancel = softBtn("Cancel", { flex: "1" });
    nameRow.append(nameOk, nameCancel);
    namePanel.append(nameField, nameRow);
    root.append(listOverlay, namePanel);

    // action buttons
    const action = (label, tone) => {
        const b = el("button", "padding:6px 12px;font-size:11px;font-weight:600;border-radius:4px;cursor:pointer;width:100%;text-align:center;display:none;letter-spacing:0.3px;margin-top:3px;", { textContent: label, type: "button" });
        const [bg, border, color] = tone === "ok" ? [T.okBg, T.okBorder, T.okText]
            : tone === "danger" ? [T.dangerBg, T.dangerBorder, T.dangerText]
                : [T.btn, T.border, T.text];
        Object.assign(b.style, { background: bg, border: `1px solid ${border}`, color });
        return b;
    };
    const batchBtn = action("Batch off", "neutral");
    batchBtn.title = "Reuse this frame automatically on the rest of the queue";
    const acceptBtn = action("Accept", "ok");
    const cancelBtn = action("Cancel", "danger");

    root.append(canvas, statusRow, padsRow, outRow, midRow, presetRow, batchBtn, acceptBtn, cancelBtn);

    const ui = {
        node, st, root, canvas, statusText, fitBtn,
        padInputs, wField, hField, aspectSel, scaleBtns,
        anchorBtns, swMask, swBg, swFill,
        saveBtn, loadBtn, listOverlay, namePanel, nameField, nameOk, nameCancel,
        batchBtn, acceptBtn, cancelBtn,
        w: {
            grid: findWidget(node, "grid_snap"),
            padL: findWidget(node, "pad_left"),
            padT: findWidget(node, "pad_top"),
            padR: findWidget(node, "pad_right"),
            padB: findWidget(node, "pad_bottom"),
            style: findWidget(node, "style_state"),
        },
        heartbeat: null,
    };
    return ui;
}

function refreshControls(ui) {
    const { st } = ui;
    for (const k of ["l", "t", "r", "b"]) {
        if (document.activeElement !== ui.padInputs[k]) ui.padInputs[k].value = st.pads[k];
    }
    if (document.activeElement !== ui.wField) ui.wField.value = st.srcW ? outW(st) : "";
    if (document.activeElement !== ui.hField) ui.hField.value = st.srcH ? outH(st) : "";
    for (const b of ui.anchorBtns) {
        const on = Number(b.dataset.fx) === st.anchor.fx && Number(b.dataset.fy) === st.anchor.fy;
        b.style.background = on ? "rgba(255,255,255,0.75)" : T.btn;
        b.style.borderColor = on ? "rgba(255,255,255,0.75)" : T.border;
    }
    ui.swMask.sync(st.colors.mask);
    ui.swBg.sync(st.colors.bg);
    ui.swFill.sync(st.colors.fill);
    ui.statusText.textContent = st.waiting
        ? "Paused — frame the outpaint, then press Accept"
        : (st.armed ? "Batch armed — queued runs reuse this frame" : (st.srcW ? `${st.srcW} × ${st.srcH} source` : "Idle"));
    ui.statusText.style.color = st.waiting ? "rgba(255,255,255,0.85)" : T.textDim;
}

function repaint(ui) {
    refreshControls(ui);
    draw(ui.st, ui.canvas);
}

function commit(ui) {
    pushToWidgets(ui.st, ui);
    repaint(ui);
}

function setActionsVisible(ui, visible) {
    ui.acceptBtn.style.display = visible ? "block" : "none";
    ui.cancelBtn.style.display = visible ? "block" : "none";
    ui.batchBtn.style.display = (visible || ui.st.armed) ? "block" : "none";
}

// ---------------------------------------------------------------------------
// interaction wiring
// ---------------------------------------------------------------------------

function wireEditor(ui) {
    const { st, canvas } = ui;
    const mouse = (e) => {
        // the graph zoom CSS-scales the DOM widget: getBoundingClientRect is in
        // visual pixels, the canvas draws in layout pixels - map between them
        const r = canvas.getBoundingClientRect();
        const kx = r.width > 0 ? canvas.clientWidth / r.width : 1;
        const ky = r.height > 0 ? canvas.clientHeight / r.height : 1;
        return { x: (e.clientX - r.left) * kx, y: (e.clientY - r.top) * ky };
    };

    canvas.addEventListener("pointerdown", (e) => {
        if (!st.img) return;
        const m = mouse(e);
        const mode = e.button === 1 ? null : hitTest(st, m.x, m.y);
        canvas.setPointerCapture(e.pointerId);
        st.drag = mode
            ? { kind: "frame", mode, x: m.x, y: m.y, pads: { ...st.pads } }
            : { kind: "pan", x: m.x, y: m.y, ox: st.view.ox, oy: st.view.oy, padsAtStart: { ...st.pads } };
        e.preventDefault();
    });

    canvas.addEventListener("pointermove", (e) => {
        const m = mouse(e);
        if (!st.drag) {
            const mode = st.img ? hitTest(st, m.x, m.y) : null;
            canvas.style.cursor = mode ? CURSORS[mode] : "default";
            return;
        }
        if (st.drag.kind === "pan") {
            st.view.ox = st.drag.ox + (m.x - st.drag.x);
            st.view.oy = st.drag.oy + (m.y - st.drag.y);
            draw(st, canvas);
            return;
        }
        const dwx = (m.x - st.drag.x) / st.view.scale;
        const dwy = (m.y - st.drag.y) / st.view.scale;
        // keep the world origin steady: the view anchors the frame's top-left,
        // so compensate when the left/top pads change
        const before = { l: st.pads.l, t: st.pads.t };
        dragPads(st, st.drag.mode, st.drag.pads, dwx, dwy);
        st.view.ox -= (st.pads.l - before.l) * st.view.scale;
        st.view.oy -= (st.pads.t - before.t) * st.view.scale;
        if (st.drag.mode !== "move") ui.aspectSel.value = "free";
        repaint(ui);
    });

    const endDrag = () => {
        if (!st.drag) return;
        const wasFrame = st.drag.kind === "frame";
        st.drag = null;
        if (wasFrame) commit(ui);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener("wheel", (e) => {
        if (!st.img) return;
        e.preventDefault();
        const m = mouse(e);
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.min(8, Math.max(0.05, st.view.scale * factor));
        st.view.ox = m.x - (m.x - st.view.ox) * (next / st.view.scale);
        st.view.oy = m.y - (m.y - st.view.oy) * (next / st.view.scale);
        st.view.scale = next;
        draw(st, canvas);
    }, { passive: false });

    canvas.addEventListener("dblclick", () => {
        fitView(st, canvas.clientWidth, canvas.clientHeight);
        draw(st, canvas);
    });
    ui.fitBtn.addEventListener("click", () => {
        fitView(st, canvas.clientWidth, canvas.clientHeight);
        draw(st, canvas);
    });

    // pads typed directly
    for (const k of ["l", "t", "r", "b"]) {
        ui.padInputs[k].addEventListener("change", () => {
            const v = Math.max(0, parseInt(ui.padInputs[k].value, 10) || 0);
            st.pads[k] = gridRound(v, st.grid);
            ui.aspectSel.value = "free";
            fitView(st, canvas.clientWidth, canvas.clientHeight);
            commit(ui);
        });
    }

    // output size typed directly
    const sizeTyped = () => {
        const w = parseInt(ui.wField.value, 10) || outW(st);
        const h = parseInt(ui.hField.value, 10) || outH(st);
        setOutputSize(st, w, h);
        ui.aspectSel.value = "free";
        fitView(st, canvas.clientWidth, canvas.clientHeight);
        commit(ui);
    };
    ui.wField.addEventListener("change", sizeTyped);
    ui.hField.addEventListener("change", sizeTyped);

    ui.aspectSel.addEventListener("change", () => {
        const v = ui.aspectSel.value;
        if (v === "free" || !st.srcW) return;
        applyAspect(st, parseFloat(v));
        fitView(st, canvas.clientWidth, canvas.clientHeight);
        commit(ui);
    });

    for (let i = 0; i < ui.scaleBtns.length; i++) {
        ui.scaleBtns[i].addEventListener("click", () => {
            if (!st.srcW) return;
            setOutputSize(st, gridCeil(st.srcW * SCALES[i], st.grid), gridCeil(st.srcH * SCALES[i], st.grid));
            ui.aspectSel.value = "free";
            fitView(st, canvas.clientWidth, canvas.clientHeight);
            commit(ui);
        });
    }

    for (const b of ui.anchorBtns) {
        b.addEventListener("click", () => {
            st.anchor = { fx: Number(b.dataset.fx), fy: Number(b.dataset.fy) };
            setOutputSize(st, outW(st), outH(st));
            fitView(st, canvas.clientWidth, canvas.clientHeight);
            commit(ui);
        });
    }

    const bindColor = (sw, key) => sw.picker.addEventListener("input", (e) => {
        st.colors[key] = e.target.value;
        commit(ui);
    });
    bindColor(ui.swMask, "mask");
    bindColor(ui.swBg, "bg");
    bindColor(ui.swFill, "fill");

    // react to grid_snap widget changes
    if (ui.w.grid) {
        const orig = ui.w.grid.callback;
        ui.w.grid.callback = function (value, ...rest) {
            const r = orig?.call(this, value, ...rest);
            st.grid = parseInt(value, 10) || 16;
            repaint(ui);
            return r;
        };
    }
}

function wirePresets(ui) {
    const { st } = ui;
    ui.saveBtn.addEventListener("click", () => {
        ui.listOverlay.style.display = "none";
        ui.namePanel.style.display = "block";
        ui.nameField.value = "";
        ui.nameField.focus();
    });
    const doSave = async () => {
        const name = ui.nameField.value.trim();
        if (!name) return;
        try {
            const r = await postJSON("/pw_outpaint/save_preset", {
                name,
                preset_data: { pads: { ...st.pads }, style: { ...st.colors }, anchor: { ...st.anchor } },
            });
            ui.namePanel.style.display = "none";
            ui.statusText.textContent = r.ok ? `Preset "${name}" saved` : "Save failed";
        } catch (e) {
            ui.statusText.textContent = "Error: " + e.message;
        }
    };
    ui.nameOk.addEventListener("click", doSave);
    ui.nameCancel.addEventListener("click", () => { ui.namePanel.style.display = "none"; });
    ui.nameField.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSave();
        if (e.key === "Escape") ui.namePanel.style.display = "none";
    });

    const applyPreset = async (name) => {
        ui.listOverlay.style.display = "none";
        try {
            const res = await postJSON("/pw_outpaint/load_preset", { name });
            if (!res.ok) throw new Error("Load failed");
            const data = await res.json();
            if (data.pads) st.pads = {
                l: Math.max(0, data.pads.l | 0), t: Math.max(0, data.pads.t | 0),
                r: Math.max(0, data.pads.r | 0), b: Math.max(0, data.pads.b | 0),
            };
            if (data.anchor) st.anchor = { fx: data.anchor.fx ?? 0.5, fy: data.anchor.fy ?? 0.5 };
            for (const k of ["mask", "bg", "fill"]) {
                if (/^#[0-9a-f]{6}$/i.test(data.style?.[k] || "")) st.colors[k] = data.style[k];
            }
            fitView(st, ui.canvas.clientWidth, ui.canvas.clientHeight);
            commit(ui);
        } catch (e) {
            ui.statusText.textContent = "Error: " + e.message;
        }
    };

    ui.loadBtn.addEventListener("click", async () => {
        ui.namePanel.style.display = "none";
        if (ui.listOverlay.style.display === "flex") { ui.listOverlay.style.display = "none"; return; }
        ui.listOverlay.innerHTML = `<div style='padding:8px;color:${T.textDim};text-align:center;'>Loading...</div>`;
        ui.listOverlay.style.display = "flex";
        try {
            const res = await postJSON("/pw_outpaint/list_presets", {});
            const names = await res.json();
            ui.listOverlay.innerHTML = "";
            if (!names.length) { ui.listOverlay.textContent = "No presets found"; return; }
            for (const name of names) {
                const row = el("div", "display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);");
                const span = el("span", `flex:1;cursor:pointer;color:${T.text};font-size:12px;border-radius:3px;padding:1px 4px;`, { textContent: name });
                span.onmouseenter = () => span.style.background = T.btnHover;
                span.onmouseleave = () => span.style.background = "transparent";
                span.onclick = () => applyPreset(name);
                const del = el("span", `cursor:pointer;margin-left:8px;font-size:12px;opacity:0.6;color:${T.dangerText};`, { textContent: "✕", title: "Delete preset" });
                del.onmouseenter = () => del.style.opacity = "1";
                del.onmouseleave = () => del.style.opacity = "0.6";
                del.onclick = async (e) => {
                    e.stopPropagation();
                    try {
                        const r = await postJSON("/pw_outpaint/delete_preset", { name });
                        if (r.ok) ui.loadBtn.click();
                    } catch { /* ignore */ }
                };
                row.append(span, del);
                ui.listOverlay.appendChild(row);
            }
        } catch {
            ui.listOverlay.textContent = "Error loading";
        }
    });

    document.addEventListener("click", (e) => {
        if (!ui.listOverlay?.contains(e.target) && !ui.loadBtn?.contains(e.target)) ui.listOverlay.style.display = "none";
        if (!ui.namePanel?.contains(e.target) && e.target !== ui.saveBtn) ui.namePanel.style.display = "none";
    });
}

function wireSession(ui, ensureNodeFits) {
    const { st, node } = ui;

    const stopHeartbeat = () => {
        if (ui.heartbeat) { clearInterval(ui.heartbeat); ui.heartbeat = null; }
    };
    const startHeartbeat = () => {
        stopHeartbeat();
        ui.heartbeat = setInterval(() => {
            postJSON("/pw_outpaint/heartbeat", { node_id: String(node.id) }).catch(() => {});
        }, 3000);
    };

    const onShow = (event) => {
        const data = event.detail || event;
        if (String(data.node_id) !== String(node.id)) return;
        pullFromWidgets(st, ui);
        st.srcW = data.image_width;
        st.srcH = data.image_height;
        st.waiting = true;
        st.batch = false;
        st.armed = false;
        setBtnOn(ui.batchBtn, false);
        ui.batchBtn.textContent = "Batch off";
        setActionsVisible(ui, true);
        ensureNodeFits();
        const img = new Image();
        img.onload = () => {
            st.img = img;
            fitView(st, ui.canvas.clientWidth, ui.canvas.clientHeight);
            repaint(ui);
        };
        img.src = api.apiURL(`/view?filename=pw_outpaint_${data.node_id}.png&type=temp&subfolder=pw_outpaint&t=${Date.now()}`);
        startHeartbeat();
        repaint(ui);
    };
    api.addEventListener("pw_outpaint.show", onShow);

    ui.batchBtn.addEventListener("click", async () => {
        st.batch = !st.batch;
        setBtnOn(ui.batchBtn, st.batch);
        ui.batchBtn.textContent = st.batch ? "Batch on" : "Batch off";
        if (st.armed) {
            // toggling after arming enables/disables the stored frame server-side
            try { await postJSON("/pw_outpaint/batch_toggle", { node_id: String(node.id), enabled: st.batch }); } catch { }
            if (!st.batch) { st.armed = false; setActionsVisible(ui, st.waiting); }
            repaint(ui);
        }
    });

    ui.acceptBtn.addEventListener("click", async () => {
        ui.acceptBtn.textContent = "Sending...";
        ui.acceptBtn.disabled = true;
        try {
            const resp = await postJSON("/pw_outpaint/decision", {
                node_id: String(node.id),
                decision: "accept",
                pads: { ...st.pads },
                style: { ...st.colors },
                batch_mode: st.batch,
            });
            if (resp.ok) {
                stopHeartbeat();
                st.waiting = false;
                st.armed = st.batch;
                setActionsVisible(ui, false);
                ensureNodeFits();
            }
        } catch (err) {
            console.error("PW Outpaint accept failed:", err);
        }
        ui.acceptBtn.textContent = "Accept";
        ui.acceptBtn.disabled = false;
        repaint(ui);
    });

    ui.cancelBtn.addEventListener("click", async () => {
        stopHeartbeat();
        st.waiting = false;
        st.batch = false;
        st.armed = false;
        setActionsVisible(ui, false);
        try { await postJSON("/pw_outpaint/decision", { node_id: String(node.id), decision: "cancel" }); } catch { }
        repaint(ui);
    });

    liveNodes.push(ui);

    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        stopHeartbeat();
        api.removeEventListener("pw_outpaint.show", onShow);
        liveNodes = liveNodes.filter((entry) => entry.node !== node);
        postJSON("/pw_outpaint/clear_preset", { node_id: String(node.id) }).catch(() => {});
        postJSON("/pw_outpaint/cleanup", { node_id: String(node.id) }).catch(() => {});
        if (origOnRemoved) origOnRemoved.call(this);
    };

    return { stopHeartbeat };
}

// reset batch state once the queue finishes
api.addEventListener("status", (e) => {
    const remaining = e.detail?.exec_info?.queue_remaining;
    if (remaining > 0) {
        queueWasRunning = true;
        if (batchResetTimer) { clearTimeout(batchResetTimer); batchResetTimer = null; }
    } else if (remaining === 0 && queueWasRunning) {
        queueWasRunning = false;
        if (batchResetTimer) return;
        batchResetTimer = setTimeout(() => {
            for (const ui of liveNodes) {
                if (!ui.st.armed && !ui.st.batch) continue;
                ui.st.batch = false;
                ui.st.armed = false;
                setBtnOn(ui.batchBtn, false);
                ui.batchBtn.textContent = "Batch off";
                setActionsVisible(ui, false);
                postJSON("/pw_outpaint/clear_preset", { node_id: String(ui.node.id) }).catch(() => {});
                ui.statusText.textContent = "Batch complete";
                repaint(ui);
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

            const ui = buildEditor(node);
            const { st } = ui;

            // the editor owns these; hide their native widget rows
            for (const w of [ui.w.padL, ui.w.padT, ui.w.padR, ui.w.padB, ui.w.style]) hideWidget(w);
            if (node.inputs) {
                for (let i = node.inputs.length - 1; i >= 0; i--) {
                    if (["pad_left", "pad_top", "pad_right", "pad_bottom", "style_state"].includes(node.inputs[i].name)) {
                        node.removeInput(i);
                    }
                }
            }
            pullFromWidgets(st, ui);

            const domWidget = node.addDOMWidget("pw_outpaint_editor", "custom", ui.root, { serialize: false, hideOnZoom: false });
            domWidget.computeSize = () => [520, EDITOR_H + (st.waiting || st.armed ? ACTIVE_H : REST_H)];

            const ensureNodeFits = () => {
                const cs = node.computeSize();
                node.setSize([Math.max(node.size[0], 540), Math.max(node.size[1], cs[1])]);
                node.graph?.setDirtyCanvas(true, true);
            };
            ensureNodeFits();
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (...args) {
                const r = origOnConfigure?.apply(this, args);
                requestAnimationFrame(() => {
                    pullFromWidgets(st, ui);
                    ensureNodeFits();
                    repaint(ui);
                });
                return r;
            };

            wireEditor(ui);
            wirePresets(ui);
            wireSession(ui, ensureNodeFits);

            requestAnimationFrame(() => requestAnimationFrame(() => repaint(ui)));
            return result;
        };
    },
});
