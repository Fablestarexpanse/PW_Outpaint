"""PW Banded Color Match - frame-aware color correction for outpaint bands.

Global color matchers fit one transform over the whole canvas; since the
canvas is mostly already-correct source content, the correction under-shoots
the generated bands that actually need it. This node corrects only the bands,
each fitted against the source content adjacent to it - possible because the
PW_FRAME payload tells us exactly where the bands are. Original pixels are
never touched, at any strength.
"""

import numpy as np
import torch

try:
    from .pw_common import fit_batch, frame_fields
except ImportError:  # loaded outside the package (tests)
    from pw_common import fit_batch, frame_fields

_SIGMA_RATIO_MIN = 0.25
_SIGMA_RATIO_MAX = 4.0
_HIST_BINS = 256


def _srgb_to_linear(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(x):
    x = np.clip(x, 0.0, None)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def _band_ramp(length, boundary_at_end, blend):
    """Per-pixel averaging weight along one axis of a band strip.

    Where two bands overlap (corners) their corrections are averaged; these
    ramps fade each band's vote toward its inner boundary so the average
    hands over smoothly from one band to the other instead of stepping.
    A single band's correction is unaffected (the weight cancels out).
    """
    w = np.ones(length, dtype=np.float32)
    blend = min(int(blend), length)
    if blend <= 0:
        return w
    ramp = (np.arange(blend, dtype=np.float32) + 1.0) / (blend + 1.0)
    if boundary_at_end:   # band sits left/above the source: boundary at the far end
        w[length - blend:] = ramp[::-1]
    else:                 # band sits right/below the source: boundary at the start
        w[:blend] = ramp
    return w


def _mean_std_correct(band, ref):
    """Per-channel Reinhard-style transfer of `band` toward `ref` statistics."""
    flat_b = band.reshape(-1, band.shape[-1])
    flat_r = ref.reshape(-1, ref.shape[-1])
    mu_b = flat_b.mean(axis=0)
    mu_r = flat_r.mean(axis=0)
    sd_b = flat_b.std(axis=0)
    sd_r = flat_r.std(axis=0)
    ratio = np.clip(sd_r / np.maximum(sd_b, 1e-6), _SIGMA_RATIO_MIN, _SIGMA_RATIO_MAX)
    return (band - mu_b) * ratio + mu_r


def _histogram_correct(band, ref):
    """Per-channel histogram matching via quantile interpolation."""
    qs = np.linspace(0.0, 1.0, _HIST_BINS, dtype=np.float32)
    out = np.empty_like(band)
    for c in range(band.shape[-1]):
        bq = np.quantile(band[..., c], qs)
        rq = np.quantile(ref[..., c], qs)
        out[..., c] = np.interp(band[..., c], bq, rq)
    return out


class PWBandedColorMatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "The decoded outpaint canvas (pre-stitch)."}),
                "source": ("IMAGE", {"tooltip": "The clean source image."}),
                "frame": ("PW_FRAME", {"tooltip": "The frame output of PW Outpaint."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05,
                                       "tooltip": "1.0 applies the fitted correction; above 1.0 extrapolates past it."}),
                "blend_px": ("INT", {"default": 64, "min": 0, "max": 512, "step": 1,
                                     "tooltip": "Feather width (px) fading the correction toward the source boundary."}),
            },
            "optional": {
                "mode": (["mean_std", "histogram"], {"default": "mean_std",
                                                     "tooltip": "mean_std is gentle; histogram is a harder match and can posterise."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "correct"
    CATEGORY = "Promptwaffle"
    DESCRIPTION = ("Color-correct only the outpainted bands, each fitted against the source "
                   "content next to it. Original pixels are never modified.")

    def correct(self, images, source, frame, strength, blend_px, mode="mean_std"):
        pads, src_w, src_h = frame_fields(frame, "PW Banded Color Match")
        out_h = src_h + pads["t"] + pads["b"]
        out_w = src_w + pads["l"] + pads["r"]
        if not any(pads.values()):
            return (images,)

        canvas = fit_batch(images, out_h, out_w)
        src = fit_batch(source, src_h, src_w)
        correct_fn = _histogram_correct if mode == "histogram" else _mean_std_correct

        src_lin = _srgb_to_linear(src[0].cpu().numpy().astype(np.float32)[..., :3])

        # (name, band rows, band cols, reference slice of the source, ramp axis)
        sides = []
        if pads["l"] > 0:
            ref = src_lin[:, :min(pads["l"], src_w)]
            sides.append(("l", slice(0, out_h), slice(0, pads["l"]), ref, "x_end"))
        if pads["r"] > 0:
            ref = src_lin[:, src_w - min(pads["r"], src_w):]
            sides.append(("r", slice(0, out_h), slice(pads["l"] + src_w, out_w), ref, "x_start"))
        if pads["t"] > 0:
            ref = src_lin[:min(pads["t"], src_h), :]
            sides.append(("t", slice(0, pads["t"]), slice(0, out_w), ref, "y_end"))
        if pads["b"] > 0:
            ref = src_lin[src_h - min(pads["b"], src_h):, :]
            sides.append(("b", slice(pads["t"] + src_h, out_h), slice(0, out_w), ref, "y_start"))

        result = canvas.clone()
        for b in range(canvas.shape[0]):
            img = canvas[b].cpu().numpy().astype(np.float32)
            rgb_lin = _srgb_to_linear(img[..., :3])

            num = np.zeros_like(rgb_lin)
            den = np.zeros((out_h, out_w), dtype=np.float32)
            for _name, rows, cols, ref, ramp_axis in sides:
                band = rgb_lin[rows, cols]
                corrected = correct_fn(band, ref)
                if ramp_axis in ("x_end", "x_start"):
                    ramp = _band_ramp(band.shape[1], ramp_axis == "x_end", blend_px)[None, :]
                else:
                    ramp = _band_ramp(band.shape[0], ramp_axis == "y_end", blend_px)[:, None]
                num[rows, cols] += corrected * ramp[..., None]
                den[rows, cols] += ramp

            touched = den > 0
            if touched.any():
                avg = np.where(touched[..., None], num / np.maximum(den, 1e-6)[..., None], 0.0)
                # full-strength inside every band: the seam only disappears when
                # the band actually matches the source, so the correction must
                # not fade near the boundary; the ramps in `den`/`num` exist to
                # cross-fade overlapping band corrections in the corners
                out_lin = rgb_lin.copy()
                out_lin[touched] = (rgb_lin + float(strength) * (avg - rgb_lin))[touched]
                out_rgb = np.clip(_linear_to_srgb(out_lin), 0.0, 1.0)
                merged = img.copy()
                merged[..., :3] = np.where(touched[..., None], out_rgb, img[..., :3])
                result[b] = torch.from_numpy(merged).to(result.device, result.dtype)

        return (result,)


NODE_CLASS_MAPPINGS = {"PWBandedColorMatch": PWBandedColorMatch}
NODE_DISPLAY_NAME_MAPPINGS = {"PWBandedColorMatch": "PW Banded Color Match"}
