// @ts-check
/* global active_layer_id:writable, layers:writable */
/* global main_canvas, main_ctx */

import { $G, make_canvas } from "./helpers.js";

let next_layer_id = 1;
/** @type {Set<string>} */
const dirty_layer_ids = new Set();

/**
 * Keep the auto-increment counter above any restored or explicit layer id
 * so new layers never collide with existing ones after undo/session load.
 * @param {string} [id]
 */
function note_layer_id(id) {
	const match = /^layer-(\d+)$/.exec(String(id || ""));
	if (match) {
		next_layer_id = Math.max(next_layer_id, Number(match[1]) + 1);
	}
}

function allocate_layer_id() {
	let id;
	do {
		id = `layer-${next_layer_id++}`;
	} while (layers.some((layer) => layer.id === id));
	return id;
}

function next_layer_name() {
	const used = new Set(layers.map((layer) => layer.name));
	let n = 1;
	let name;
	do {
		name = `Layer ${n++}`;
	} while (used.has(name));
	return name;
}

function uniquify_layer_ids() {
	const seen = new Set();
	for (const layer of layers) {
		if (!layer.id || seen.has(layer.id)) {
			layer.id = allocate_layer_id();
		}
		seen.add(layer.id);
		note_layer_id(layer.id);
	}
	if (active_layer_id && !layers.some((layer) => layer.id === active_layer_id)) {
		active_layer_id = layers[layers.length - 1]?.id;
	}
}

/**
 * @param {string} [id]
 */
function mark_layer_dirty(id = active_layer_id) {
	if (id) {
		dirty_layer_ids.add(id);
	}
}

function mark_all_layers_dirty() {
	for (const layer of layers) {
		dirty_layer_ids.add(layer.id);
	}
}

/**
 * @param {Partial<PaintLayer> & { canvas?: HTMLImageElement | PixelCanvas, image_data?: ImageData }} [options]
 * @returns {PaintLayer}
 */
function make_layer(options = {}) {
	const canvas = options.canvas ? make_canvas(options.canvas) :
		options.image_data ? make_canvas(options.image_data) :
			make_canvas(main_canvas.width || 1, main_canvas.height || 1);
	const id = options.id || allocate_layer_id();
	note_layer_id(id);
	return {
		id,
		name: options.name || next_layer_name(),
		canvas,
		ctx: canvas.ctx,
		visible: options.visible !== false,
		opacity: Math.max(0, Math.min(1, options.opacity ?? 1)),
		locked: !!options.locked,
	};
}

function is_layer_locked(id = active_layer_id) {
	const layer = layers.find((candidate) => candidate.id === id) || get_active_layer();
	return !!(layer && layer.locked);
}

function warn_layer_locked() {
	if (window.$status_text) {
		window.$status_text.text("The layer is locked");
	}
}

function block_if_active_layer_locked() {
	if (is_layer_locked()) {
		warn_layer_locked();
		return true;
	}
	return false;
}

function get_active_layer() {
	return layers.find((layer) => layer.id === active_layer_id) || layers[layers.length - 1];
}

function get_active_layer_context() {
	const layer = get_active_layer();
	if (!layer) {
		throw new Error("The document has no paint layer.");
	}
	mark_layer_dirty(layer.id);
	return layer.ctx;
}

function notify_layers_changed() {
	uniquify_layer_ids();
	$G.triggerHandler("layers-changed");
}

function composite_layers() {
	main_ctx.save();
	main_ctx.setTransform(1, 0, 0, 1, 0, 0);
	main_ctx.globalCompositeOperation = "source-over";
	main_ctx.globalAlpha = 1;
	main_ctx.clearRect(0, 0, main_canvas.width, main_canvas.height);
	for (const layer of layers) {
		if (!layer.visible || layer.opacity <= 0) {
			continue;
		}
		main_ctx.globalAlpha = layer.opacity;
		main_ctx.drawImage(layer.canvas, 0, 0);
	}
	main_ctx.restore();
	$G.triggerHandler("layers-composited");
}

/**
 * Sample the visible color at a canvas pixel (all layers composited).
 * Call composite_layers() first if the document may have changed since the last composite.
 * @param {number} x
 * @param {number} y
 * @returns {string} CSS rgba color, or "white" if the point is outside the canvas
 */
