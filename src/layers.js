// @ts-check
/* global main_canvas, main_ctx, $canvas_area */

/**
 * KS-Paint Layer System
 *
 * Manages 3 named layers (Sketch, Outline, Color), each backed by its own
 * offscreen canvas. The visible result is composited onto main_canvas after
 * every mutation.
 *
 * Public API consumed by $LayerBox and by tool hooks:
 *   layerManager.layers           – ordered array (bottom → top)
 *   layerManager.activeLayer      – the layer being drawn on
 *   layerManager.setActive(id)
 *   layerManager.toggleVisibility(id)
 *   layerManager.toggleSolo(id)
 *   layerManager.toggleLock(id)
 *   layerManager.reorder(fromIdx, toIdx)
 *   layerManager.composite()
 *   layerManager.getActiveCtx()
 *   layerManager.getCompositeSampleCanvas() – for "sample all" fill
 */

import { $G, make_canvas } from "./helpers.js";

// ── Layer class ─────────────────────────────────────────────────────
class Layer {
	/**
	 * @param {string} id
	 * @param {string} name
	 * @param {number} w
	 * @param {number} h
	 */
	constructor(id, name, w, h) {
		this.id = id;
		this.name = name;
		this.canvas = make_canvas(w, h);
		this.ctx = this.canvas.ctx;
		this.visible = true;   // bypass = !visible
		this.locked = false;
		this.solo = false;
		this.opacity = 1;
	}

	resize(w, h) {
		const old = make_canvas(this.canvas);
		this.canvas.width = w;
		this.canvas.height = h;
		this.ctx.drawImage(old, 0, 0);
	}
}

// ── LayerManager ────────────────────────────────────────────────────
class LayerManager {
	constructor() {
		/** @type {Layer[]} bottom-to-top draw order */
		this.layers = [];
		/** @type {Layer|null} */
		this.activeLayer = null;
		/** @type {Function[]} */
		this._listeners = [];

		this._initialized = false;
	}

	// Call once main_canvas exists and has dimensions
	init() {
		if (this._initialized) return;
		const w = main_canvas.width;
		const h = main_canvas.height;

		// Create the three default layers (bottom to top)
		const color   = new Layer("color",   "Color",   w, h);
		const outline = new Layer("outline", "Outline", w, h);
		const sketch  = new Layer("sketch",  "Sketch",  w, h);

		this.layers = [color, outline, sketch]; // bottom → top
		this.activeLayer = sketch;

		// Copy whatever is already on main_canvas into the active layer
		this.activeLayer.ctx.drawImage(main_canvas, 0, 0);

		this._initialized = true;
		this._notify();
	}

	// ── Queries ──────────────────────────────────────────────────────
	getLayer(id) {
		return this.layers.find(l => l.id === id) ?? null;
	}

	getActiveCtx() {
		return this.activeLayer?.ctx ?? main_ctx;
	}

	/** Returns true if any layer has solo turned on */
	hasSolo() {
		return this.layers.some(l => l.solo);
	}

	/** Is a layer effectively visible? (considers solo state) */
	isEffectivelyVisible(layer) {
		if (this.hasSolo()) {
			return layer.solo;
		}
		return layer.visible;
	}

	// ── Mutations ────────────────────────────────────────────────────
	setActive(id) {
		const layer = this.getLayer(id);
		if (layer) {
			this.activeLayer = layer;
			this._notify();
		}
	}

	toggleVisibility(id) {
		const layer = this.getLayer(id);
		if (layer) {
			layer.visible = !layer.visible;
			this.composite();
			this._notify();
		}
	}

	toggleSolo(id) {
		const layer = this.getLayer(id);
		if (layer) {
			layer.solo = !layer.solo;
			this.composite();
			this._notify();
		}
	}

	toggleLock(id) {
		const layer = this.getLayer(id);
		if (layer) {
			layer.locked = !layer.locked;
			this._notify();
		}
	}

	reorder(fromIdx, toIdx) {
		if (fromIdx === toIdx) return;
		const [item] = this.layers.splice(fromIdx, 1);
		this.layers.splice(toIdx, 0, item);
		this.composite();
		this._notify();
	}

	/**
	 * Resize all layer canvases. Called when the document size changes.
	 */
	resizeAll(w, h) {
		for (const layer of this.layers) {
			layer.resize(w, h);
		}
		this.composite();
	}

	/**
	 * After undo/redo restores a flat main_canvas, rebuild layer buffers so they match that image.
	 * Puts the document on the bottom (Color) layer and clears upper layers.
	 */
	absorbFlatMainIntoStack() {
		if (!this._initialized) return;
		const w = main_canvas.width;
		const h = main_canvas.height;
		for (let i = 1; i < this.layers.length; i++) {
			this.layers[i].ctx.clearRect(0, 0, w, h);
		}
		this.layers[0].ctx.clearRect(0, 0, w, h);
		this.layers[0].ctx.drawImage(main_canvas, 0, 0);
		this.composite();
		this._notify();
	}

	// ── Compositing ─────────────────────────────────────────────────
	/**
	 * Flatten all visible layers onto main_canvas.
	 * Call this after any drawing operation.
	 */
	composite() {
		if (!this._initialized) return;
		const w = main_canvas.width;
		const h = main_canvas.height;

		main_ctx.clearRect(0, 0, w, h);

		// Draw checkerboard or white background
		main_ctx.fillStyle = "#ffffff";
		main_ctx.fillRect(0, 0, w, h);

		// Composite bottom → top
		for (const layer of this.layers) {
			if (!this.isEffectivelyVisible(layer)) continue;
			main_ctx.globalAlpha = layer.opacity;
			main_ctx.drawImage(layer.canvas, 0, 0);
		}
		main_ctx.globalAlpha = 1;
	}

	/**
	 * Create a temporary canvas that composites all visible layers.
	 * Used for "sample all layers" in the fill tool.
	 */
	getCompositeSampleCanvas() {
		const w = main_canvas.width;
		const h = main_canvas.height;
		const temp = make_canvas(w, h);
		const tctx = temp.ctx;

		tctx.fillStyle = "#ffffff";
		tctx.fillRect(0, 0, w, h);

		for (const layer of this.layers) {
			if (!this.isEffectivelyVisible(layer)) continue;
			tctx.globalAlpha = layer.opacity;
			tctx.drawImage(layer.canvas, 0, 0);
		}
		tctx.globalAlpha = 1;
		return temp;
	}

	// ── Change listeners ────────────────────────────────────────────
	onChange(fn) {
		this._listeners.push(fn);
	}

	_notify() {
		for (const fn of this._listeners) {
			try { fn(); } catch (e) { console.error(e); }
		}
	}
}

const layerManager = new LayerManager();
export { layerManager, Layer };

// Make it available globally for non-module scripts
window.layerManager = layerManager;
