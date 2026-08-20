// @ts-check
/* global $left, $right, active_layer_id, get_direction, layers, localize */

import { $Component } from "./$Component.js";
import { undoable } from "./functions.js";
import { $G, E, make_canvas } from "./helpers.js";
import {
	add_layer,
	delete_layer,
	duplicate_layer,
	merge_layer_down,
	move_layer,
	rename_layer,
	select_layer,
	set_layer_locked,
	set_layer_opacity,
	set_layer_visibility
} from "./layers.js";

/** @type {(JQuery<HTMLDivElement> & I$Component) | null} */
let $layersbox = null;

/** @type {JQuery<HTMLDivElement> | null} */
let $layers_list = null;
/** @type {JQuery<HTMLInputElement> | null} */
let $opacity_input = null;
/** @type {JQuery<HTMLInputElement> | null} */
let $opacity_value = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $lock_button = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $merge_button = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $delete_button = null;

const DRAG_THRESHOLD_PX = 4;
const THUMB_WIDTH = 32;
const THUMB_HEIGHT = 32;
// Double click is detected manually because the row's pointerdown handler calls preventDefault()
// (to suppress text selection while dragging), which also suppresses the compatibility
// mousedown/click/dblclick events. PointerEvent.detail is always 0, so it can't be used either.
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 4;

const EYE_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6 2.1C3.2 2.1 1.2 5.4 1 6c.2.6 2.2 3.9 5 3.9S10.8 6.6 11 6c-.2-.6-2.2-3.9-5-3.9zm0 6.2A2.3 2.3 0 1 1 6 3.7a2.3 2.3 0 0 1 0 4.6z"/><circle fill="currentColor" cx="6" cy="6" r="1.25"/></svg>`;
const LOCK_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M4 5.2V3.6A2 2 0 0 1 8 3.6v1.6h1.2V11H2.8V5.2H4zm1.2 0h1.6V3.6a.8.8 0 0 0-1.6 0v1.6z"/></svg>`;
const MERGE_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" d="M2.5 1.5h7v3h-7z"/><path fill="currentColor" d="M2.5 7.5h7v3h-7z" opacity="0.4"/><path fill="none" stroke="currentColor" stroke-linejoin="round" d="M6 2.75v6M4.25 6.75L6 8.5l1.75-1.75"/></svg>`;
const NEW_LAYER_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" d="M3 1.5h4l2.5 2.5V10.5H3z"/><path fill="none" stroke="currentColor" d="M7 1.5V4h2.5"/><path stroke="currentColor" d="M6 5.75v3.5M4.25 7.5h3.5"/></svg>`;
const DUPLICATE_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" d="M2.5 3.5h6v7h-6z"/><path fill="none" stroke="currentColor" d="M4 1.5h6v7"/></svg>`;
const DELETE_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M4 0h4v1h3v2H1V1h3V0zm1 1h2V0H5v1zM2 4h8l-1 8H3L2 4zm2 1v6h1V5H4zm3 0v6h1V5H7z"/></svg>`;

/**
 * @typedef {object} LayerDragState
 * @property {string} id
 * @property {number} pointer_id
 * @property {number} from_index
 * @property {number} to_index
 * @property {number} start_content_y
 * @property {number} height
 * @property {number[]} offset_tops
 * @property {HTMLElement[]} rows
 * @property {HTMLElement} list
 * @property {HTMLElement} row
 * @property {HTMLElement} source_row
 * @property {HTMLElement | null} duplicate_row
 * @property {boolean} duplicate
 * @property {boolean} active
 * @property {number} last_client_y
 */

/** @type {LayerDragState | null} */
let layer_drag = null;
let drag_raf = 0;

/** @type {{ id: string, time: number, x: number, y: number } | null} */
let last_name_pointerdown = null;

function run_layer_action(name, action) {
	undoable({ name }, action);
}

/**
 * @param {JQuery.TriggeredEvent} event
 * @returns {PointerEvent}
 */
function pointer_from(event) {
	return /** @type {PointerEvent} */ (event.originalEvent || event);
}

/**
 * @param {number} opacity
 */
function opacity_percent(opacity) {
	return Math.round((opacity ?? 1) * 100);
}

