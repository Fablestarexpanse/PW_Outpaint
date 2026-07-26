"""Offline tests for the PW Outpaint pack.

Runnable with plain `python -m pytest` and no ComfyUI install: the comfy /
server modules the nodes import are stubbed below before anything else loads.
"""

import sys
import time
import types
from pathlib import Path

import numpy as np
import torch

# ---------------------------------------------------------------------------
# stub the ComfyUI runtime before importing the pack modules
# ---------------------------------------------------------------------------

def _install_stubs():
    if "comfy.utils" in sys.modules:
        return

    server = types.ModuleType("server")

    class _Routes:
        def post(self, _path):
            def deco(fn):
                return fn
            return deco

    class _PromptServer:
        routes = _Routes()
        instance = None

        def send_sync(self, *_a, **_k):
            pass

    _PromptServer.instance = _PromptServer()
    server.PromptServer = _PromptServer
    sys.modules["server"] = server

    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_temp_directory = lambda: "."
    sys.modules["folder_paths"] = folder_paths

    comfy = types.ModuleType("comfy")
    mm = types.ModuleType("comfy.model_management")
    mm.throw_exception_if_processing_interrupted = lambda: None

    class InterruptProcessingException(Exception):
        pass

    mm.InterruptProcessingException = InterruptProcessingException

    cutils = types.ModuleType("comfy.utils")

    def common_upscale(samples, width, height, _method, _crop):
        return torch.nn.functional.interpolate(
            samples, size=(height, width), mode="bilinear", align_corners=False)

    cutils.common_upscale = common_upscale
    comfy.model_management = mm
    comfy.utils = cutils
    sys.modules["comfy"] = comfy
    sys.modules["comfy.model_management"] = mm
    sys.modules["comfy.utils"] = cutils

    aiohttp = types.ModuleType("aiohttp")
    web = types.ModuleType("aiohttp.web")
    web.Response = lambda **kw: kw
    web.json_response = lambda x: x
    aiohttp.web = web
    sys.modules["aiohttp"] = aiohttp
    sys.modules["aiohttp.web"] = web


_install_stubs()
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pw_outpaint  # noqa: E402
import pw_band_meter  # noqa: E402
import pw_banded_colormatch  # noqa: E402


def make_frame(l=0, t=0, r=0, b=0, src_w=64, src_h=64):
    return {"pads": {"l": l, "t": t, "r": r, "b": b}, "src_w": src_w, "src_h": src_h}


# ---------------------------------------------------------------------------
# 1. diff_mask
# ---------------------------------------------------------------------------

class TestDiffMask:
    def test_interior_zero_padding_one(self):
        pads = {"l": 32, "t": 16, "r": 0, "b": 0}
        mask = pw_outpaint._diff_mask(pads, src_w=64, src_h=48, expand=8, feather=0)
        assert mask.shape == (64, 96)
        assert np.all(mask[:, :32] == 1.0), "padding must be exactly 1"
        assert np.all(mask[:16, :] == 1.0), "padding must be exactly 1"
        # interior beyond the ring (8 px from both padded sides)
        interior = mask[16 + 9:, 32 + 9:]
        assert np.all(interior == 0.0), "interior must be exactly 0"

    def test_ring_strictly_monotonic(self):
        pads = {"l": 32, "t": 0, "r": 0, "b": 0}
        mask = pw_outpaint._diff_mask(pads, src_w=64, src_h=48, expand=8, feather=0)
        ring = mask[24, 32:32 + 8]  # row through the ring, moving into the source
        assert ring[0] == 1.0
        assert np.all(np.diff(ring) < 0), "ring must decrease strictly inward"

    def test_no_hard_edge_when_expand_zero(self):
        pads = {"l": 32, "t": 0, "r": 0, "b": 0}
        mask = pw_outpaint._diff_mask(pads, src_w=64, src_h=48, expand=0, feather=0)
        ring = mask[24, 32:32 + 8]
        between = (ring > 0.0) & (ring < 1.0)
        assert between.any(), "expand=0 must still produce a ramp, not a binary edge"

    def test_full_node_emits_diff_mask(self):
        src = torch.rand(1, 48, 64, 3)
        pw_outpaint._BATCH["diff-test"] = {
            "active": True,
            "pads": {"l": 32, "t": 0, "r": 0, "b": 0},
            "style": None,
            "ts": time.time(),
        }
        out = pw_outpaint.PWOutpaint().outpaint(
            src, "16", "gray", 0, 8, 0, 0, 0, 0, "", "diff-test")
        assert len(out) == 7
        diff = out[6]
        assert diff.shape == (1, 48, 96)
        assert float(diff[0, 24, 0]) == 1.0
        assert float(diff[0, 24, 95]) == 0.0


# ---------------------------------------------------------------------------
# 2. Band Meter
# ---------------------------------------------------------------------------

