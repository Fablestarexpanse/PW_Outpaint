"""PW Outpaint Stitch - composite the untouched source back over the result.

Sampling an outpaint runs the whole canvas through the VAE, which subtly
shifts every pixel - including the ones that were never masked. This node
pastes the original image back into its exact spot in the generated canvas,
with an optional feathered seam, so the source stays pixel-perfect and only
the new areas come from the sampler.
"""

import torch

try:
    from .pw_common import fit_batch, frame_fields, seam_alpha
except ImportError:  # loaded outside the package (tests)
    from pw_common import fit_batch, frame_fields, seam_alpha


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
        pads, src_w, src_h = frame_fields(frame, "PW Outpaint Stitch")
        out_h = src_h + pads["t"] + pads["b"]
        out_w = src_w + pads["l"] + pads["r"]

        result = fit_batch(images, out_h, out_w).clone()
        src = fit_batch(source, src_h, src_w)

        batch = result.shape[0]
        if src.shape[0] < batch:
            reps = -(-batch // src.shape[0])  # ceil
            src = src.repeat(reps, 1, 1, 1)
        src = src[:batch]

        channels = min(result.shape[-1], src.shape[-1])
        alpha = torch.from_numpy(seam_alpha(src_w, src_h, pads, seam_feather))
        alpha = alpha.to(result.device, result.dtype)[None, :, :, None]

        top, left = pads["t"], pads["l"]
        region = result[:, top:top + src_h, left:left + src_w, :channels]
        result[:, top:top + src_h, left:left + src_w, :channels] = \
            src[..., :channels] * alpha + region * (1.0 - alpha)

        return (result,)


NODE_CLASS_MAPPINGS = {"PWOutpaintStitch": PWOutpaintStitch}
NODE_DISPLAY_NAME_MAPPINGS = {"PWOutpaintStitch": "PW Outpaint Stitch"}