/**
 * Tight box around non-transparent pixels, or the full canvas if the layer is empty.
 * @param {HTMLCanvasElement} canvas
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function layer_preview_bounds(canvas) {
	const width = canvas.width;
	const height = canvas.height;
	if (width < 1 || height < 1) {
		return { x: 0, y: 0, width: 1, height: 1 };
	}
	const { data } = canvas.getContext("2d").getImageData(0, 0, width, height);
	let min_x = width;
	let min_y = height;
	let max_x = -1;
	let max_y = -1;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] === 0) {
			continue;
		}
		const pixel = (i - 3) / 4;
		const x = pixel % width;
		const y = (pixel - x) / width;
		if (x < min_x) { min_x = x; }
		if (x > max_x) { max_x = x; }
		if (y < min_y) { min_y = y; }
		if (y > max_y) { max_y = y; }
	}
	if (max_x < 0) {
		return { x: 0, y: 0, width, height };
	}
	return { x: min_x, y: min_y, width: max_x - min_x + 1, height: max_y - min_y + 1 };
}

/**
 * @param {HTMLCanvasElement} thumbnail
 * @param {PaintLayer} layer
 */
function paint_thumbnail(thumbnail, layer) {
	const ctx = /** @type {PixelContext} */ (thumbnail.getContext("2d"));
	ctx.disable_image_smoothing();
	ctx.clearRect(0, 0, thumbnail.width, thumbnail.height);

	const bounds = layer_preview_bounds(layer.canvas);
	const thumb_w = thumbnail.width;
	const thumb_h = thumbnail.height;
	// Uniform scale so the preview covers the square (center-crop), never stretch.
	const scale = Math.max(thumb_w / bounds.width, thumb_h / bounds.height);
	const src_w = thumb_w / scale;
	const src_h = thumb_h / scale;
	const src_x = bounds.x + (bounds.width - src_w) / 2;
	const src_y = bounds.y + (bounds.height - src_h) / 2;
	ctx.drawImage(layer.canvas, src_x, src_y, src_w, src_h, 0, 0, thumb_w, thumb_h);
}

function refresh_layer_thumbnails() {
	if (!$layers_list) {
		return;
	}
	$layers_list.find(".layer-row").each((_i, row) => {
		const id = row.getAttribute("data-layer-id");
		const layer = layers.find((candidate) => candidate.id === id);
		const thumbnail = /** @type {HTMLCanvasElement | null} */ (row.querySelector(".layer-thumbnail"));
		if (layer && thumbnail) {
			paint_thumbnail(thumbnail, layer);
		}
	});
}

function update_selection_ui() {
	if (!$layers_list || !$opacity_input || !$opacity_value) {
		return;
	}
	$layers_list.find(".layer-row").each((_i, row) => {
		const selected = row.getAttribute("data-layer-id") === active_layer_id;
		row.classList.toggle("active", selected);
		row.setAttribute("aria-selected", String(selected));
	});
	const active = layers.find((layer) => layer.id === active_layer_id);
	const percent = opacity_percent(active?.opacity ?? 1);
	$opacity_input.val(String(percent));
	$opacity_value.val(`${percent}%`);
	if ($lock_button) {
		const locked = !!active?.locked;
		$lock_button.toggleClass("pressed", locked);
		$lock_button.attr({
			title: locked ? "Unlock layer" : "Lock layer",
			"aria-label": locked ? "Unlock layer" : "Lock layer",
			"aria-pressed": String(locked),
		});
	}
	if ($merge_button) {
		const index = layers.findIndex((layer) => layer.id === active_layer_id);
		$merge_button.prop("disabled", index <= 0);
	}
	if ($delete_button) {
		const can_delete = layers.length > 1 && !active?.locked;
		$delete_button.prop("disabled", !can_delete);
	}
}

/**
 * @param {HTMLElement} list
 * @param {number} client_y
 */
function content_y_for(list, client_y) {
	const rect = list.getBoundingClientRect();
	return client_y - rect.top + list.scrollTop;
}

function teardown_layer_drag() {
	if (drag_raf) {
		cancelAnimationFrame(drag_raf);
		drag_raf = 0;
	}
	if (!layer_drag) {
		return;
	}
	const { rows, list, row, source_row, duplicate_row, pointer_id } = layer_drag;
	layer_drag = null;
	for (const item of rows) {
		item.classList.remove("dragging");
		item.style.transform = "";
		item.style.zIndex = "";
	}
	if (duplicate_row?.parentNode) {
		duplicate_row.remove();
	}
	list.classList.remove("reordering");
	const capture_row = source_row || row;
	if (capture_row.hasPointerCapture?.(pointer_id)) {
		capture_row.releasePointerCapture(pointer_id);
	}
}

/**
 * @param {number} client_y
 * @returns {boolean}
 */