def _meter_canvas(band_value, src_value=0.25, l=32, src_w=64, src_h=64):
    canvas = torch.full((1, src_h, l + src_w, 3), float(src_value))
    canvas[:, :, :l, :] = float(band_value)
    return canvas


class TestBandMeter:
    def test_bright_band_warns(self):
        frame = make_frame(l=32, src_w=64, src_h=64)
        source = torch.full((1, 64, 64, 3), 0.25)
        images = _meter_canvas(band_value=0.5)
        result = pw_band_meter.PWBandMeter().measure(images, source, frame)
        _, report, passed = result["result"]
        assert passed is False
        left_row = next(line for line in report.splitlines() if line.startswith("left"))
        assert "WARN" in left_row

    def test_identical_bands_pass(self):
        frame = make_frame(l=32, src_w=64, src_h=64)
        source = torch.full((1, 64, 64, 3), 0.25)
        images = _meter_canvas(band_value=0.25)
        result = pw_band_meter.PWBandMeter().measure(images, source, frame)
        _, report, passed = result["result"]
        assert passed is True
        assert "WARN" not in report

    def test_scale_recovery_at_1_5x(self):
        frame = make_frame(l=32, src_w=64, src_h=64)  # canvas 96 x 64
        source = torch.full((1, 64, 64, 3), 0.25)
        images = _meter_canvas(band_value=0.5)
        upscaled = torch.nn.functional.interpolate(
            images.movedim(-1, 1), size=(96, 144), mode="nearest").movedim(1, -1)
        result = pw_band_meter.PWBandMeter().measure(upscaled, source, frame)
        _, report, passed = result["result"]
        assert passed is False
        left_row = next(line for line in report.splitlines() if line.startswith("left"))
        assert "WARN" in left_row
        source_row = next(line for line in report.splitlines() if line.startswith("source"))
        assert "0.250" in source_row, "source stats must land on the source region"


# ---------------------------------------------------------------------------
# 3. Banded Color Match
# ---------------------------------------------------------------------------

class TestBandedColorMatch:
    def test_source_region_untouched_at_strength_2(self):
        frame = make_frame(l=32, src_w=64, src_h=64)
        canvas = torch.rand(1, 64, 96, 3)
        source = torch.rand(1, 64, 64, 3)
        (out,) = pw_banded_colormatch.PWBandedColorMatch().correct(
            canvas, source, frame, strength=2.0, blend_px=16)
        assert torch.equal(out[:, :, 32:, :], canvas[:, :, 32:, :]), \
            "source region must be byte-identical"

    def test_bright_band_moves_toward_reference(self):
        frame = make_frame(l=32, src_w=64, src_h=64)
        canvas = torch.full((1, 64, 96, 3), 0.4)
        canvas[:, :, :32, :] = 0.8
        source = torch.full((1, 64, 64, 3), 0.4)
        (out,) = pw_banded_colormatch.PWBandedColorMatch().correct(
            canvas, source, frame, strength=1.0, blend_px=8)
        deep_band = out[0, :, :16, :]  # away from the blend ramp
        assert abs(float(deep_band.mean()) - 0.4) < 0.02, \
            "flat band should land on the reference mean"
        assert float(deep_band.mean()) < 0.5, "band must move toward the reference"

    def test_corner_overlap_has_no_discontinuity(self):
        frame = make_frame(l=32, t=32, src_w=64, src_h=64)  # canvas 96 x 96
        canvas = torch.full((1, 96, 96, 3), 0.7)
        canvas[:, 32:, 32:, :] = 0.4  # the source region
        source = torch.full((1, 64, 64, 3), 0.4)
        (out,) = pw_banded_colormatch.PWBandedColorMatch().correct(
            canvas, source, frame, strength=1.0, blend_px=8)
        img = out[0].numpy()
        band_zone = img[:40, :40, :]  # corner plus the start of both bands
        step_x = np.abs(np.diff(band_zone, axis=1)).max()
        step_y = np.abs(np.diff(band_zone, axis=0)).max()
        assert max(step_x, step_y) < 0.06, \
            f"corner seams must be smooth, max step {max(step_x, step_y):.4f}"


# ---------------------------------------------------------------------------
# 4. output slot stability
# ---------------------------------------------------------------------------

class TestSlotStability:
    def test_existing_slots_unchanged(self):
        assert pw_outpaint.PWOutpaint.RETURN_NAMES[:6] == (
            "control_image", "control_mask", "mask_image", "width", "height", "frame")
        assert pw_outpaint.PWOutpaint.RETURN_TYPES[:6] == (
            "IMAGE", "MASK", "IMAGE", "INT", "INT", "PW_FRAME")

    def test_diff_mask_is_slot_6(self):
        assert pw_outpaint.PWOutpaint.RETURN_NAMES[6] == "diff_mask"
        assert pw_outpaint.PWOutpaint.RETURN_TYPES[6] == "MASK"
