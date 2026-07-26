"""PW Outpaint - interactive outpaint framing node for ComfyUI.

Pauses the workflow so the user can extend the canvas around the live image,
then emits the padded control image, mask, and dimensions for inpaint/outpaint
pipelines (Flux.2 Klein, Qwen Image Edit, SDXL inpaint, ...).

The frame is expressed as four paddings (left/top/right/bottom) around the
source image. The paddings are ordinary node widgets, so the node also works
headlessly: with no browser attached, the run continues after a short grace
period using whatever paddings are stored on the node.
"""

import json
import os
import re
import threading
import time

import numpy as np
import torch
import torch.nn.functional as TF
from PIL import Image, ImageFilter
from aiohttp import web

import comfy.model_management as mm
import folder_paths
import server

_MIN_DIM = 32
_MAX_PAD = 8192
# Headless runs continue quickly; once a browser has checked in we wait much
# longer, because hidden-tab timer throttling can stretch heartbeats past 60s.
_GRACE_HEADLESS = 15.0
_GRACE_ATTACHED = 90.0
_POLL_SECONDS = 0.25

_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
_PRESET_DIR = os.path.join(_NODE_DIR, "presets")

_DEFAULT_STYLE = {"mask": "#ff0000", "bg": "#141414", "fill": "#808080"}


# ---------------------------------------------------------------------------
# pause sessions
# ---------------------------------------------------------------------------

class _Session:
    """One paused execution waiting for a verdict from the editor."""

    __slots__ = ("event", "verdict", "pads", "style", "batch", "last_seen", "closed", "attached")

    def __init__(self):
        self.event = threading.Event()
        self.verdict = None   # "accept" | "cancel" | "detach"
        self.pads = None      # {"l":int,"t":int,"r":int,"b":int}
        self.style = None     # {"mask":hex,"bg":hex,"fill":hex}
        self.batch = False
        self.last_seen = time.time()
        self.closed = False   # set when the execution thread stops listening
        self.attached = False  # a browser has heartbeated at least once


_STATE_LOCK = threading.Lock()
_SESSIONS = {}   # node_id -> _Session
_BATCH = {}      # node_id -> {"pads":..., "style":..., "active":bool, "ts":float}
_BATCH_TTL = 3600.0  # forget remembered frames after an hour of disuse


def _open_session(node_id, session):
    with _STATE_LOCK:
        _SESSIONS[node_id] = session


def _close_session(node_id, session):
    with _STATE_LOCK:
        session.closed = True
        if _SESSIONS.get(node_id) is session:
            del _SESSIONS[node_id]


def _live_session(node_id):
    """Fetch the session for a node if the execution thread still listens."""
    with _STATE_LOCK:
        session = _SESSIONS.get(node_id)
        return session if session is not None and not session.closed else None


def _hex_rgb(value, fallback):
    try:
        value = str(value).lstrip("#")
        return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except Exception:
        return fallback


def _clean_pads(raw, fallback):
    try:
        return {k: max(0, min(_MAX_PAD, int(raw[k]))) for k in ("l", "t", "r", "b")}
    except Exception:
        return fallback


def _clean_style(raw):
    style = dict(_DEFAULT_STYLE)
    if isinstance(raw, dict):
        for key in style:
            if isinstance(raw.get(key), str):
                style[key] = raw[key]
    return style


def _parse_style_state(text):
    try:
        return _clean_style(json.loads(text))
    except Exception:
        return dict(_DEFAULT_STYLE)


# ---------------------------------------------------------------------------
# image composition
# ---------------------------------------------------------------------------

def _pad_spec(pads):
    return ((0, 0), (pads["t"], pads["b"]), (pads["l"], pads["r"]), (0, 0))


