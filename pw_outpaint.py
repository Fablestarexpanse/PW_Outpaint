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
_GRACE_SECONDS = 10.0
_POLL_SECONDS = 0.25

_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
_PRESET_DIR = os.path.join(_NODE_DIR, "presets")

_DEFAULT_STYLE = {"mask": "#ff0000", "bg": "#141414", "fill": "#808080"}


# ---------------------------------------------------------------------------
# pause sessions
# ---------------------------------------------------------------------------

class _Session:
    """One paused execution waiting for a verdict from the editor."""

    __slots__ = ("event", "verdict", "pads", "style", "batch", "last_seen")

    def __init__(self):
        self.event = threading.Event()
        self.verdict = None   # "accept" | "cancel" | "detach"
        self.pads = None      # {"l":int,"t":int,"r":int,"b":int}
        self.style = None     # {"mask":hex,"bg":hex,"fill":hex}
        self.batch = False
        self.last_seen = time.time()


_SESSIONS = {}   # node_id -> _Session
_BATCH = {}      # node_id -> {"pads":..., "style":..., "active":bool}


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

def _mirror_index(idx, n):
    """Fold out-of-range indices back into [0, n) by reflection."""
    if n <= 1:
        return np.zeros_like(idx)
    period = 2 * n - 2
    folded = np.mod(idx, period)
    return np.where(folded >= n, period - folded, folded)


def _fill_canvas(src_np, pads, mode, fill_rgb):
    """Build the output canvas with the requested fill for the new area."""
    batch, src_h, src_w, _ = src_np.shape
    out_h = src_h + pads["t"] + pads["b"]
    out_w = src_w + pads["l"] + pads["r"]

    if mode == "edge_extend":
        rows = np.clip(np.arange(out_h) - pads["t"], 0, src_h - 1)
        cols = np.clip(np.arange(out_w) - pads["l"], 0, src_w - 1)
        return src_np[:, rows][:, :, cols].copy()

    if mode == "mirror_blur":
        rows = _mirror_index(np.arange(out_h) - pads["t"], src_h)
        cols = _mirror_index(np.arange(out_w) - pads["l"], src_w)
        canvas = src_np[:, rows][:, :, cols].copy()
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


def _refine_mask(hard_mask, expand, feather):
    """Optionally dilate the mask into the image, then soften the seam."""
    mask = hard_mask
    if expand > 0:
        t = torch.from_numpy(mask)[None, None]
        t = TF.max_pool2d(t, kernel_size=2 * expand + 1, stride=1, padding=expand)
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
    name = f"pw_outpaint_{node_id}.png"
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

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "INT", "INT")
    RETURN_NAMES = ("control_image", "control_mask", "mask_image", "width", "height")
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
        batch, src_h, src_w, _ = src.shape
        if src_w < _MIN_DIM or src_h < _MIN_DIM:
            raise ValueError(f"PW Outpaint: input image too small ({src_w}x{src_h}).")

        node_id = str(unique_id)
        pads = _clean_pads({"l": pad_left, "t": pad_top, "r": pad_right, "b": pad_bottom}, None)
        style = _parse_style_state(style_state)

        remembered = _BATCH.get(node_id, {})
        if remembered.get("active"):
            pads = _clean_pads(remembered.get("pads"), pads)
            style = _clean_style(remembered.get("style") or style)
        else:
            _BATCH.pop(node_id, None)
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
        mask_image = torch.from_numpy(colorized.clip(0.0, 1.0)).unsqueeze(0)

        return (control_image, control_mask, mask_image, out_w, out_h)

    def _await_editor(self, frame, node_id):
        """Publish the frame to the editor and wait for its verdict.

        Returns the finished _Session, or None when no editor responded within
        the grace period (headless runs, closed tab, node deleted).
        """
        session = _Session()
        _SESSIONS[node_id] = session
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
                if time.time() - session.last_seen > _GRACE_SECONDS:
                    return None
        finally:
            _SESSIONS.pop(node_id, None)


NODE_CLASS_MAPPINGS = {"PWOutpaint": PWOutpaint}
NODE_DISPLAY_NAME_MAPPINGS = {"PWOutpaint": "PW Outpaint"}


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

routes = server.PromptServer.instance.routes


def _preset_path(name):
    clean = "".join(c for c in str(name or "") if c.isalnum() or c in " _-").strip()
    return os.path.join(_PRESET_DIR, f"{clean}.json") if clean else None


@routes.post("/pw_outpaint/decision")
async def pw_decision(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id"))
        session = _SESSIONS.get(node_id)
        if session is None:
            return web.Response(status=404, text="Not waiting")
        decision = data.get("decision")
        if decision == "accept":
            session.verdict = "accept"
            session.pads = data.get("pads")
            session.style = data.get("style")
            session.batch = bool(data.get("batch_mode", False))
            if session.batch and session.pads:
                _BATCH[node_id] = {"pads": session.pads, "style": session.style, "active": True}
        elif decision == "cancel":
            session.verdict = "cancel"
            _BATCH.pop(node_id, None)
        else:
            return web.Response(status=400, text="Unknown decision")
        session.event.set()
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/heartbeat")
async def pw_heartbeat(request):
    try:
        data = await request.json()
        session = _SESSIONS.get(str(data.get("node_id")))
        if session is None:
            return web.Response(status=404, text="Not found")
        session.last_seen = time.time()
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/cleanup")
async def pw_cleanup(request):
    try:
        data = await request.json()
        session = _SESSIONS.get(str(data.get("node_id")))
        if session is not None:
            session.verdict = "detach"
            session.event.set()
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/batch_toggle")
async def pw_batch_toggle(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id"))
        enabled = bool(data.get("enabled", False))
        if node_id in _BATCH:
            _BATCH[node_id]["active"] = enabled
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/clear_preset")
async def pw_clear_preset(request):
    try:
        data = await request.json()
        _BATCH.pop(str(data.get("node_id")), None)
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/save_preset")
async def pw_save_preset(request):
    try:
        data = await request.json()
        path = _preset_path(data.get("name"))
        if not path:
            return web.Response(status=400, text="Name required")
        os.makedirs(_PRESET_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data.get("preset_data", {}), fh, indent=2)
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/list_presets")
async def pw_list_presets(request):
    try:
        names = []
        if os.path.isdir(_PRESET_DIR):
            names = sorted(f[:-5] for f in os.listdir(_PRESET_DIR) if f.endswith(".json"))
        return web.json_response(names)
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/load_preset")
async def pw_load_preset(request):
    try:
        data = await request.json()
        path = _preset_path(data.get("name"))
        if path and os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                return web.json_response(json.load(fh))
        return web.Response(status=404, text="Preset not found")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/delete_preset")
async def pw_delete_preset(request):
    try:
        data = await request.json()
        path = _preset_path(data.get("name"))
        if path and os.path.isfile(path):
            os.remove(path)
            return web.Response(status=200, text="OK")
        return web.Response(status=404, text="Preset not found")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))
