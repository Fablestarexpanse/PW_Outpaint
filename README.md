# PW Outpaint

An interactive outpainting node for ComfyUI. When your workflow reaches this node it **pauses**, shows the live image on a canvas editor inside the node, and lets you drag the output frame out in any direction. Press **Accept** and the workflow continues with a control image, mask, and dimensions ready for any inpaint/outpaint pipeline — built with **Flux.2 Klein** in mind, but model-agnostic.

## Features

- **Canvas editor on the node** — drag any edge or corner of the frame outward, scroll to zoom, drag outside the frame to pan, double-click to refit
- **Pause & approve** — the run waits while you frame the shot; Accept continues, Cancel stops the prompt cleanly (ComfyUI's own Cancel button works too)
- **Padding-based framing** — the frame is just four paddings (left/top/right/bottom) stored as real node widgets, so your last framing is saved with the workflow and the node even works **headless**: with no browser attached, the run continues after a short grace period using the stored paddings
- **Batch mode** — accept one frame with Batch on, and the rest of your queue reuses it automatically (paddings apply to any image size), then the node resets when the queue drains
- **Anchor grid** — a 3×3 anchor picks where the source sits in the output; aspect presets (1:1, 16:9, 9:16, 21:9, ...) and one-click ×1.25 / ×1.5 / ×2 canvas scaling
- **Grid snap** — 8 / 16 / 32 / 64 px snapping (16 is right for Flux.2 Klein; 8 suits SD1.5/SDXL)
- **Fill modes** for the new area of the control image: `gray`, `solid_color` (pick any color), `edge_extend`, `mirror_blur`, `noise`
- **Mask feather & expand** — grow the mask into the original image and soften the seam for seamless blends
- **Presets** — save/load named framings to disk

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
2. Queue the workflow. When execution reaches the node, it pauses and the image appears in the editor.
3. Drag the frame edges outward (or use the aspect menu, scale buttons, anchor grid, or type paddings/output size directly). The tinted strips are the areas that will be generated.
4. Press **Accept**. The workflow continues.

> No browser open? After a short grace period the run continues using the paddings stored on the node — so the node is safe to use in API/headless pipelines too.

## Wiring it into a workflow

PW Outpaint doesn't generate anything itself — it prepares the three things every outpaint pipeline needs: the enlarged canvas (`control_image`), the mask saying where to generate (`control_mask`), and the output dimensions (`width`/`height`). Here's how to connect them.

### The general pattern (any inpaint-capable model)

```
LoadImage ──→ PW Outpaint ─┬─ control_image ─→ InpaintModelConditioning (pixels)
                           ├─ control_mask ──→ InpaintModelConditioning (mask)
                           │                        │ (+ positive, negative, VAE)
                           │                        ▼
                           │                    KSampler ─→ VAEDecode ─┐
                           ├─ frame ───────────────────────────────────┤
LoadImage (same image) ────┼───────────────────────────────────────────┤
                           │                                           ▼
                           │                                  PW Outpaint Stitch ─→ SaveImage
```

1. `control_image` → **InpaintModelConditioning** `pixels` (it VAE-encodes internally).
2. `control_mask` → **InpaintModelConditioning** `mask`.
3. Sample with your model, decode, done. Add **PW Outpaint Stitch** at the end (see below) to keep the original pixels untouched.

### Flux.2 Klein (what the example workflow does)

Klein is an edit model, so the canvas also goes in as a reference:

```
PW Outpaint ─┬─ control_image ─→ VAEEncode ─→ ReferenceLatent ─→ (conditioning chain)
             ├─ control_image ─→ InpaintModelConditioning (pixels)
             ├─ control_mask ──→ InpaintModelConditioning (mask)
             ├─ width ─────────→ EmptyFlux2LatentImage (width)
             └─ height ────────→ EmptyFlux2LatentImage (height)

ReferenceLatent + InpaintModelConditioning ─→ KSampler (latent from EmptyFlux2LatentImage)
                                              └─→ VAEDecode ─→ PW Outpaint Stitch ─→ SaveImage
```

Prompt tip for edit models: set `fill_mode` to `solid_color` with a bold color (e.g. red) and prompt something like *"Remove the red areas and extend the scene naturally."* — the model sees exactly where to work. `mask_image` is a ready-made visualization of that colored target if your workflow wants it as a separate reference.

### Stitching (recommended finish for every outpaint)

```
VAEDecode ────────────────→ images ┐
LoadImage (the original) ─→ source ├─ PW Outpaint Stitch ─→ SaveImage
PW Outpaint `frame` ──────→ frame  ┘
```

Connect `source` to the **same image you fed into PW Outpaint**, and `frame` to PW Outpaint's `frame` output — the stitch then knows exactly where the original sits inside the generated canvas and pastes it back pixel-perfect with a feathered seam.

Drag [`examples/pw_outpaint_klein9b.json`](examples/pw_outpaint_klein9b.json) into ComfyUI to see all of this pre-wired.

### Outputs

| Output | Type | What it is |
|---|---|---|
| `control_image` | IMAGE | The padded canvas with your image pasted in and the new area filled per `fill_mode` |
| `control_mask` | MASK | 1.0 where new content should be generated, 0.0 over the original image |
| `mask_image` | IMAGE | The mask rendered with your mask/bg colors (handy for edit-model prompts like "replace the red area") |
| `width` / `height` | INT | Final canvas dimensions |
| `frame` | PW_FRAME | The framing data (paddings + source size) — feed it to **PW Outpaint Stitch** |

### Node options

| Widget | Default | Notes |
|---|---|---|
| `grid_snap` | 16 | Snap step for the editor. Keep 16 for Flux.2 Klein / Qwen; 8 is fine for SD1.5/SDXL |
| `fill_mode` | gray | How the empty area of `control_image` is filled. `edge_extend` and `mirror_blur` give the sampler more to work with; `solid_color` + a bold color works well with edit models ("eliminate the red area...") |
| `mask_feather` | 0 | Gaussian feather radius (px) on the mask seam. The fully-new region always stays solid |
| `mask_expand` | 0 | Grows the mask into the original image so generation overlaps the seam — great for hiding hard edges |
| `pad_left/top/right/bottom` | 0 | The frame itself. Managed by the editor, but they're ordinary widgets — scriptable via the API |

## PW Outpaint Stitch — keep the original pixel-perfect

Sampling an outpaint pushes the *whole* canvas through the VAE, which subtly shifts every pixel — even the ones that were never masked. **PW Outpaint Stitch** fixes that: after generation, it pastes your untouched original image back into its exact spot, with a feathered seam so the transition into the generated area stays invisible. See [Wiring it into a workflow](#wiring-it-into-a-workflow) for the hookup.

`seam_feather` (default 24) controls how many pixels of the source edge blend into the generated area. It also auto-corrects small size drift if your sampler returned a slightly different resolution.

### Batch mode

Toggle **Batch on** before Accept and your framing is remembered. Every following run in the queue applies it automatically without pausing — paddings are size-agnostic, so mixed image sizes are fine. When the queue finishes, the node resets itself.

### Presets

**Save preset** stores the current paddings, anchor, and colors under a name. **Load preset** applies one. Presets live in the node's `presets/` folder as plain JSON.

## Flux.2 Klein example

An example workflow is included in [`examples/pw_outpaint_klein9b.json`](examples/pw_outpaint_klein9b.json) — drag it into ComfyUI. It follows the [Klein wiring](#flux2-klein-what-the-example-workflow-does) above, with PW Outpaint Stitch already on the end. You'll need to point the loader nodes at your own Klein 9B checkpoint, Flux.2 VAE, and text encoder — the filenames in the example are placeholders.

## License

[MIT](LICENSE)