function sample_composite_color(x, y) {
	if (x >= 0 && y >= 0 && x < main_canvas.width && y < main_canvas.height) {
		const [r, g, b, a] = main_ctx.getImageData(~~x, ~~y, 1, 1).data;
		return `rgba(${r},${g},${b},${a / 255})`;
	}
	return "white";
}

/**
 * Draws every visible layer except the active one. Used to preview erasing the active layer.
 * @param {CanvasRenderingContext2D} ctx
 */
function draw_layers_except_active(ctx) {
	ctx.save();
	ctx.globalCompositeOperation = "source-over";
	for (const layer of layers) {
		if (layer.id === active_layer_id || !layer.visible || layer.opacity <= 0) {
			continue;
		}
		ctx.globalAlpha = layer.opacity;
		ctx.drawImage(layer.canvas, 0, 0);
	}
	ctx.restore();
}

/**
 * Replaces the document with one layer copied from the supplied bitmap.
 * @param {HTMLImageElement | HTMLCanvasElement | ImageData} source
 * @param {string} [name]
 */
function initialize_layer_stack(source, name = "Background") {
	const canvas = make_canvas(source);
	if (main_canvas.width !== canvas.width || main_canvas.height !== canvas.height) {
		main_canvas.width = canvas.width;
		main_canvas.height = canvas.height;
		main_ctx.disable_image_smoothing();
	}
	const layer = make_layer({ name, canvas, locked: true });
	layers = [layer];
	active_layer_id = layer.id;
	mark_all_layers_dirty();
	composite_layers();
	notify_layers_changed();
}

/**
 * @param {{name?: string, canvas: PixelCanvas, visible?: boolean, opacity?: number, locked?: boolean}[]} source_layers
 */
function initialize_layer_stack_from_layers(source_layers) {
	if (!source_layers.length) {
		throw new Error("A document must contain at least one layer.");
	}
	const width = source_layers[0].canvas.width;
	const height = source_layers[0].canvas.height;
	main_canvas.width = width;
	main_canvas.height = height;
	main_ctx.disable_image_smoothing();
	layers = source_layers.map((source) => make_layer(source));
	active_layer_id = layers[layers.length - 1].id;
	mark_all_layers_dirty();
	composite_layers();
	notify_layers_changed();
}

/**
 * @param {Partial<PaintLayer> & { canvas?: HTMLImageElement | PixelCanvas, image_data?: ImageData }} [options]
 * @param {number} [index]
 */
function add_layer(options = {}, index = layers.length) {
	const layer_options = (options.id && layers.some((layer) => layer.id === options.id)) ?
		{ ...options, id: undefined } :
		options;
	const layer = make_layer(layer_options);
	index = Math.max(0, Math.min(layers.length, index));
	layers.splice(index, 0, layer);
	active_layer_id = layer.id;
	mark_layer_dirty(layer.id);
	composite_layers();
	notify_layers_changed();
	return layer;
}

/**
 * @param {string} name
 * @returns {string}
 */
function next_copy_name(name) {
	const base = String(name || "Layer").replace(/(?: copy(?: \d+)?)$/i, "");
	const used = new Set(layers.map((layer) => layer.name));
	let candidate = `${base} copy`;
	let n = 2;
	while (used.has(candidate)) {
		candidate = `${base} copy ${n++}`;
	}
	return candidate;
}

/**
 * Insert a copy of the layer directly above it and select the copy.
 * @param {string} [id]
 * @returns {PaintLayer | null}
 */
function duplicate_layer(id = active_layer_id) {
	const index = layers.findIndex((layer) => layer.id === id);
	if (index < 0) {
		return null;
	}
	const source = layers[index];
	return add_layer({
		name: next_copy_name(source.name),
		canvas: make_canvas(source.canvas),
		visible: source.visible,
		opacity: source.opacity,
		locked: false,
	}, index + 1);
}

/**
 * @param {string} id
 */
function select_layer(id) {
	if (!layers.some((layer) => layer.id === id) || active_layer_id === id) {
		return;
	}
	active_layer_id = id;
	$G.triggerHandler("layers-selection-changed");
}

