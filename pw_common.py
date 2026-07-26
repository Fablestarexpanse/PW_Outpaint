"""Shared helpers for the PW Outpaint pack.

Every node in the pack speaks the same PW_FRAME payload:
    {"pads": {"l": int, "t": int, "r": int, "b": int}, "src_w": int, "src_h": int}
and the same tensor conventions: IMAGE is float32 [B, H, W, C] in 0..1,
MASK is [H, W] or [B, H, W] in 0..1 where 1 = generate, 0 = keep.
"""

import numpy as np
import torch

import comfy.utils


def frame_fields(frame, node_name="PW Outpaint"):
    """Validate a PW_FRAME payload and return (pads, src_w, src_h)."""
    if not isinstance(frame, dict) or "pads" not in frame or "src_w" not in frame or "src_h" not in frame:
        raise ValueError(f"{node_name}: 'frame' must come from PW Outpaint's frame output.")
    pads = frame["pads"]
    return (
        {k: max(0, int(pads.get(k, 0))) for k in ("l", "t", "r", "b")},
        max(1, int(frame["src_w"])),
        max(1, int(frame["src_h"])),
    )


def seam_alpha(src_w, src_h, pads, feather):
    """Opacity of a pasted source region: 1 in the interior, ramping to 0 at
    any edge that borders generated content."""
    alpha = np.ones((src_h, src_w), dtype=np.float32)
    f = int(feather)
    if f <= 0:
        return alpha
    ramp = (np.arange(f, dtype=np.float32) + 1.0) / (f + 1.0)
    fx = min(f, src_w)
    fy = min(f, src_h)
    if pads["l"] > 0:
        alpha[:, :fx] = np.minimum(alpha[:, :fx], ramp[:fx][None, :])
    if pads["r"] > 0:
        alpha[:, src_w - fx:] = np.minimum(alpha[:, src_w - fx:], ramp[:fx][::-1][None, :])
    if pads["t"] > 0:
        alpha[:fy, :] = np.minimum(alpha[:fy, :], ramp[:fy][:, None])
    if pads["b"] > 0:
        alpha[src_h - fy:, :] = np.minimum(alpha[src_h - fy:, :], ramp[:fy][::-1][:, None])
    return alpha


def fit_batch(images, height, width):
    """Bilinear-resize a [B,H,W,C] batch when its size drifted (VAE rounding)."""
    if images.shape[1] == height and images.shape[2] == width:
        return images
    moved = images.movedim(-1, 1)
    moved = comfy.utils.common_upscale(moved, width, height, "bilinear", "disabled")
    return moved.movedim(1, -1)
