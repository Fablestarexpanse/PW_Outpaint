// PW Band Meter - render the QC report on the node after execution.

import { app } from "../../scripts/app.js";

const NODE_CLASS = "PWBandMeter";

app.registerExtension({
    name: "PWBandMeter",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        const origOnExecuted = nodeType.prototype.onExecuted;

        nodeType.prototype.onExecuted = function (message) {
            origOnExecuted?.apply(this, arguments);
            const text = Array.isArray(message?.text) ? message.text.join("") : "";
            if (!text) return;

            if (!this._pwReportEl) {
                const pre = document.createElement("pre");
                pre.style.cssText = [
                    "margin:0", "padding:6px 8px", "width:100%", "box-sizing:border-box",
                    "overflow:auto", "font-family:monospace", "font-size:10px",
                    "line-height:1.45", "color:#cccccc", "background:rgba(0,0,0,0.35)",
                    "border:1px solid rgba(255,255,255,0.08)", "border-radius:8px",
                    "white-space:pre",
                ].join(";");
                this._pwReportEl = pre;
                const widget = this.addDOMWidget("report_view", "custom", pre, { serialize: false, hideOnZoom: false });
                widget.computeSize = () => {
                    const lines = (this._pwReportEl.textContent.match(/\n/g) || []).length + 1;
                    return [480, Math.min(300, lines * 15 + 20)];
                };
            }
            this._pwReportEl.textContent = text;
            const cs = this.computeSize();
            this.setSize([Math.max(this.size[0], 500), Math.max(this.size[1], cs[1])]);
            this.graph?.setDirtyCanvas(true, true);
        };
    },
});