function auto_scroll_layers(client_y) {
	if (!layer_drag) {
		return false;
	}
	const { list } = layer_drag;
	const rect = list.getBoundingClientRect();
	const margin = 28;
	let delta = 0;
	if (client_y < rect.top + margin) {
		delta = -Math.max(2, Math.ceil((margin - (client_y - rect.top)) / 3));
	} else if (client_y > rect.bottom - margin) {
		delta = Math.max(2, Math.ceil((margin - (rect.bottom - client_y)) / 3));
	}
	if (!delta) {
		return false;
	}
	const previous = list.scrollTop;
	list.scrollTop += delta;
	return list.scrollTop !== previous;
}

/**
 * @param {number} client_y
 */
function apply_drag_preview(client_y) {
	if (!layer_drag) {
		return;
	}
	const { rows, from_index, height, offset_tops, start_content_y, list, row } = layer_drag;
	const offset_y = content_y_for(list, client_y) - start_content_y;
	const dragged_center = offset_tops[from_index] + height / 2 + offset_y;
	let to_index = from_index;
	for (let i = 0; i < rows.length; i++) {
		if (i === from_index) {
			continue;
		}
		const center = offset_tops[i] + height / 2;
		if (i < from_index && dragged_center < center) {
			to_index = Math.min(to_index, i);
		} else if (i > from_index && dragged_center > center) {
			to_index = Math.max(to_index, i);
		}
	}
	layer_drag.to_index = to_index;
	layer_drag.last_client_y = client_y;
	row.style.transform = `translateY(${offset_y}px)`;
	for (let i = 0; i < rows.length; i++) {
		if (i === from_index) {
			continue;
		}
		let shift = 0;
		if (i < from_index && i >= to_index) {
			shift = height;
		} else if (i > from_index && i <= to_index) {
			shift = -height;
		}
		rows[i].style.transform = shift ? `translateY(${shift}px)` : "";
	}
}

function tick_layer_drag() {
	drag_raf = 0;
	if (!layer_drag?.active) {
		return;
	}
	const client_y = layer_drag.last_client_y;
	const scrolled = auto_scroll_layers(client_y);
	apply_drag_preview(client_y);
	if (scrolled) {
		drag_raf = requestAnimationFrame(tick_layer_drag);
	}
}

/**
 * @param {HTMLElement} row
 * @param {PointerEvent} event
 */
/**
 * @param {LayerDragState} drag
 */
function insert_duplicate_preview_row(drag) {
	if (drag.duplicate_row) {
		return;
	}
	const original = drag.source_row;
	const clone = /** @type {HTMLElement} */ (original.cloneNode(true));
	clone.classList.add("layer-row-duplicate");
	clone.setAttribute("data-duplicate-preview", "true");
	clone.style.pointerEvents = "none";
	const source_thumb = /** @type {HTMLCanvasElement | null} */ (original.querySelector(".layer-thumbnail"));
	const clone_thumb = /** @type {HTMLCanvasElement | null} */ (clone.querySelector(".layer-thumbnail"));
	if (source_thumb && clone_thumb) {
		const ctx = clone_thumb.getContext("2d");
		ctx?.drawImage(source_thumb, 0, 0);
	}
	original.style.transform = "";
	original.style.zIndex = "";
	original.classList.remove("dragging");
	original.parentNode?.insertBefore(clone, original);
	drag.duplicate_row = clone;
	drag.row = clone;
	drag.duplicate = true;
	drag.rows = /** @type {HTMLElement[]} */ ([...drag.list.querySelectorAll(".layer-row")]);
	drag.from_index = drag.rows.indexOf(clone);
	drag.to_index = drag.from_index;
	drag.offset_tops = drag.rows.map((item) => item.offsetTop);
	drag.height = clone.offsetHeight;
}

/**
 * @param {PointerEvent} [event]
 */
function maybe_duplicate_layer_drag(event) {
	if (!layer_drag || layer_drag.duplicate) {
		return;
	}
	if (!(event?.altKey)) {
		return;
	}
	insert_duplicate_preview_row(layer_drag);
	if (layer_drag.active) {
		layer_drag.row.classList.add("dragging");
		layer_drag.row.style.zIndex = "2";
		apply_drag_preview(layer_drag.last_client_y);
	}
}

