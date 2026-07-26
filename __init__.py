from .pw_outpaint import NODE_CLASS_MAPPINGS as _outpaint_nodes, NODE_DISPLAY_NAME_MAPPINGS as _outpaint_names
from .pw_stitch import NODE_CLASS_MAPPINGS as _stitch_nodes, NODE_DISPLAY_NAME_MAPPINGS as _stitch_names

NODE_CLASS_MAPPINGS = {**_outpaint_nodes, **_stitch_nodes}
NODE_DISPLAY_NAME_MAPPINGS = {**_outpaint_names, **_stitch_names}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
