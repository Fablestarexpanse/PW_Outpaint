"""PW Outpaint - interactive outpaint mask node for ComfyUI.

Pauses the workflow so the user can position an outpaint frame on the live
image, then emits the padded control image, mask, and dimensions for
inpaint/outpaint pipelines (Flux.2 Klein, Qwen Image Edit, SDXL inpaint, ...).

Inspired by RS Outpaint from ComfyUI_RaykoStudio
(https://github.com/Raykosan/ComfyUI_RaykoStudio), Copyright 2025-2026
Raykosan (RaykoStudio), Apache License 2.0.
"""

import json
import os
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
_DEFAULT_PAD_FACTOR = 0.3
_HEARTBEAT_TIMEOUT = 10.0
_POLL_INTERVAL = 0.2

_PENDING = {}
_SAVED_PRESETS = {}

_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
_PRESET_DIR = os.path.join(_NODE_DIR, "presets")

_DEFAULT_STATE = {
    "x": 0, "y": 0, "w": 0, "h": 0,
    "maskColor": "#ff0000",
    "bgColor": "#141414",
    "fillColor": "#808080",
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _tensor_hash(frame):
    try:
        arr = (frame.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        return hash(arr.tobytes())
    except Exception:
        return None


def _hex_to_rgb(value, fallback=(1.0, 0.0, 0.0)):
    try:
        value = value.lstrip("#")
        return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except Exception:
        return fallback


def _parse_state(crop_state):
    """crop_state is a JSON blob owned by the frontend widget."""
    state = dict(_DEFAULT_STATE)
    if not crop_state:
        return state
    try:
        data = json.loads(crop_state)
        if isinstance(data, dict):
            for key in state:
                if key in data:
                    state[key] = data[key]
        for key in ("x", "y", "w", "h"):
            state[key] = int(state[key])
    except Exception:
        return dict(_DEFAULT_STATE)
    return state


def _adapt_state_to_size(state, new_w, new_h, grid):
    """Clamp a saved crop so it stays sane when batch mode meets a new image size."""
    adapted = dict(state)
    adapted["x"] = max(-new_w, min(adapted["x"], new_w - grid))
    adapted["y"] = max(-new_h, min(adapted["y"], new_h - grid))
    adapted["w"] = max(grid, min(adapted["w"], new_w * 2))
    adapted["h"] = max(grid, min(adapted["h"], new_h * 2))
    return adapted


def _default_crop(src_w, src_h, grid):
    """No user input yet: extend the canvas upward by ~30%, snapped to grid."""
    pad = max(grid, round(src_h * _DEFAULT_PAD_FACTOR / grid) * grid)
    return {
        "x": 0,
        "y": -pad,
        "w": max(grid, round(src_w / grid) * grid),
        "h": max(grid, round((src_h + pad) / grid) * grid),
    }


def _reflect_index(idx, n):
    """Mirror out-of-range indices back into [0, n) (reflect without edge repeat)."""
    if n <= 1:
        return np.zeros_like(idx)
    period = 2 * n - 2
    m = np.mod(idx, period)
    return np.where(m >= n, period - m, m)


def _build_canvas(src_np, crop, fill_mode, fill_color):
    """Return (canvas [B,H,W,3] float32, hard mask [H,W] float32 1=new area)."""
    batch, src_h, src_w, _ = src_np.shape
    cx, cy, cw, ch = crop["x"], crop["y"], crop["w"], crop["h"]

    ys = np.arange(ch) + cy
    xs = np.arange(cw) + cx

    if fill_mode == "edge_extend":
        canvas = src_np[:, np.clip(ys, 0, src_h - 1)][:, :, np.clip(xs, 0, src_w - 1)].copy()
    elif fill_mode == "mirror_blur":
        canvas = src_np[:, _reflect_index(ys, src_h)][:, :, _reflect_index(xs, src_w)].copy()
        radius = float(np.clip(0.05 * max(cw, ch), 8, 64))
        for b in range(batch):
            img = Image.fromarray((canvas[b] * 255).clip(0, 255).astype(np.uint8))
            canvas[b] = np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
    elif fill_mode == "solid_color":
        canvas = np.empty((batch, ch, cw, 3), dtype=np.float32)
        canvas[:] = np.asarray(fill_color, dtype=np.float32)
    elif fill_mode == "noise":
        rng = np.random.default_rng()
        canvas = rng.normal(0.5, 0.18, size=(batch, ch, cw, 3)).astype(np.float32).clip(0.0, 1.0)
    else:  # gray
        canvas = np.full((batch, ch, cw, 3), 0.5, dtype=np.float32)

    mask = np.ones((ch, cw), dtype=np.float32)

    # Paste the sharp source into the overlapping region.
    dst_y0, dst_y1 = max(0, -cy), min(ch, src_h - cy)
    dst_x0, dst_x1 = max(0, -cx), min(cw, src_w - cx)
    if dst_y1 > dst_y0 and dst_x1 > dst_x0:
        src_y0, src_x0 = dst_y0 + cy, dst_x0 + cx
        canvas[:, dst_y0:dst_y1, dst_x0:dst_x1] = \
            src_np[:, src_y0:src_y0 + (dst_y1 - dst_y0), src_x0:src_x0 + (dst_x1 - dst_x0)]
        mask[dst_y0:dst_y1, dst_x0:dst_x1] = 0.0

    return canvas, mask


def _process_mask(hard_mask, expand, feather):
    """Dilate the new-area mask into the original image, then feather the seam."""
    mask = hard_mask
    if expand > 0:
        t = torch.from_numpy(mask)[None, None]
        t = TF.max_pool2d(t, kernel_size=2 * expand + 1, stride=1, padding=expand)
        mask = t[0, 0].numpy()
    if feather > 0:
        img = Image.fromarray((mask * 255).clip(0, 255).astype(np.uint8))
        img = img.filter(ImageFilter.GaussianBlur(feather))
        blurred = np.asarray(img, dtype=np.float32) / 255.0
        # Fully-new pixels stay 1.0; the ramp only bleeds toward the original side.
        mask = np.maximum(blurred, hard_mask)
    return mask.astype(np.float32)


def _save_preview(frame, unique_id):
    arr = (frame.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    subfolder = "pw_outpaint"
    out_dir = os.path.join(folder_paths.get_temp_directory(), subfolder)
    os.makedirs(out_dir, exist_ok=True)
    filename = f"pw_outpaint_{unique_id}.png"
    img.save(os.path.join(out_dir, filename))
    return f"/view?filename={filename}&type=temp&subfolder={subfolder}", img.width, img.height


# ---------------------------------------------------------------------------
# node
# ---------------------------------------------------------------------------

class PWOutpaint:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Source image."}),
                "grid_snap": (["8", "16", "32", "64"], {
                    "default": "16",
                    "tooltip": "Snap grid in pixels. 16 suits Flux.2/Klein; 8 suits SD1.5/SDXL."}),
                "fill_mode": (["gray", "solid_color", "edge_extend", "mirror_blur", "noise"], {
                    "default": "gray",
                    "tooltip": "How the new (outpainted) area of the control image is filled."}),
                "mask_feather": ("INT", {
                    "default": 0, "min": 0, "max": 256, "step": 1,
                    "tooltip": "Gaussian feather radius (px) applied to the mask seam."}),
                "mask_expand": ("INT", {
                    "default": 0, "min": 0, "max": 256, "step": 1,
                    "tooltip": "Grow the mask this many px into the original image for blending overlap."}),
                "crop_state": ("STRING", {"default": "", "tooltip": "Internal state", "hidden": True}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "INT", "INT")
    RETURN_NAMES = ("control_image", "control_mask", "mask_image", "width", "height")
    FUNCTION = "outpaint"
    OUTPUT_NODE = True
    CATEGORY = "Promptwaffle"
    DESCRIPTION = ("Interactive outpaint framing: pauses the run, lets you position the new "
                   "canvas on the live image, then outputs control image + mask + dimensions.")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def outpaint(self, image, grid_snap, fill_mode, mask_feather, mask_expand, crop_state, unique_id):
        grid = int(grid_snap)
        src = image if image.dim() == 4 else image.unsqueeze(0)
        batch, src_h, src_w, _ = src.shape
        if src_w < _MIN_DIM or src_h < _MIN_DIM:
            raise ValueError(f"PW Outpaint: input image too small ({src_w}x{src_h}).")

        unique_id = str(unique_id)
        try:
            preset = _SAVED_PRESETS.get(unique_id, {})
            batch_active = preset.get("active", False)

            if not batch_active:
                _SAVED_PRESETS.pop(unique_id, None)
                _PENDING.pop(unique_id, None)
                crop_state = self._wait_for_user(src[0], crop_state, unique_id)
                if crop_state is None:  # timed out / node removed: pass through untouched
                    passthrough_mask = torch.zeros((batch, src_h, src_w))
                    return (src, passthrough_mask, src, src_w, src_h)
            elif preset.get("crop_state"):
                saved = _parse_state(preset["crop_state"])
                adapted = _adapt_state_to_size(saved, src_w, src_h, grid)
                crop_state = json.dumps(adapted)

            state = _parse_state(crop_state)
            crop = {k: state[k] for k in ("x", "y", "w", "h")}
            if crop["w"] < grid or crop["h"] < grid:
                crop = _default_crop(src_w, src_h, grid)

            src_np = src.cpu().numpy().astype(np.float32)
            canvas, hard_mask = _build_canvas(
                src_np, crop, fill_mode,
                _hex_to_rgb(state["fillColor"], fallback=(0.5, 0.5, 0.5)))
            mask = _process_mask(hard_mask, int(mask_expand), int(mask_feather))

            control_image = torch.from_numpy(canvas)
            control_mask = torch.from_numpy(mask).unsqueeze(0).repeat(batch, 1, 1)

            mask_rgb = np.asarray(_hex_to_rgb(state["maskColor"]), dtype=np.float32)
            bg_rgb = np.asarray(_hex_to_rgb(state["bgColor"], fallback=(0.08, 0.08, 0.08)), dtype=np.float32)
            colorized = mask[..., None] * mask_rgb + (1.0 - mask[..., None]) * bg_rgb
            mask_image = torch.from_numpy(colorized.clip(0.0, 1.0)).unsqueeze(0)

            return (control_image, control_mask, mask_image, crop["w"], crop["h"])
        finally:
            _PENDING.pop(unique_id, None)

    def _wait_for_user(self, frame, crop_state, unique_id):
        """Block until the frontend approves. Returns crop_state, or None to pass through."""
        _PENDING[unique_id] = {
            "status": "pending",
            "crop_state": crop_state,
            "last_heartbeat": time.time(),
        }
        try:
            image_url, width, height = _save_preview(frame, unique_id)
            server.PromptServer.instance.send_sync("pw_outpaint.show", {
                "node_id": unique_id,
                "image_url": image_url,
                "image_width": width,
                "image_height": height,
            })
        except Exception:
            pass

        while True:
            mm.throw_exception_if_processing_interrupted()
            entry = _PENDING.get(unique_id, {})
            status = entry.get("status", "pending")
            if status == "approved":
                return entry.get("crop_state", crop_state)
            if status == "cancelled":
                raise mm.InterruptProcessingException()
            if status == "removed":
                return None
            if time.time() - entry.get("last_heartbeat", 0) > _HEARTBEAT_TIMEOUT:
                return None
            time.sleep(_POLL_INTERVAL)


NODE_CLASS_MAPPINGS = {"PWOutpaint": PWOutpaint}
NODE_DISPLAY_NAME_MAPPINGS = {"PWOutpaint": "PW Outpaint"}


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

routes = server.PromptServer.instance.routes


def _clean_name(name):
    return "".join(c for c in str(name or "") if c.isalnum() or c in " _-").strip()


def _preset_path(name):
    clean = _clean_name(name)
    if not clean:
        return None
    return os.path.join(_PRESET_DIR, f"{clean}.json")


@routes.post("/pw_outpaint/decision")
async def pw_decision(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id"))
        decision = data.get("decision")
        crop_state = data.get("crop_state")
        batch_mode = bool(data.get("batch_mode", False))
        if node_id not in _PENDING:
            return web.Response(status=404, text="Not waiting")
        if decision == "approve":
            if crop_state:
                _PENDING[node_id]["crop_state"] = crop_state
            if batch_mode and crop_state:
                _SAVED_PRESETS[node_id] = {"crop_state": crop_state, "active": True}
            _PENDING[node_id]["status"] = "approved"
        elif decision == "cancel":
            _SAVED_PRESETS.pop(node_id, None)
            _PENDING[node_id]["status"] = "cancelled"
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/heartbeat")
async def pw_heartbeat(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id"))
        if node_id in _PENDING:
            _PENDING[node_id]["last_heartbeat"] = time.time()
            return web.Response(status=200, text="OK")
        return web.Response(status=404, text="Not found")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/cleanup")
async def pw_cleanup(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id"))
        if node_id in _PENDING:
            _PENDING[node_id]["status"] = "removed"
            _PENDING[node_id]["last_heartbeat"] = time.time()
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/batch_toggle")
async def pw_batch_toggle(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id"))
        enabled = bool(data.get("enabled", False))
        if node_id in _SAVED_PRESETS:
            _SAVED_PRESETS[node_id]["active"] = enabled
        elif enabled and node_id in _PENDING:
            crop_state = _PENDING[node_id].get("crop_state")
            if crop_state:
                _SAVED_PRESETS[node_id] = {"crop_state": crop_state, "active": True}
        return web.Response(status=200, text="OK")
    except Exception as exc:
        return web.Response(status=500, text=str(exc))


@routes.post("/pw_outpaint/clear_preset")
async def pw_clear_preset(request):
    try:
        data = await request.json()
        _SAVED_PRESETS.pop(str(data.get("node_id")), None)
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
        presets = []
        if os.path.isdir(_PRESET_DIR):
            presets = sorted(f[:-5] for f in os.listdir(_PRESET_DIR) if f.endswith(".json"))
        return web.json_response(presets)
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
