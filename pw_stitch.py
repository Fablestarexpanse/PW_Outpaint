"""PW Outpaint Stitch - composite the untouched source back over the result.

Sampling an outpaint runs the whole canvas through the VAE, which subtly
shifts every pixel - including the ones that were never masked. This node
pastes the original image back into its exact spot in the generated canvas,
with an optional feathered seam, so the source stays pixel-perfect and only
the new areas come from the sampler.
"""

import numpy as np
import torch

import comfy.utils


def _frame_fields(frame):
    if not isinstance(frame, dict) or "pads" not in frame or "src_w" not in frame or "src_h" not in frame:
        raise ValueError("PW Outpaint Stitch: 'frame' must come from PW Outpaint's frame output.")
    pads = frame["pads"]
    return (
        {k: max(0, int(pads.get(k, 0))) for k in ("l", "t", "r", "b")},
        max(1, int(frame["src_w"])),
        max(1, int(frame["src_h"])),
    )


def _seam_alpha(src_w, src_h, pads, feather):
    """Opacity of the pasted source: 1 in the interior, ramping to 0 at any
    edge that borders generated content."""
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


def _fit_batch(images, height, width):
    """Bilinear-resize a [B,H,W,C] batch when its size drifted (VAE rounding)."""
    if images.shape[1] == height and images.shape[2] == width:
        return images
    moved = images.movedim(-1, 1)
    moved = comfy.utils.common_upscale(moved, width, height, "bilinear", "disabled")
    return moved.movedim(1, -1)


class PWOutpaintStitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "The generated outpaint result."}),
                "source": ("IMAGE", {"tooltip": "The original image that was fed into PW Outpaint."}),
                "frame": ("PW_FRAME", {"tooltip": "The frame output of PW Outpaint."}),
                "seam_feather": ("INT", {
                    "default": 24, "min": 0, "max": 256, "step": 1,
                    "tooltip": "Feather width (px) blending the source edge into the generated area."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "stitch"
    CATEGORY = "Promptwaffle"
    DESCRIPTION = ("Paste the untouched source image back into the generated outpaint at its "
                   "exact position, keeping the original pixels crisp. Feather softens the seam.")

    def stitch(self, images, source, frame, seam_feather):
        pads, src_w, src_h = _frame_fields(frame)
        out_h = src_h + pads["t"] + pads["b"]
        out_w = src_w + pads["l"] + pads["r"]

        result = _fit_batch(images, out_h, out_w).clone()
        src = _fit_batch(source, src_h, src_w)

        batch = result.shape[0]
        if src.shape[0] < batch:
            reps = -(-batch // src.shape[0])  # ceil
            src = src.repeat(reps, 1, 1, 1)
        src = src[:batch]

        channels = min(result.shape[-1], src.shape[-1])
        alpha = torch.from_numpy(_seam_alpha(src_w, src_h, pads, seam_feather))
        alpha = alpha.to(result.device, result.dtype)[None, :, :, None]

        top, left = pads["t"], pads["l"]
        region = result[:, top:top + src_h, left:left + src_w, :channels]
        result[:, top:top + src_h, left:left + src_w, :channels] = \
            src[..., :channels] * alpha + region * (1.0 - alpha)

        return (result,)


NODE_CLASS_MAPPINGS = {"PWOutpaintStitch": PWOutpaintStitch}
NODE_DISPLAY_NAME_MAPPINGS = {"PWOutpaintStitch": "PW Outpaint Stitch"}