def _fill_canvas(src_np, pads, mode, fill_rgb):
    """Build the output canvas with the requested fill for the new area."""
    batch, src_h, src_w, _ = src_np.shape
    out_h = src_h + pads["t"] + pads["b"]
    out_w = src_w + pads["l"] + pads["r"]

    if mode == "edge_extend":
        return np.pad(src_np, _pad_spec(pads), mode="edge")

    if mode == "mirror_blur":
        canvas = np.pad(src_np, _pad_spec(pads), mode="reflect" if src_h > 1 and src_w > 1 else "edge")
        radius = float(np.clip(0.05 * max(out_w, out_h), 8, 64))
        for i in range(batch):
            frame = Image.fromarray((canvas[i] * 255).clip(0, 255).astype(np.uint8))
            canvas[i] = np.asarray(frame.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
        return canvas

    if mode == "solid_color":
        canvas = np.empty((batch, out_h, out_w, 3), dtype=np.float32)
        canvas[:] = np.asarray(fill_rgb, dtype=np.float32)
        return canvas

    if mode == "noise":
        rng = np.random.default_rng()
        return rng.normal(0.5, 0.18, size=(batch, out_h, out_w, 3)).astype(np.float32).clip(0.0, 1.0)

    return np.full((batch, out_h, out_w, 3), 0.5, dtype=np.float32)  # gray


def _compose(src_np, pads, fill_mode, fill_rgb):
    """Return (canvas [B,H,W,3], hard mask [H,W]) for the padded frame."""
    _, src_h, src_w, _ = src_np.shape
    canvas = _fill_canvas(src_np, pads, fill_mode, fill_rgb)
    mask = np.ones(canvas.shape[1:3], dtype=np.float32)
    top, left = pads["t"], pads["l"]
    canvas[:, top:top + src_h, left:left + src_w] = src_np
    mask[top:top + src_h, left:left + src_w] = 0.0
    return canvas, mask


def _diff_mask(pads, src_w, src_h, expand, feather):
    """Gradient mask for DifferentialDiffusion: 1.0 over new padding, a smooth
    ramp across the repaint ring, exactly 0.0 over the untouched interior.

    The ramp uses smoothstep rather than linear so there is no derivative
    discontinuity at either end of the ring. When mask_expand is 0 we still
    ramp over max(mask_feather, 8) px - a hard binary edge would make
    DifferentialDiffusion a no-op.
    """
    out_h = src_h + pads["t"] + pads["b"]
    out_w = src_w + pads["l"] + pads["r"]
    ring = expand if expand > 0 else max(feather, 8)

    # distance (in px) of each source pixel from the nearest padded edge
    xs = np.arange(src_w, dtype=np.float32)
    ys = np.arange(src_h, dtype=np.float32)
    dist = np.full((src_h, src_w), np.inf, dtype=np.float32)
    if pads["l"] > 0:
        dist = np.minimum(dist, xs[None, :])
    if pads["r"] > 0:
        dist = np.minimum(dist, (src_w - 1 - xs)[None, :])
    if pads["t"] > 0:
        dist = np.minimum(dist, ys[:, None] + np.zeros((1, src_w), dtype=np.float32))
    if pads["b"] > 0:
        dist = np.minimum(dist, (src_h - 1 - ys)[:, None] + np.zeros((1, src_w), dtype=np.float32))

    t = np.clip(1.0 - dist / float(ring), 0.0, 1.0)
    ramp = t * t * (3.0 - 2.0 * t)  # smoothstep

    mask = np.ones((out_h, out_w), dtype=np.float32)
    mask[pads["t"]:pads["t"] + src_h, pads["l"]:pads["l"] + src_w] = ramp
    return mask


def _refine_mask(hard_mask, expand, feather):
    """Optionally dilate the mask into the image, then soften the seam."""
    mask = hard_mask
    if expand > 0:
        # square dilation is separable: two 1D max-pools instead of one k x k pool
        k = 2 * expand + 1
        t = torch.from_numpy(mask)[None, None]
        t = TF.max_pool2d(t, kernel_size=(k, 1), stride=1, padding=(expand, 0))
        t = TF.max_pool2d(t, kernel_size=(1, k), stride=1, padding=(0, expand))
        mask = t[0, 0].numpy()
    if feather > 0:
        blurred = Image.fromarray((mask * 255).clip(0, 255).astype(np.uint8))
        blurred = blurred.filter(ImageFilter.GaussianBlur(feather))
        soft = np.asarray(blurred, dtype=np.float32) / 255.0
        # Fully-new pixels stay solid; the ramp only reaches into the image side.
        mask = np.maximum(soft, hard_mask)
    return mask.astype(np.float32)


def _publish_preview(frame, node_id):
    arr = (frame.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    subfolder = "pw_outpaint"
    out_dir = os.path.join(folder_paths.get_temp_directory(), subfolder)
    os.makedirs(out_dir, exist_ok=True)
    # subgraph unique_ids look like "103:92" - ':' is not a legal filename char
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", node_id)
    name = f"pw_outpaint_{safe_id}.png"
    img.save(os.path.join(out_dir, name))
    return f"/view?filename={name}&type=temp&subfolder={subfolder}", img.width, img.height


# ---------------------------------------------------------------------------
# node
# ---------------------------------------------------------------------------

class PWOutpaint:
    @classmethod
    def INPUT_TYPES(cls):
        pad = {"default": 0, "min": 0, "max": _MAX_PAD, "step": 8}
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Source image."}),
                "grid_snap": (["8", "16", "32", "64"], {
                    "default": "16",
                    "tooltip": "Snap step for the editor. 16 suits Flux.2/Klein; 8 suits SD1.5/SDXL."}),
                "fill_mode": (["gray", "solid_color", "edge_extend", "mirror_blur", "noise"], {
                    "default": "gray",
                    "tooltip": "How the new (outpainted) area of the control image is filled."}),
                "mask_feather": ("INT", {
                    "default": 0, "min": 0, "max": 256, "step": 1,
                    "tooltip": "Gaussian feather radius (px) applied to the mask seam."}),
                "mask_expand": ("INT", {
                    "default": 0, "min": 0, "max": 256, "step": 1,
                    "tooltip": "Grow the mask this many px into the original image for blending overlap."}),
                "pad_left": ("INT", {**pad, "tooltip": "New pixels added left of the image."}),
                "pad_top": ("INT", {**pad, "tooltip": "New pixels added above the image."}),
                "pad_right": ("INT", {**pad, "tooltip": "New pixels added right of the image."}),
                "pad_bottom": ("INT", {**pad, "tooltip": "New pixels added below the image."}),
                "style_state": ("STRING", {"default": "", "tooltip": "Editor colors (managed by the UI)."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "INT", "INT", "PW_FRAME", "MASK")
    RETURN_NAMES = ("control_image", "control_mask", "mask_image", "width", "height", "frame", "diff_mask")
    FUNCTION = "outpaint"
    OUTPUT_NODE = True
    CATEGORY = "Promptwaffle"
    DESCRIPTION = ("Interactive outpaint framing: pauses the run so you can extend the canvas "
                   "around the live image, then outputs control image + mask + dimensions.")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def outpaint(self, image, grid_snap, fill_mode, mask_feather, mask_expand,
                 pad_left, pad_top, pad_right, pad_bottom, style_state, unique_id):
        src = image if image.dim() == 4 else image.unsqueeze(0)
        if src.shape[-1] == 1:
            src = src.repeat(1, 1, 1, 3)
        src = src[..., :3]  # drop alpha; the compose pipeline is RGB
        batch, src_h, src_w, _ = src.shape
        if src_w < _MIN_DIM or src_h < _MIN_DIM:
            raise ValueError(f"PW Outpaint: input image too small ({src_w}x{src_h}).")

        node_id = str(unique_id)
        pads = _clean_pads({"l": pad_left, "t": pad_top, "r": pad_right, "b": pad_bottom}, None)
        style = _parse_style_state(style_state)

        with _STATE_LOCK:
            remembered = _BATCH.get(node_id)
            if remembered and time.time() - remembered.get("ts", 0) > _BATCH_TTL:
                del _BATCH[node_id]
                remembered = None
            batch_active = bool(remembered and remembered.get("active"))
            if batch_active:
                remembered["ts"] = time.time()
                remembered = dict(remembered)

        if batch_active:
            pads = _clean_pads(remembered.get("pads"), pads)
            style = _clean_style(remembered.get("style") or style)
        else:
            verdict = self._await_editor(src[0], node_id)
            if verdict is not None:
                if verdict.verdict == "cancel":
                    raise mm.InterruptProcessingException()
                if verdict.verdict == "accept":
                    pads = _clean_pads(verdict.pads, pads)
                    style = _clean_style(verdict.style or style)
                # "detach" / grace timeout: fall through with widget values

        src_np = src.cpu().numpy().astype(np.float32)
        canvas, hard_mask = _compose(src_np, pads, fill_mode,
                                     _hex_rgb(style["fill"], (0.5, 0.5, 0.5)))
        mask = _refine_mask(hard_mask, int(mask_expand), int(mask_feather))

        out_h, out_w = mask.shape
        control_image = torch.from_numpy(canvas)
        control_mask = torch.from_numpy(mask).unsqueeze(0).repeat(batch, 1, 1)

        mask_rgb = np.asarray(_hex_rgb(style["mask"], (1.0, 0.0, 0.0)), dtype=np.float32)
        bg_rgb = np.asarray(_hex_rgb(style["bg"], (0.08, 0.08, 0.08)), dtype=np.float32)
        colorized = mask[..., None] * mask_rgb + (1.0 - mask[..., None]) * bg_rgb
        mask_image = torch.from_numpy(colorized.clip(0.0, 1.0)).unsqueeze(0).repeat(batch, 1, 1, 1)

        diff = _diff_mask(pads, src_w, src_h, int(mask_expand), int(mask_feather))
        diff_mask = torch.from_numpy(diff).unsqueeze(0).repeat(batch, 1, 1)

        frame_info = {"pads": dict(pads), "src_w": src_w, "src_h": src_h}
        return (control_image, control_mask, mask_image, out_w, out_h, frame_info, diff_mask)

    def _await_editor(self, frame, node_id):
        """Publish the frame to the editor and wait for its verdict.

        Returns the finished _Session, or None when no editor responded within
        the grace period (headless runs, closed tab, node deleted).
        """
        session = _Session()
        _open_session(node_id, session)
        try:
            try:
                url, width, height = _publish_preview(frame, node_id)
                server.PromptServer.instance.send_sync("pw_outpaint.show", {
                    "node_id": node_id,
                    "image_url": url,
                    "image_width": width,
                    "image_height": height,
                })
            except Exception:
                pass

            while True:
                mm.throw_exception_if_processing_interrupted()
                if session.event.wait(_POLL_SECONDS):
                    return session
                grace = _GRACE_ATTACHED if session.attached else _GRACE_HEADLESS
                if time.time() - session.last_seen > grace:
                    return None
        finally:
            _close_session(node_id, session)


NODE_CLASS_MAPPINGS = {"PWOutpaint": PWOutpaint}
NODE_DISPLAY_NAME_MAPPINGS = {"PWOutpaint": "PW Outpaint"}


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

routes = server.PromptServer.instance.routes

_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL",
                   *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
_MAX_PRESET_BYTES = 16384


def _preset_path(name):
    clean = "".join(c for c in str(name or "") if c.isalnum() or c in " _-").strip()
    if not clean or clean.upper() in _RESERVED_NAMES:
        return None
    return os.path.join(_PRESET_DIR, f"{clean}.json")


async def _body(request):
    try:
        data = await request.json()
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _fail(status, text):
    return web.Response(status=status, text=text)


@routes.post("/pw_outpaint/decision")
async def pw_decision(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    node_id = str(data.get("node_id"))
    decision = data.get("decision")
    if decision not in ("accept", "cancel"):
        return _fail(400, "Unknown decision")
    with _STATE_LOCK:
        session = _SESSIONS.get(node_id)
        if session is None or session.closed or session.event.is_set():
            return _fail(409, "No pending pause")
        if decision == "accept":
            session.verdict = "accept"
            session.pads = data.get("pads")
            session.style = data.get("style")
            session.batch = bool(data.get("batch_mode", False))
            if session.batch and session.pads:
                _BATCH[node_id] = {"pads": session.pads, "style": session.style,
                                   "active": True, "ts": time.time()}
        else:
            session.verdict = "cancel"
            _BATCH.pop(node_id, None)
        session.event.set()
    return web.Response(status=200, text="OK")


@routes.post("/pw_outpaint/heartbeat")
async def pw_heartbeat(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    session = _live_session(str(data.get("node_id")))
    if session is None:
        return _fail(404, "Not found")
    session.last_seen = time.time()
    session.attached = True
    return web.Response(status=200, text="OK")


@routes.post("/pw_outpaint/cleanup")
async def pw_cleanup(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    with _STATE_LOCK:
        session = _SESSIONS.get(str(data.get("node_id")))
        if session is not None and not session.closed and not session.event.is_set():
            session.verdict = "detach"
            session.event.set()
    return web.Response(status=200, text="OK")


@routes.post("/pw_outpaint/batch_toggle")
async def pw_batch_toggle(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    node_id = str(data.get("node_id"))
    enabled = bool(data.get("enabled", False))
    with _STATE_LOCK:
        if node_id in _BATCH:
            _BATCH[node_id]["active"] = enabled
            _BATCH[node_id]["ts"] = time.time()
    return web.Response(status=200, text="OK")


@routes.post("/pw_outpaint/clear_preset")
async def pw_clear_preset(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    with _STATE_LOCK:
        _BATCH.pop(str(data.get("node_id")), None)
    return web.Response(status=200, text="OK")


@routes.post("/pw_outpaint/save_preset")
async def pw_save_preset(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    path = _preset_path(data.get("name"))
    if not path:
        return _fail(400, "Invalid name")
    preset = data.get("preset_data")
    if not isinstance(preset, dict):
        return _fail(400, "Invalid preset")
    payload = json.dumps(preset, indent=2)
    if len(payload) > _MAX_PRESET_BYTES:
        return _fail(400, "Preset too large")
    try:
        os.makedirs(_PRESET_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(payload)
        return web.Response(status=200, text="OK")
    except Exception:
        return _fail(500, "Save failed")


@routes.post("/pw_outpaint/list_presets")
async def pw_list_presets(request):
    try:
        names = []
        if os.path.isdir(_PRESET_DIR):
            names = sorted(f[:-5] for f in os.listdir(_PRESET_DIR) if f.endswith(".json"))
        return web.json_response(names)
    except Exception:
        return _fail(500, "List failed")


@routes.post("/pw_outpaint/load_preset")
async def pw_load_preset(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    path = _preset_path(data.get("name"))
    try:
        if path and os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                return web.json_response(json.load(fh))
        return _fail(404, "Preset not found")
    except Exception:
        return _fail(500, "Load failed")


@routes.post("/pw_outpaint/delete_preset")
async def pw_delete_preset(request):
    data = await _body(request)
    if data is None:
        return _fail(400, "Bad request")
    path = _preset_path(data.get("name"))
    try:
        if path and os.path.isfile(path):
            os.remove(path)
            return web.Response(status=200, text="OK")
        return _fail(404, "Preset not found")
    except Exception:
        return _fail(500, "Delete failed")