/**
 * @param {string} [id]
 */
function delete_layer(id = active_layer_id) {
	if (layers.length <= 1) {
		return false;
	}
	const index = layers.findIndex((layer) => layer.id === id);
	if (index < 0 || layers[index].locked) {
		if (index >= 0 && layers[index].locked) {
			warn_layer_locked();
		}
		return false;
	}
	layers.splice(index, 1);
	active_layer_id = layers[Math.min(index, layers.length - 1)].id;
	mark_all_layers_dirty();
	composite_layers();
	notify_layers_changed();
	return true;
}

/**
 * @param {string} id
 * @param {number} new_index
 */
function move_layer(id, new_index) {
	const old_index = layers.findIndex((layer) => layer.id === id);
	if (old_index < 0) {
		return false;
	}
	const [layer] = layers.splice(old_index, 1);
	new_index = Math.max(0, Math.min(layers.length, new_index));
	layers.splice(new_index, 0, layer);
	composite_layers();
	notify_layers_changed();
	return true;
}

/**
 * @param {string} id
 * @param {string} name
 */
function rename_layer(id, name) {
	const layer = layers.find((candidate) => candidate.id === id);
	if (!layer || !name.trim()) {
		return false;
	}
	layer.name = name.trim();
	notify_layers_changed();
	return true;
}

/**
 * @param {string} id
 * @param {boolean} visible
 */
function set_layer_visibility(id, visible) {
	const layer = layers.find((candidate) => candidate.id === id);
	if (!layer) {
		return false;
	}
	layer.visible = visible;
	composite_layers();
	notify_layers_changed();
	return true;
}

/**
 * @param {string} id
 * @param {number} opacity
 */
function set_layer_opacity(id, opacity) {
	const layer = layers.find((candidate) => candidate.id === id);
	if (!layer) {
		return false;
	}
	layer.opacity = Math.max(0, Math.min(1, opacity));
	composite_layers();
	notify_layers_changed();
	return true;
}

/**
 * @param {string} id
 * @param {boolean} locked
 */
function set_layer_locked(id, locked) {
	const layer = layers.find((candidate) => candidate.id === id);
	if (!layer) {
		return false;
	}
	layer.locked = !!locked;
	notify_layers_changed();
	return true;
}

function merge_layer_down() {
	const index = layers.findIndex((layer) => layer.id === active_layer_id);
	if (index <= 0) {
		return false;
	}
	const upper = layers[index];
	const lower = layers[index - 1];
	lower.ctx.save();
	lower.ctx.globalAlpha = upper.opacity;
	if (upper.visible) {
		lower.ctx.drawImage(upper.canvas, 0, 0);
	}
	lower.ctx.restore();
	lower.name = upper.name;
	layers.splice(index, 1);
	active_layer_id = lower.id;
	mark_layer_dirty(lower.id);
	composite_layers();
	notify_layers_changed();
	return true;
}

