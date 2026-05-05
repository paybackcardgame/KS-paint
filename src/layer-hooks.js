// @ts-check
/* global main_canvas, main_ctx */

/**
 * KS-Paint Layer Integration
 *
 * Painting targets the active layer buffer directly (see getPaintingCtx in app.js).
 * Before each history snapshot, buffers are composited onto main_canvas.
 * Locked layers block new undoable actions.
 */

import { $G } from "./helpers.js";
import { layerManager } from "./layers.js";
import { setBeforeUndoableCanvasSnapshot, setUndoableInterceptor } from "./functions.js";

let _hooked = false;

/**
 * Context used for raster tools: active layer when the system is ready, else main_ctx.
 * @returns {CanvasRenderingContext2D}
 */
export function getPaintingCtx() {
	if (layerManager._initialized && layerManager.activeLayer && !layerManager.activeLayer.locked) {
		return layerManager.activeLayer.ctx;
	}
	return main_ctx;
}

export function hookLayers() {
	if (_hooked) return;
	_hooked = true;

	setBeforeUndoableCanvasSnapshot(() => {
		if (layerManager._initialized) {
			layerManager.composite();
		}
	});

	setUndoableInterceptor((_meta, _callback) => {
		if (layerManager._initialized && layerManager.activeLayer?.locked) {
			window.console?.warn(`Layer "${layerManager.activeLayer.name}" is locked.`);
			return false;
		}
	});

	$G.on("session-update", () => {
		if (!layerManager._initialized) {
			layerManager.init();
			$G.triggerHandler("layers-init");
		}
	});

	$G.on("history-jumped", () => {
		if (layerManager._initialized) {
			layerManager.absorbFlatMainIntoStack();
		}
	});

	const origResizeCanvas = window.resize_canvas_and_save_dimensions;
	if (origResizeCanvas) {
		window.resize_canvas_and_save_dimensions = function (...args) {
			const result = origResizeCanvas.apply(this, args);
			if (layerManager._initialized) {
				layerManager.resizeAll(main_canvas.width, main_canvas.height);
			}
			return result;
		};
	}

	let compositeTimeout = null;
	function scheduleComposite() {
		if (compositeTimeout) return;
		compositeTimeout = setTimeout(() => {
			compositeTimeout = null;
			if (layerManager._initialized) {
				layerManager.composite();
			}
		}, 50);
	}

	document.addEventListener("pointerup", () => {
		if (layerManager._initialized) {
			scheduleComposite();
		}
	});

	window.console?.log("[KS-Paint] Layer hooks installed");
}
