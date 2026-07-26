try:
    from .pw_outpaint import NODE_CLASS_MAPPINGS as _outpaint_nodes, NODE_DISPLAY_NAME_MAPPINGS as _outpaint_names
    from .pw_stitch import NODE_CLASS_MAPPINGS as _stitch_nodes, NODE_DISPLAY_NAME_MAPPINGS as _stitch_names
    from .pw_band_meter import NODE_CLASS_MAPPINGS as _meter_nodes, NODE_DISPLAY_NAME_MAPPINGS as _meter_names
    from .pw_banded_colormatch import NODE_CLASS_MAPPINGS as _cmatch_nodes, NODE_DISPLAY_NAME_MAPPINGS as _cmatch_names
except ImportError:  # loaded outside the package (tests)
    from pw_outpaint import NODE_CLASS_MAPPINGS as _outpaint_nodes, NODE_DISPLAY_NAME_MAPPINGS as _outpaint_names
    from pw_stitch import NODE_CLASS_MAPPINGS as _stitch_nodes, NODE_DISPLAY_NAME_MAPPINGS as _stitch_names
    from pw_band_meter import NODE_CLASS_MAPPINGS as _meter_nodes, NODE_DISPLAY_NAME_MAPPINGS as _meter_names
    from pw_banded_colormatch import NODE_CLASS_MAPPINGS as _cmatch_nodes, NODE_DISPLAY_NAME_MAPPINGS as _cmatch_names

NODE_CLASS_MAPPINGS = {**_outpaint_nodes, **_stitch_nodes, **_meter_nodes, **_cmatch_nodes}
NODE_DISPLAY_NAME_MAPPINGS = {**_outpaint_names, **_stitch_names, **_meter_names, **_cmatch_names}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
