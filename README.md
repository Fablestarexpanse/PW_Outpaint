# PW Outpaint

An interactive outpainting node for ComfyUI. When your workflow reaches this node it **pauses**, shows you the actual image, and lets you drag a resizable frame to decide exactly where the new canvas goes. Click **ACCEPT** and the workflow continues with a control image, mask, and dimensions ready for any inpaint/outpaint pipeline — built with **Flux.2 Klein** in mind, but model-agnostic.

A clean-room style rebuild inspired by the excellent [RS Outpaint node from RaykoStudio](https://github.com/Raykosan/ComfyUI_RaykoStudio), with extra features and a single-node focus.

## Features

- **Visual framing** — drag, resize (8 handles), zoom (scroll) and pan (middle-drag) directly on the node, on the *live* image from your workflow
- **Pause & approve** — the run waits while you adjust; ACCEPT continues, CANCEL stops the prompt cleanly (ComfyUI's own Cancel button works too)
- **Batch mode** — approve one frame, and the rest of your queue reuses it automatically (auto-adapts to different image sizes), then the node resets when the queue drains
- **Aspect chips & snapping** — one-click 16:9 / 9:16 / 21:9 / 1:1 / etc., snap to center/top/bottom/left/right/fit, aspect-ratio lock, exact W/H entry
- **Grid snap** — 8 / 16 / 32 / 64 px snapping (16 is right for Flux.2 Klein; 8 suits SD1.5/SDXL)
- **Fill modes** for the new area of the control image: `gray`, `solid_color` (pick any color), `edge_extend`, `mirror_blur`, `noise`
- **Mask feather & expand** — grow the mask into the original image and soften the seam for seamless blends
- **Presets** — save/load named frame presets to disk

## Installation

1. Open a terminal in your ComfyUI `custom_nodes` folder:

   ```
   cd ComfyUI/custom_nodes
   ```

2. Clone this repo:

   ```
   git clone https://github.com/Fablestarexpanse/PW_Outpaint.git
   ```

3. Restart ComfyUI. That's it — no extra dependencies, everything it needs ships with ComfyUI.

You'll find the node under **Add Node → Promptwaffle → PW Outpaint** (or double-click and search "PW Outpaint").

## How to use

1. Connect any `IMAGE` output to PW Outpaint's `image` input.
2. Queue the workflow. When execution reaches the node, it pauses and the image appears in the node.
3. Drag/resize the blue frame to cover the area you want the final image to be. Everything outside the original picture becomes the outpainted region (tinted with your mask color).
4. Click **ACCEPT**. The workflow continues.

> If no one clicks ACCEPT within ~10 seconds and the browser is closed, the node passes the image through untouched so headless queues don't hang forever.

### Outputs

| Output | Type | What it is |
|---|---|---|
| `control_image` | IMAGE | The new canvas with your image pasted in and the new area filled per `fill_mode` |
| `control_mask` | MASK | 1.0 where new content should be generated, 0.0 over the original image |
| `mask_image` | IMAGE | The mask rendered with your mask/bg colors (handy for edit-model prompts like "replace the red area") |
| `width` / `height` | INT | Final canvas dimensions (always multiples of `grid_snap`) |

### Node options

| Widget | Default | Notes |
|---|---|---|
| `grid_snap` | 16 | Snap grid in px. Keep 16 for Flux.2 Klein / Qwen; 8 is fine for SD1.5/SDXL |
| `fill_mode` | gray | How the empty area of `control_image` is filled. `edge_extend` and `mirror_blur` give the sampler more to work with; `solid_color` + a bold color works well with edit models ("eliminate the red area...") |
| `mask_feather` | 0 | Gaussian feather radius (px) on the mask seam. The fully-new region always stays solid |
| `mask_expand` | 0 | Grows the mask into the original image so generation overlaps the seam — great for hiding hard edges |

### Batch mode

Click **BATCH: on** before ACCEPT and your frame is remembered. Every following run in the queue applies it automatically (scaled/clamped to each image's size) without pausing. When the queue finishes, the node resets itself.

### Presets

**Save preset** stores the current frame + colors under a name. **Load preset** applies one to the current image. Presets live in the node's `presets/` folder as plain JSON.

## Flux.2 Klein example

An example workflow is included in [`examples/pw_outpaint_klein9b.json`](examples/pw_outpaint_klein9b.json) — drag it into ComfyUI. The wiring is:

```
LoadImage → PW Outpaint ─ control_image → VAEEncode → ReferenceLatent ┐
                        ├ control_mask ──────────→ InpaintModelConditioning → KSampler → VAEDecode → SaveImage
                        └ width/height ──→ EmptyFlux2LatentImage ┘
```

You'll need to point the loader nodes at your own Klein 9B checkpoint, Flux.2 VAE, and Mistral/Qwen text encoder — the filenames in the example are placeholders.

## Credits

- Concept and original implementation: [Raykosan / ComfyUI_RaykoStudio](https://github.com/Raykosan/ComfyUI_RaykoStudio). This project re-implements the RS Outpaint idea as a standalone node. Portions of the frame-interaction geometry are adapted from that work, which is Copyright 2025-2026 Raykosan (RaykoStudio) and licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

## License

[MIT](LICENSE) — adapted portions from ComfyUI_RaykoStudio remain under Apache-2.0 as noted above.