function flatten_layers() {
	composite_layers();
	const flattened = make_layer({
		name: "Background",
		canvas: make_canvas(main_canvas),
		visible: true,
		opacity: 1,
		locked: true,
	});
	layers = [flattened];
	active_layer_id = flattened.id;
	mark_all_layers_dirty();
	composite_layers();
	notify_layers_changed();
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 */
function crop_layer_stack(x, y, width, height) {
	for (const layer of layers) {
		const cropped = make_canvas(width, height);
		cropped.ctx.drawImage(layer.canvas, -x, -y);
		layer.canvas = cropped;
		layer.ctx = cropped.ctx;
	}
	main_canvas.width = width;
	main_canvas.height = height;
	main_ctx.disable_image_smoothing();
	mark_all_layers_dirty();
	composite_layers();
	notify_layers_changed();
}

/**
 * Grow or shrink every layer's canvas. Existing pixels stay put; new area is transparent.
 * Does not flatten layers or fill with a background color.
 * @param {number} width
 * @param {number} height
 * @param {string | CanvasPattern | null} [_background] unused; kept so old callers stay valid
 */
function resize_layer_stack(width, height, _background = null) {
	width = Math.max(1, width);
	height = Math.max(1, height);
	for (const layer of layers) {
		const old = make_canvas(layer.canvas);
		layer.canvas.width = width;
		layer.canvas.height = height;
		layer.ctx.disable_image_smoothing();
		layer.ctx.clearRect(0, 0, width, height);
		layer.ctx.drawImage(old, 0, 0);
	}
	main_canvas.width = width;
	main_canvas.height = height;
	main_ctx.disable_image_smoothing();
	mark_all_layers_dirty();
	composite_layers();
	notify_layers_changed();
}

/**
 * @param {LayerSnapshot[] | null | undefined} [previous_snapshots]
 */
function snapshot_layers(previous_snapshots = null) {
	const previous_by_id = new Map((previous_snapshots || []).map((snapshot) => [snapshot.id, snapshot]));
	const snapshots = layers.map((layer) => {
		const previous = previous_by_id.get(layer.id);
		const can_reuse = previous &&
			!dirty_layer_ids.has(layer.id) &&
			previous.image_data &&
			previous.image_data.width === layer.canvas.width &&
			previous.image_data.height === layer.canvas.height;
		return {
			id: layer.id,
			name: layer.name,
			visible: layer.visible,
			opacity: layer.opacity,
			locked: !!layer.locked,
			image_data: can_reuse ?
				previous.image_data :
				layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
		};
	});
	dirty_layer_ids.clear();
	return snapshots;
}

/**
 * @param {LayerSnapshot[]} snapshots
 * @param {string} [selected_id]
 */
function restore_layer_snapshot(snapshots, selected_id) {
	if (!snapshots?.length) {
		return;
	}
	layers = snapshots.map((snapshot) => make_layer(snapshot));
	active_layer_id = layers.some((layer) => layer.id === selected_id) ? selected_id : layers[layers.length - 1].id;
	const width = layers[0].canvas.width;
	const height = layers[0].canvas.height;
	if (main_canvas.width !== width || main_canvas.height !== height) {
		main_canvas.width = width;
		main_canvas.height = height;
		main_ctx.disable_image_smoothing();
	}
	dirty_layer_ids.clear();
	composite_layers();
	notify_layers_changed();
}

/**
 * Serialize the layer stack for local session backup.
 */
function serialize_layers_document() {
	composite_layers();
	return {
		version: 1,
		width: main_canvas.width,
		height: main_canvas.height,
		active_layer_id,
		layers: layers.map((layer) => ({
			id: layer.id,
			name: layer.name,
			visible: layer.visible,
			opacity: layer.opacity,
			locked: !!layer.locked,
			data_url: layer.canvas.toDataURL("image/png"),
		})),
	};
}

/**
 * @param {any} document_json
 * @returns {Promise<{name?: string, canvas: PixelCanvas, visible?: boolean, opacity?: number, locked?: boolean}[]>}
 */
async function deserialize_layers_document(document_json) {
	if (!document_json?.layers?.length) {
		throw new Error("Invalid layered session document.");
	}
	const loaded = [];
	for (const source of document_json.layers) {
		const image = await new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error(`Failed to decode layer "${source.name || source.id}".`));
			img.src = source.data_url;
		});
		const canvas = make_canvas(document_json.width || image.width, document_json.height || image.height);
		canvas.ctx.drawImage(image, 0, 0);
		loaded.push({
			id: source.id,
			name: source.name,
			visible: source.visible !== false,
			opacity: source.opacity ?? 1,
			locked: source.locked ?? source.name === "Background",
			canvas,
		});
	}
	return loaded;
}

export {
	add_layer,
	block_if_active_layer_locked,
	duplicate_layer,
	composite_layers,
	crop_layer_stack,
	delete_layer,
	draw_layers_except_active,
	deserialize_layers_document,
	flatten_layers,
	get_active_layer,
	get_active_layer_context,
	initialize_layer_stack,
	initialize_layer_stack_from_layers,
	is_layer_locked,
	make_layer,
	mark_all_layers_dirty,
	mark_layer_dirty,
	merge_layer_down,
	move_layer,
	rename_layer,
	resize_layer_stack,
	restore_layer_snapshot,
	sample_composite_color,
	select_layer,
	serialize_layers_document,
	set_layer_locked,
	set_layer_opacity,
	set_layer_visibility,
	snapshot_layers
};