function begin_layer_drag_tracking(row, event) {
	if (!$layers_list || event.button !== 0 || layer_drag) {
		return;
	}
	const list = $layers_list[0];
	const rows = /** @type {HTMLElement[]} */ ([...list.querySelectorAll(".layer-row")]);
	const from_index = rows.indexOf(row);
	if (from_index < 0) {
		return;
	}
	layer_drag = {
		id: row.getAttribute("data-layer-id") || "",
		pointer_id: event.pointerId,
		from_index,
		to_index: from_index,
		start_content_y: content_y_for(list, event.clientY),
		height: row.offsetHeight,
		offset_tops: rows.map((item) => item.offsetTop),
		rows,
		list,
		row,
		source_row: row,
		duplicate_row: null,
		duplicate: false,
		active: false,
		last_client_y: event.clientY,
	};
	row.setPointerCapture(event.pointerId);
}

/**
 * @param {PointerEvent} [event]
 */
function activate_layer_drag(event) {
	if (!layer_drag || layer_drag.active) {
		return;
	}
	layer_drag.active = true;
	last_name_pointerdown = null; // a drag shouldn't count as the first click of a double click
	maybe_duplicate_layer_drag(event);
	layer_drag.list.classList.add("reordering");
	layer_drag.row.classList.add("dragging");
	layer_drag.row.style.zIndex = "2";
}

function finish_layer_drag() {
	if (!layer_drag) {
		return;
	}
	const { id, from_index, to_index, active, duplicate } = layer_drag;
	teardown_layer_drag();
	if (!active) {
		return;
	}
	if (duplicate) {
		run_layer_action("Duplicate Layer", () => {
			const copy = duplicate_layer(id);
			if (!copy) {
				return;
			}
			const stack_index = layers.length - 1 - to_index;
			if (layers.findIndex((layer) => layer.id === copy.id) !== stack_index) {
				move_layer(copy.id, stack_index);
			}
		});
		return;
	}
	if (from_index === to_index) {
		return;
	}
	run_layer_action("Reorder Layer", () => move_layer(id, layers.length - 1 - to_index));
}

/**
 * @param {JQuery<HTMLSpanElement>} $name
 * @param {PaintLayer} layer
 */
function start_rename($name, layer) {
	if ($name.find("input").length) {
		return;
	}
	teardown_layer_drag();
	const input = /** @type {HTMLInputElement} */ (E("input"));
	input.type = "text";
	input.className = "layer-name-input";
	input.value = layer.name;
	input.spellcheck = false;
	input.setAttribute("aria-label", "Layer name");
	const $row = $name.closest(".layer-row");
	$row.addClass("editing");
	$name.empty().append(input);
	input.focus();
	input.select();

	let finished = false;
	const finish = (commit) => {
		if (finished) {
			return;
		}
		finished = true;
		const next = commit ? String(input.value || "").trim() : layer.name;
		$row.removeClass("editing");
		if (!next || next === layer.name) {
			$name.empty().text(layer.name);
			return;
		}
		run_layer_action("Rename Layer", () => rename_layer(layer.id, next));
	};
	$(input).on("pointerdown dblclick", (event) => {
		event.stopPropagation();
	});
	$(input).on("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			input.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			finish(false);
		}
	});
	$(input).on("blur", () => finish(true));
}

/**
 * @param {object} options
 * @param {string} options.className
 * @param {string} options.title
 * @param {boolean} [options.pressed]
 * @param {string} [options.html]
 * @param {() => void} options.onClick
 * @returns {JQuery<HTMLButtonElement>}
 */
function layer_icon_button({ className, title, pressed, html, onClick }) {
	const $button = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).addClass(`layer-icon-button ${className}`).attr({
		type: "button",
		title,
		"aria-label": title,
		"aria-pressed": String(!!pressed),
	}).html(html || ""));
	$button.toggleClass("is-on", !!pressed);
	$button.on("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	});
	$button.on("pointerdown", (event) => {
		event.stopPropagation();
	});
	return $button;
}

