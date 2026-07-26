"""PW Band Meter - numeric QC for outpainted bands.

Answers "does the generated band actually match the source?" with numbers
instead of squinting: per-band mean luminance, contrast (luminance std),
saturation, and gradient detail, each compared against the source region.
Catches failures like a band 2x too bright or 4x less detailed that are easy
to miss at thumbnail zoom.
"""

import numpy as np

try:
    from .pw_common import frame_fields
except ImportError:  # loaded outside the package (tests)
    from pw_common import frame_fields

_LUMA = np.asarray([0.2126, 0.7152, 0.0722], dtype=np.float32)  # Rec.709
_SEAM_MARGIN = 16  # px at canvas scale, excluded where bands meet the source
_MIN_EXTENT = 4    # a strip thinner than this is measured without the margin


def _metrics(region):
    """(mean luminance, luminance std, mean saturation, mean gradient)."""
    if region.shape[0] < 2 or region.shape[1] < 2:
        return None
    rgb = region[..., :3].astype(np.float32)
    luma = rgb @ _LUMA
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    gy, gx = np.gradient(luma)
    detail = np.sqrt(gy * gy + gx * gx)
    return (float(luma.mean()), float(luma.std()), float(sat.mean()), float(detail.mean()))


def _pct(value, reference):
    return 100.0 * (value - reference) / max(abs(reference), 1e-6)


class PWBandMeter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "The finished outpaint (post-stitch)."}),
                "source": ("IMAGE", {"tooltip": "The pre-outpaint image."}),
                "frame": ("PW_FRAME", {"tooltip": "The frame output of PW Outpaint."}),
            },
            "optional": {
                "warn_luminance_pct": ("INT", {"default": 15, "min": 1, "max": 500, "step": 1,
                                               "tooltip": "WARN when a band's mean luminance deviates more than this."}),
                "warn_saturation_pct": ("INT", {"default": 20, "min": 1, "max": 500, "step": 1,
                                                "tooltip": "WARN when a band's mean saturation deviates more than this."}),
                "warn_detail_pct": ("INT", {"default": 40, "min": 1, "max": 500, "step": 1,
                                            "tooltip": "WARN when a band's gradient detail deviates more than this."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "BOOLEAN")
    RETURN_NAMES = ("images", "report", "passed")
    FUNCTION = "measure"
    OUTPUT_NODE = True
    CATEGORY = "Promptwaffle"
    DESCRIPTION = ("Measure each outpainted band against the source (luminance, contrast, "
                   "saturation, detail) and report PASS/WARN per band.")

    def measure(self, images, source, frame,
                warn_luminance_pct=15, warn_saturation_pct=20, warn_detail_pct=40):
        pads, src_w, src_h = frame_fields(frame, "PW Band Meter")
        out_w = src_w + pads["l"] + pads["r"]
        out_h = src_h + pads["t"] + pads["b"]

        img_h, img_w = int(images.shape[1]), int(images.shape[2])
        scale = img_w / out_w
        if abs(img_h - out_h * scale) > max(2.0, scale * 2.0):
            raise ValueError(
                f"PW Band Meter: images ({img_w}x{img_h}) do not match the frame canvas "
                f"({out_w}x{out_h}) at any uniform scale.")

        img = images[0].cpu().numpy().astype(np.float32)
        sx = lambda v: int(round(v * scale))
        margin = sx(_SEAM_MARGIN)

        def strip_lo(hi):
            """[0, hi) strip, dropping `margin` px next to the source unless too thin."""
            return hi - margin if hi - margin >= _MIN_EXTENT else hi

        def strip_hi(lo, end):
            return lo + margin if end - (lo + margin) >= _MIN_EXTENT else lo

        bands = {}
        if pads["l"] > 0:
            bands["left"] = img[:, 0:strip_lo(sx(pads["l"]))]
        if pads["r"] > 0:
            lo = strip_hi(sx(pads["l"] + src_w), img_w)
            bands["right"] = img[:, lo:img_w]
        if pads["t"] > 0:
            bands["top"] = img[0:strip_lo(sx(pads["t"])), :]
        if pads["b"] > 0:
            lo = strip_hi(sx(pads["t"] + src_h), img_h)
            bands["bottom"] = img[lo:img_h, :]

        sx0, sx1 = sx(pads["l"]), sx(pads["l"] + src_w)
        sy0, sy1 = sx(pads["t"]), sx(pads["t"] + src_h)
        if pads["l"] > 0 and sx1 - (sx0 + margin) >= _MIN_EXTENT:
            sx0 += margin
        if pads["r"] > 0 and (sx1 - margin) - sx0 >= _MIN_EXTENT:
            sx1 -= margin
        if pads["t"] > 0 and sy1 - (sy0 + margin) >= _MIN_EXTENT:
            sy0 += margin
        if pads["b"] > 0 and (sy1 - margin) - sy0 >= _MIN_EXTENT:
            sy1 -= margin
        src_stats = _metrics(img[sy0:sy1, sx0:sx1])
        if src_stats is None:
            raise ValueError("PW Band Meter: source region is too small to measure.")

        thresholds = (warn_luminance_pct, warn_saturation_pct, warn_detail_pct)
        header = (f"PW Band Meter  (warn: lum {thresholds[0]}%  sat {thresholds[1]}%"
                  f"  det {thresholds[2]}%)")
        lines = [header]
        if images.shape[0] > 1:
            lines.append("(batch: stats from first image)")
        lines.append(f"{'band':<8}{'lum':>7}{'d%':>8}{'con':>7}{'sat':>7}{'d%':>8}"
                     f"{'det':>8}{'d%':>8}  status")
        s_lum, s_con, s_sat, s_det = src_stats
        lines.append(f"{'source':<8}{s_lum:>7.3f}{'-':>8}{s_con:>7.3f}{s_sat:>7.3f}{'-':>8}"
                     f"{s_det:>8.4f}{'-':>8}  REF")

        passed = True
        for name, region in bands.items():
            stats = _metrics(region)
            if stats is None:
                lines.append(f"{name:<8}{'band too thin to measure':>40}  SKIP")
                continue
            b_lum, b_con, b_sat, b_det = stats
            d_lum = _pct(b_lum, s_lum)
            d_sat = _pct(b_sat, s_sat)
            d_det = _pct(b_det, s_det)
            warn = (abs(d_lum) > thresholds[0] or abs(d_sat) > thresholds[1]
                    or abs(d_det) > thresholds[2])
            passed = passed and not warn
            status = "WARN" if warn else "PASS"
            lines.append(f"{name:<8}{b_lum:>7.3f}{d_lum:>+8.1f}{b_con:>7.3f}{b_sat:>7.3f}"
                         f"{d_sat:>+8.1f}{b_det:>8.4f}{d_det:>+8.1f}  {status}")

        if not bands:
            lines.append("(no padded bands in frame - nothing to measure)")

        report = "\n".join(lines)
        return {"ui": {"text": [report]}, "result": (images, report, passed)}


NODE_CLASS_MAPPINGS = {"PWBandMeter": PWBandMeter}
NODE_DISPLAY_NAME_MAPPINGS = {"PWBandMeter": "PW Band Meter"}