function render_layers() {
	if (!$layers_list || !$opacity_input || !$opacity_value) {
		return;
	}
	teardown_layer_drag();
	const $list = $layers_list;
	$list.empty();

	[...layers].reverse().forEach((layer) => {
		const selected = layer.id === active_layer_id;
		const $row = $(E("div")).addClass("layer-row").toggleClass("active", selected).toggleClass("layer-hidden", !layer.visible).toggleClass("layer-locked", !!layer.locked).attr({
			role: "option",
			"aria-selected": String(selected),
			"data-layer-id": layer.id,
		});
		const $gutter = $(E("div")).addClass("layer-gutter");
		const $visible = layer_icon_button({
			className: "layer-visible",
			title: layer.visible ? "Hide layer" : "Show layer",
			pressed: layer.visible,
			html: layer.visible ? EYE_SVG : "",
			onClick: () => {
				run_layer_action(layer.visible ? "Hide Layer" : "Show Layer", () => {
					set_layer_visibility(layer.id, !layer.visible);
				});
			},
		});
		const $lock = layer_icon_button({
			className: "layer-lock",
			title: layer.locked ? "Unlock layer" : "Lock layer",
			pressed: !!layer.locked,
			html: layer.locked ? LOCK_SVG : "",
			onClick: () => {
				run_layer_action(layer.locked ? "Unlock Layer" : "Lock Layer", () => {
					set_layer_locked(layer.id, !layer.locked);
				});
			},
		});
		$gutter.append($visible, $lock);

		const $preview = $(E("div")).addClass("layer-preview");
		const thumbnail = make_canvas(THUMB_WIDTH, THUMB_HEIGHT);
		thumbnail.classList.add("layer-thumbnail");
		thumbnail.draggable = false;
		paint_thumbnail(thumbnail, layer);
		$preview.append(thumbnail);

		const $name = $(E("span")).addClass("layer-name").attr({
			title: "Double-click to rename",
		}).text(layer.name);

		$name.on("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			select_layer(layer.id);
			start_rename($name, layer);
		});
		$row.on("pointerdown", (event) => {
			const pointer = pointer_from(event);
			if (pointer.button !== 0 || $row.hasClass("editing")) {
				return;
			}
			if ($(event.target).closest(".layer-icon-button, .layer-name-input").length) {
				return;
			}
			const editing_input = /** @type {HTMLInputElement | null} */ ($layers_list?.[0].querySelector(".layer-name-input"));
			if (editing_input) {
				editing_input.blur();
				select_layer(layer.id);
				return;
			}
			event.preventDefault();
			select_layer(layer.id);
			if ($(event.target).closest(".layer-name").length) {
				const previous = last_name_pointerdown;
				const now = performance.now();
				last_name_pointerdown = { id: layer.id, time: now, x: pointer.clientX, y: pointer.clientY };
				if (
					previous &&
					previous.id === layer.id &&
					now - previous.time <= DOUBLE_CLICK_MS &&
					Math.abs(pointer.clientX - previous.x) <= DOUBLE_CLICK_SLOP_PX &&
					Math.abs(pointer.clientY - previous.y) <= DOUBLE_CLICK_SLOP_PX
				) {
					last_name_pointerdown = null;
					start_rename($name, layer);
					return;
				}
			} else {
				last_name_pointerdown = null;
			}
			begin_layer_drag_tracking($row[0], pointer);
		});
		$row.on("pointermove", (event) => {
			if (!layer_drag || layer_drag.source_row !== $row[0]) {
				return;
			}
			const pointer = pointer_from(event);
			layer_drag.last_client_y = pointer.clientY;
			const distance = Math.abs(content_y_for(layer_drag.list, pointer.clientY) - layer_drag.start_content_y);
			if (!layer_drag.active && distance >= DRAG_THRESHOLD_PX) {
				activate_layer_drag(pointer);
			}
			if (layer_drag.active) {
				maybe_duplicate_layer_drag(pointer);
				event.preventDefault();
				if (!drag_raf) {
					drag_raf = requestAnimationFrame(tick_layer_drag);
				}
				apply_drag_preview(pointer.clientY);
			}
		});
		$row.on("pointerup pointercancel lostpointercapture", (event) => {
			if (!layer_drag || layer_drag.source_row !== $row[0]) {
				return;
			}
			if (event.type === "pointercancel") {
				teardown_layer_drag();
				return;
			}
			finish_layer_drag();
		});
		$row.append($gutter, $preview, $name);
		$list.append($row);
	});
	update_selection_ui();
}

/**
 * @param {number} opacity
 */
function commit_opacity(opacity) {
	const id = active_layer_id;
	const active = layers.find((layer) => layer.id === id);
	const next = Math.max(0, Math.min(1, opacity));
	if (!active || Math.round(active.opacity * 100) === Math.round(next * 100)) {
		update_selection_ui();
		return;
	}
	run_layer_action("Layer Opacity", () => set_layer_opacity(id, next));
}

/**
 * @returns {JQuery<HTMLDivElement> & I$Component}
 */
function $LayersBox() {
	const $content = $(E("div")).addClass("layers-box");
	const $opacity_bar = $(E("label")).addClass("layer-opacity");
	const $opacity = /** @type {JQuery<HTMLInputElement>} */ ($(E("input")).addClass("layer-opacity-slider").attr({
		type: "range",
		min: "0",
		max: "100",
		step: "1",
		"aria-label": "Layer opacity",
	}));
	const $value = /** @type {JQuery<HTMLInputElement>} */ ($(E("input")).addClass("layer-opacity-value").attr({
		type: "text",
		inputmode: "numeric",
		maxlength: "4",
		autocomplete: "off",
		spellcheck: "false",
		"aria-label": "Layer opacity percent",
	}));
	$opacity_bar.append($(E("span")).addClass("layer-opacity-label").text("Opacity:"), $opacity, $value);

	const $list = $(E("div")).addClass("layers-list inset-deep").attr({
		role: "listbox",
		"aria-label": "Layers",
	});
	const $buttons = $(E("div")).addClass("layer-buttons");
	const $lock = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).attr({
		type: "button",
		title: "Lock layer",
		"aria-label": "Lock layer",
		"aria-pressed": "false",
	}).addClass("layer-lock-button").html(LOCK_SVG).on("click", () => {
		const active = layers.find((layer) => layer.id === active_layer_id);
		if (!active) {
			return;
		}
		run_layer_action(active.locked ? "Unlock Layer" : "Lock Layer", () => {
			set_layer_locked(active.id, !active.locked);
		});
	}));
	const $merge = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).attr({
		type: "button",
		title: "Merge down",
		"aria-label": "Merge down",
	}).addClass("layer-merge-button").html(MERGE_SVG).on("click", () => run_layer_action("Merge Down", () => merge_layer_down())));
	const $new = $(E("button")).attr({
		type: "button",
		title: "New layer",
		"aria-label": "New layer",
	}).addClass("layer-new-button").html(NEW_LAYER_SVG).on("click", () => run_layer_action("New Layer", () => add_layer()));
	const $duplicate = $(E("button")).attr({
		type: "button",
		title: "Duplicate layer",
		"aria-label": "Duplicate layer",
	}).addClass("layer-duplicate-button").html(DUPLICATE_SVG).on("click", () => run_layer_action("Duplicate Layer", () => duplicate_layer()));
	const $delete = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).attr({
		type: "button",
		title: "Delete layer",
		"aria-label": "Delete layer",
	}).addClass("layer-delete-button").html(DELETE_SVG).on("click", () => run_layer_action("Delete Layer", () => delete_layer())));
	$buttons.append($lock, $merge, $new, $duplicate, $delete);
	$content.append($opacity_bar, $list, $buttons);

	$opacity.on("input", () => {
		$value.val(`${$opacity.val()}%`);
	});
	$opacity.on("change", () => {
		commit_opacity(Number($opacity.val()) / 100);
	});
	$value.on("focus", () => {
		$value.trigger("select");
	});
	$value.on("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			$value.trigger("blur");
		} else if (event.key === "Escape") {
			event.preventDefault();
			update_selection_ui();
			$value.trigger("blur");
		}
	});
	$value.on("change blur", () => {
		const parsed = parseInt(String($value.val()), 10);
		if (Number.isNaN(parsed)) {
			update_selection_ui();
			return;
		}
		commit_opacity(parsed / 100);
	});

	$layers_list = $list;
	$opacity_input = $opacity;
	$opacity_value = $value;
	$lock_button = $lock;
	$merge_button = $merge;
	$delete_button = $delete;

	const $c = $Component(localize("Layers"), "layers-component", "tall", $content);
	$c.appendTo(get_direction() === "rtl" ? $left : $right);

	$G.off(".layers-box");
	$G.on("layers-changed.layers-box", () => render_layers());
	$G.on("layers-selection-changed.layers-box", () => update_selection_ui());
	$G.on("layers-composited.layers-box", () => refresh_layer_thumbnails());
	render_layers();
	return $c;
}

function ensure_layers_box() {
	if (!$layersbox) {
		$layersbox = $LayersBox();
		window.$layersbox = $layersbox;
	}
	return $layersbox;
}

function show_layers_box() {
	ensure_layers_box().show();
	return $layersbox;
}

function show_layers_window() {
	return show_layers_box();
}

function toggle_layers_box() {
	ensure_layers_box().toggle();
	return $layersbox;
}

export {
	$LayersBox,
	ensure_layers_box,
	refresh_layer_thumbnails,
	show_layers_box,
	show_layers_window,
	toggle_layers_box
};
