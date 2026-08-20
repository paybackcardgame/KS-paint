// @ts-check
/* global airbrush_size:writable, brush_size:writable, eraser_size:writable, fill_replace_all:writable, pencil_size:writable, return_to_tools:writable, stroke_size:writable */
/* global $canvas, $canvas_area, $status_text, pointer, pointer_active, selected_colors, selected_tool, selected_tools, selection */

import { duplicate_selection, get_tool_by_id, select_tool, select_tools, set_magnification, undoable_option_change, update_helper_layer } from "./functions.js";
import { $G, get_help_folder_icon, make_css_cursor, to_canvas_coords } from "./helpers.js";
import { get_fill_threshold, get_wand_threshold, set_fill_threshold, set_wand_threshold } from "./image-manipulation.js";
import { composite_layers, sample_composite_color } from "./layers.js";
import { repeat_last_action } from "./repeat-action.js";
import { show_shortcut_settings_window } from "./shortcut-settings.js";
import { localStore } from "./storage.js";
import {
	TOOL_AIRBRUSH, TOOL_BRUSH, TOOL_CURVE, TOOL_ELLIPSE, TOOL_ERASER,
	TOOL_FILL, TOOL_FREE_FORM_SELECT, TOOL_LINE, TOOL_MAGIC_WAND,
	TOOL_PENCIL, TOOL_PICK_COLOR, TOOL_POLYGON, TOOL_RECTANGLE,
	TOOL_ROUNDED_RECTANGLE, TOOL_SELECT, TOOL_TEXT,
} from "./tools.js";

const KEYMAP_STORAGE_KEY = "jspaint speedrun keymap";
const COLOR_HISTORY_MAX = 12;
const TOOL_HOLD_MS = 250;
/** Stroke menu is 1–5px; 4 is double the menu max. */
const SIZE_PRESETS = { "1": 1, "2": 3, "3": 5, "4": 10 };
const OLD_ZOOM_DIGIT_DEFAULTS = {
	Digit1: "zoom:1",
	Digit2: "zoom:2",
	Digit3: "zoom:4",
	Digit4: "zoom:8",
};

/** @type {Record<string, string>} */
const DEFAULT_KEYMAP = {
	KeyB: "tool:TOOL_BRUSH",
	KeyP: "tool:TOOL_PENCIL",
	KeyE: "tool:TOOL_ERASER",
	KeyA: "tool:TOOL_MAGIC_WAND",
	KeyI: "tool:TOOL_PICK_COLOR",
	KeyG: "fill-contiguous",
	KeyF: "fill-contiguous",
	KeyL: "tool:TOOL_FREE_FORM_SELECT",
	KeyN: "tool:TOOL_LINE",
	KeyC: "tool:TOOL_ELLIPSE",
	KeyT: "tool:TOOL_TEXT",
	KeyM: "tool:TOOL_SELECT",
	KeyS: "tool:TOOL_SELECT",
	KeyV: "tool:TOOL_FREE_FORM_SELECT",
	KeyU: "cycle:shapes",
	KeyX: "swap-colors",
	KeyD: "reset-colors",
	Backquote: "toggle-recent-tool",
	BracketLeft: "size-down",
	BracketRight: "size-up",
	Digit1: "size:1",
	Digit2: "size:3",
	Digit3: "size:5",
	Digit4: "size:10",
	Space: "pan",
	F3: "repeat-last",
};

/** @type {Record<string, string>} */
let keymap = { ...DEFAULT_KEYMAP };

/** @type {(string | CanvasPattern)[]} */
let color_history = [];

/** @type {{ code: string, previousTools: Tool[], downAt: number } | null} */
let held_tool = null;

/** @type {Tool[] | null} */
let alt_eyedropper_return_to = null;

let space_down = false;
let space_panning = false;
/** @type {{ x: number, y: number } | null} */
let space_pan_last = null;
/** Hold Y to rotate selection from edges (Photoshop-style). */
let y_rotate_held = false;

/** @type {(() => void) | null} */
let pointer_color_panel_handler = null;

/**
 * @param {() => void} fn
 */
function set_pointer_color_panel_handler(fn) {
	pointer_color_panel_handler = fn;
}

function toggle_pointer_color_panel() {
	pointer_color_panel_handler?.();
}

/**
 * @returns {Record<string, string>}
 */
function get_keymap() {
	return keymap;
}

/**
 * @param {Record<string, string>} next
 */
function save_keymap(next) {
	keymap = { ...DEFAULT_KEYMAP, ...next };
	localStore.set(KEYMAP_STORAGE_KEY, JSON.stringify(keymap), (_error) => { /* ignore */ });
}

function load_keymap() {
	localStore.get(KEYMAP_STORAGE_KEY, (_error, value) => {
		if (!value) {
			return;
		}
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object") {
				let migrated = false;
				// C used to be Curve, then color panel; O used to be Ellipse. Circle is now C.
				if (
					parsed.KeyC === "tool:TOOL_CURVE" ||
					parsed.KeyC === "color-panel"
				) {
					parsed.KeyC = "tool:TOOL_ELLIPSE";
					migrated = true;
				}
				if (parsed.KeyO === "tool:TOOL_ELLIPSE" && parsed.KeyC === "tool:TOOL_ELLIPSE") {
					delete parsed.KeyO;
					migrated = true;
				}
				for (const [code, action] of Object.entries(parsed)) {
					if (action === "tool:TOOL_CURVE") {
						delete parsed[code];
						migrated = true;
					}
				}
				// + / - are reserved for cursor-centered zoom.
				for (const code of ["Equal", "Minus", "NumpadAdd", "NumpadSubtract"]) {
					if (parsed[code]) {
						delete parsed[code];
						migrated = true;
					}
				}
				// 1–4 used to be zoom presets; migrate leftover defaults to tool sizes.
				for (const [code, old_action] of Object.entries(OLD_ZOOM_DIGIT_DEFAULTS)) {
					if (parsed[code] === old_action) {
						delete parsed[code];
						migrated = true;
					}
				}
				keymap = { ...DEFAULT_KEYMAP, ...parsed };
				if (migrated) {
					save_keymap(keymap);
				}
			}
		} catch (_error) { /* ignore */ }
	});
}

/**
 * @param {string | CanvasPattern} color
 */
function push_color_history(color) {
	if (color === "" || color == null) {
		return;
	}
	if (typeof color !== "string" && !(color instanceof CanvasPattern)) {
		return;
	}
	const existing = color_history.findIndex((c) => c === color);
	if (existing === 0) {
		return;
	}
	if (existing > 0) {
		color_history.splice(existing, 1);
	}
	color_history.unshift(color);
	if (color_history.length > COLOR_HISTORY_MAX) {
		color_history.length = COLOR_HISTORY_MAX;
	}
	$G.trigger("color-history-change");
}

/**
 * @returns {(string | CanvasPattern)[]}
 */
function get_color_history() {
	return color_history;
}

/**
 * @param {(string | CanvasPattern)[]} colors
 */
function set_color_history(colors) {
	color_history = [];
	if (!Array.isArray(colors)) {
		$G.trigger("color-history-change");
		return;
	}
	for (const color of colors) {
		if (typeof color === "string" || color instanceof CanvasPattern) {
			color_history.push(color);
		}
		if (color_history.length >= COLOR_HISTORY_MAX) {
			break;
		}
	}
	$G.trigger("color-history-change");
}

/**
 * @param {number} delta
 */
function adjust_current_tool_size(delta) {
	let handled = true;
	// Tolerance changes aren't tracked by the undo history, so this may not create an undo point.
	undoable_option_change({ name: "Tool Size", icon: get_help_folder_icon("p_brush.gif"), merge_consecutive: true }, () => {
		const id = selected_tool.id;
		if (id === TOOL_BRUSH) {
			brush_size = Math.max(1, Math.min(brush_size + delta, 500));
		} else if (id === TOOL_ERASER) {
			eraser_size = Math.max(1, Math.min(eraser_size + delta, 500));
		} else if (id === TOOL_AIRBRUSH) {
			airbrush_size = Math.max(1, Math.min(airbrush_size + delta, 500));
		} else if (id === TOOL_MAGIC_WAND) {
			set_wand_threshold(Math.max(0, Math.min(get_wand_threshold() + delta, 255)));
		} else if (id === TOOL_PENCIL) {
			pencil_size = Math.max(1, Math.min(pencil_size + delta, 50));
		} else if (
			id === TOOL_LINE || id === TOOL_CURVE || id === TOOL_RECTANGLE ||
			id === TOOL_ROUNDED_RECTANGLE || id === TOOL_ELLIPSE || id === TOOL_POLYGON
		) {
			stroke_size = Math.max(1, Math.min(stroke_size + delta, 500));
		} else if (id === TOOL_FILL) {
			set_fill_threshold(Math.max(0, Math.min(get_fill_threshold() + delta, 255)));
		} else {
			handled = false;
			return;
		}
		$G.trigger("option-changed");
		// Match +/- key behavior: refresh toolbox options + on-canvas brush/stroke preview
		if (selected_tool.$options) {
			selected_tool.$options.trigger("update");
		}
		update_helper_layer();
	});
	return handled;
}

/**
 * Set brush, stroke/line, and the current tool's size to an absolute pixel value.
 * @param {number} size
 */
function set_drawing_size(size) {
	undoable_option_change({ name: "Tool Size", icon: get_help_folder_icon("p_brush.gif"), merge_consecutive: true }, () => {
		const n = Math.max(1, Math.min(size, 500));
		brush_size = n;
		stroke_size = n;
		eraser_size = n;
		airbrush_size = n;
		pencil_size = Math.max(1, Math.min(n, 50));
		$G.trigger("option-changed");
		if (selected_tool.$options) {
			selected_tool.$options.trigger("update");
		}
		update_helper_layer();
	});
	return true;
}

function swap_colors() {
	undoable_option_change({ name: "Swap Colors", icon: get_help_folder_icon("p_color.png") }, () => {
		const fg = selected_colors.foreground;
		selected_colors.foreground = selected_colors.background;
		selected_colors.background = fg;
		$G.triggerHandler("option-changed");
	});
}

function reset_colors_bw() {
	undoable_option_change({ name: "Reset Colors", icon: get_help_folder_icon("p_color.png") }, () => {
		selected_colors.foreground = "#000000";
		selected_colors.background = "#ffffff";
		$G.triggerHandler("option-changed");
	});
}

/** Shift+Q: Line tool, pure black, 5px thick. */
function apply_black_line_preset() {
	select_tool(get_tool_by_id(TOOL_LINE));
	undoable_option_change({ name: "Black 5px Line", icon: get_help_folder_icon("p_line.gif") }, () => {
		selected_colors.foreground = "#000000";
		stroke_size = 5;
		$G.trigger("option-changed");
		if (selected_tool.$options) {
			selected_tool.$options.trigger("update");
		}
		update_helper_layer();
	});
	if ($status_text) {
		$status_text.text("Line: black, 5px");
	}
}

/**
 * @param {ToolID[]} tool_ids
 */
function cycle_tools(tool_ids) {
	const current_index = tool_ids.indexOf(selected_tool.id);
	const next_id = tool_ids[(current_index + 1) % tool_ids.length];
	select_tool(get_tool_by_id(next_id));
}

function toggle_recent_tool() {
	if (return_to_tools && return_to_tools.length) {
		const previous = [...selected_tools];
		select_tools(return_to_tools);
		// select_tool updates return_to_tools; keep the pair flip-flopping
		return_to_tools = previous;
	}
}

/**
 * @param {string} action
 * @param {KeyboardEvent | JQuery.KeyDownEvent} e
 * @param {{ is_holdable_tool?: boolean }} [opts]
 * @returns {boolean}
 */
function run_keymap_action(action, e, opts = {}) {
	if (action.startsWith("tool:")) {
		const tool_id = /** @type {ToolID} */ (action.slice(5));
		const tool = get_tool_by_id(tool_id);
		if (!tool) {
			return false;
		}
		if (opts.is_holdable_tool) {
			const previousTools = selected_tools[0]?.deselect ? [...return_to_tools] : [...selected_tools];
			if (selected_tool !== tool) {
				select_tool(tool);
			}
			held_tool = {
				code: /** @type {KeyboardEvent} */ (e).code || "",
				previousTools,
				downAt: performance.now(),
			};
		} else {
			select_tool(tool);
		}
		return true;
	}
	if (action === "cycle:select") {
		cycle_tools([TOOL_SELECT, TOOL_FREE_FORM_SELECT]);
		return true;
	}
	if (action === "cycle:shapes") {
		cycle_tools([TOOL_RECTANGLE, TOOL_ELLIPSE, TOOL_ROUNDED_RECTANGLE]);
		return true;
	}
	if (action === "fill-contiguous") {
		fill_replace_all = false;
		select_tool(get_tool_by_id(TOOL_FILL));
		$G.trigger("option-changed");
		if ($status_text) {
			$status_text.text("Fill: contiguous (Shift+F for replace-all)");
		}
		return true;
	}
	if (action === "fill-replace") {
		fill_replace_all = true;
		select_tool(get_tool_by_id(TOOL_FILL));
		$G.trigger("option-changed");
		if ($status_text) {
			$status_text.text("Fill: replace all matching colors (F for contiguous)");
		}
		return true;
	}
	if (action === "swap-colors") {
		swap_colors();
		return true;
	}
	if (action === "reset-colors") {
		reset_colors_bw();
		return true;
	}
	if (action === "color-panel") {
		const native = /** @type {KeyboardEvent} */ (/** @type {unknown} */ (e.originalEvent ?? e));
		if (!native.repeat) {
			toggle_pointer_color_panel();
		}
		return true;
	}
	if (action === "toggle-recent-tool") {
		toggle_recent_tool();
		return true;
	}
	if (action === "size-down") {
		return adjust_current_tool_size(-1);
	}
	if (action === "size-up") {
		return adjust_current_tool_size(1);
	}
	if (action.startsWith("size:")) {
		const size = Number(action.slice(5));
		if (size > 0) {
			return set_drawing_size(size);
		}
	}
	if (action.startsWith("zoom:")) {
		const scale = Number(action.slice(5));
		if (scale > 0) {
			const zoom_anchor = pointer ? { x: pointer.x, y: pointer.y } : undefined;
			set_magnification(scale, zoom_anchor);
			return true;
		}
	}
	if (action === "repeat-last") {
		return repeat_last_action();
	}
	if (action === "pan") {
		// handled via space_down flag in keydown
		return true;
	}
	return false;
}

/**
 * Sample canvas color into the foreground (or background with right-click semantics via reverse).
 * @param {number} x
 * @param {number} y
 * @param {ColorSelectionSlot} [slot]
 */
function pick_color_at(x, y, slot = "foreground") {
	composite_layers();
	const color = sample_composite_color(x, y);
	undoable_option_change({ name: "Pick Color", icon: get_help_folder_icon("p_eye.gif") }, () => {
		selected_colors[slot] = color;
		push_color_history(color);
		$G.trigger("option-changed");
	});
}

function update_space_cursor() {
	if (space_down || space_panning) {
		$canvas.css("cursor", make_css_cursor("move", [8, 8], "grab"));
	} else if (selected_tool?.cursor) {
		$canvas.css("cursor", make_css_cursor(...selected_tool.cursor));
	}
}

/**
 * @returns {boolean} true if the canvas pointerdown was consumed (space pan or ctrl pick)
 */
function handle_canvas_pointerdown_extras(e) {
	if (space_down) {
		space_panning = true;
		space_pan_last = { x: e.clientX, y: e.clientY };
		update_space_cursor();
		const on_move = (move_event) => {
			if (!space_pan_last) {
				return;
			}
			const dx = move_event.clientX - space_pan_last.x;
			const dy = move_event.clientY - space_pan_last.y;
			$canvas_area.scrollLeft($canvas_area.scrollLeft() - dx);
			$canvas_area.scrollTop($canvas_area.scrollTop() - dy);
			space_pan_last = { x: move_event.clientX, y: move_event.clientY };
		};
		const on_up = () => {
			$G.off("pointermove", on_move);
			space_panning = false;
			space_pan_last = null;
			update_space_cursor();
		};
		$G.on("pointermove", on_move);
		$G.one("pointerup", on_up);
		e.preventDefault();
		return true;
	}

	// Ctrl+click picks a color without switching tools (ternary painting: press Ctrl after mouse down).
	if (e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
		const p = to_canvas_coords(e);
		pick_color_at(p.x, p.y, "foreground");
		e.preventDefault();
		return true;
	}
	if (e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 2) {
		const p = to_canvas_coords(e);
		pick_color_at(p.x, p.y, "background");
		e.preventDefault();
		return true;
	}

	return false;
}

function show_keyboard_shortcuts_window() {
	show_shortcut_settings_window();
}

function is_pointer_over_selection() {
	if (!selection) {
		return false;
	}
	if (selection.$el?.[0]?.matches(":hover")) {
		return true;
	}
	if (!pointer) {
		return false;
	}
	return pointer.x >= selection.x &&
		pointer.x < selection.x + selection.width &&
		pointer.y >= selection.y &&
		pointer.y < selection.y + selection.height;
}

/**
 * @param {JQuery.KeyDownEvent} e
 * @returns {boolean} whether handled
 */
function handle_speedrun_keydown(e) {
	const event = /** @type {KeyboardEvent} */ (/** @type {unknown} */ (e.originalEvent ?? e));
	const target = /** @type {HTMLElement} */ (/** @type {unknown} */ (e.target));
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target && /** @type {HTMLElement} */ (target).isContentEditable)
	) {
		return false;
	}

	// Alt / Option = temporary eyedropper (not while drawing — Alt then = center-out shapes).
	// Over a selection, Alt-drag duplicates like Photoshop instead of picking color.
	if (event.key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
		if (selection && (selection.dragging || is_pointer_over_selection())) {
			if (selection.dragging && !event.repeat) {
				duplicate_selection();
			}
			e.preventDefault();
			return true;
		}
		if (!pointer_active && !alt_eyedropper_return_to && selected_tool.id !== TOOL_PICK_COLOR) {
			alt_eyedropper_return_to = [...selected_tools];
			select_tool(get_tool_by_id(TOOL_PICK_COLOR));
		}
		e.preventDefault();
		return true;
	}

	// Hold Y = rotate selection from edges (instead of stretch)
	if (event.code === "KeyY" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
		if (!y_rotate_held) {
			y_rotate_held = true;
			if (selection) {
				selection.set_rotate_modifier(true);
				if ($status_text) {
					$status_text.text("Hold Y — drag selection edge/corner to rotate");
				}
			} else if ($status_text) {
				$status_text.text("Hold Y — make a selection first to rotate");
			}
		}
		e.preventDefault();
		return true;
	}

	// Space = pan mode
	if (event.code === "Space" || event.key === " ") {
		if (!space_down) {
			space_down = true;
			update_space_cursor();
			if ($status_text) {
				$status_text.text("Pan (Space+drag)");
			}
		}
		e.preventDefault();
		return true;
	}

	// Shift+F = fill replace-all mode
	if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.code === "KeyF") {
		run_keymap_action("fill-replace", event);
		e.preventDefault();
		return true;
	}

	// Shift+Q = Line tool, pure black, 5px thick
	if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.code === "KeyQ") {
		if (!event.repeat) {
			apply_black_line_preset();
		}
		e.preventDefault();
		return true;
	}

	// Shift+W = Magic Wand
	if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.code === "KeyW") {
		if (!event.repeat) {
			run_keymap_action("tool:TOOL_MAGIC_WAND", event);
		}
		e.preventDefault();
		return true;
	}

	// Ctrl+Shift+R = repeat last
	if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toUpperCase() === "R") {
		if (repeat_last_action()) {
			e.preventDefault();
			return true;
		}
	}

	if (event.ctrlKey || event.metaKey || event.altKey) {
		return false;
	}

	// F3 repeat (no modifiers)
	if (event.key === "F3") {
		if (repeat_last_action()) {
			e.preventDefault();
			return true;
		}
	}

	if (event.repeat && held_tool && held_tool.code === event.code) {
		e.preventDefault();
		return true;
	}

	const action = keymap[event.code];
	if (!action || action === "pan") {
		return false;
	}

	if (event.shiftKey && !action.startsWith("zoom:") && !action.startsWith("size:")) {
		return false;
	}

	const is_holdable_tool = action.startsWith("tool:");
	const handled = run_keymap_action(action, event, { is_holdable_tool: is_holdable_tool && !event.repeat });
	if (handled) {
		e.preventDefault();
	}
	return handled;
}

/**
 * @param {JQuery.KeyUpEvent} e
 */
function handle_speedrun_keyup(e) {
	const event = /** @type {KeyboardEvent} */ (/** @type {unknown} */ (e.originalEvent ?? e));

	if (event.key === "Alt") {
		if (alt_eyedropper_return_to) {
			select_tools(alt_eyedropper_return_to);
			alt_eyedropper_return_to = null;
		}
		return;
	}

	if (event.code === "KeyY") {
		y_rotate_held = false;
		if (selection) {
			selection.set_rotate_modifier(false);
		}
		$status_text?.default?.();
		e.preventDefault();
		return;
	}

	if (event.code === "Space" || event.key === " ") {
		space_down = false;
		if (!space_panning) {
			update_space_cursor();
			$status_text?.default?.();
		}
		e.preventDefault();
		return;
	}

	if (held_tool && held_tool.code === event.code) {
		const held_for = performance.now() - held_tool.downAt;
		if (held_for >= TOOL_HOLD_MS) {
			select_tools(held_tool.previousTools);
		}
		held_tool = null;
	}
}

/**
 * Nudge selection; returns true if handled.
 * @param {JQuery.KeyDownEvent} e
 * @returns {boolean}
 */
function handle_selection_nudge(e) {
	if (!selection) {
		return false;
	}
	const event = /** @type {KeyboardEvent} */ (/** @type {unknown} */ (e.originalEvent ?? e));
	if (event.ctrlKey || event.metaKey || event.altKey) {
		return false;
	}
	const step = event.shiftKey ? 10 : 1;
	let dx = 0;
	let dy = 0;
	switch (event.key) {
		case "ArrowLeft": dx = -step; break;
		case "ArrowRight": dx = step; break;
		case "ArrowUp": dy = -step; break;
		case "ArrowDown": dy = step; break;
		default: return false;
	}
	selection.x += dx;
	selection.y += dy;
	selection.position();
	e.preventDefault();
	return true;
}

function init_speedrun_features() {
	load_keymap();

	$G.on("option-changed", () => {
		if (typeof selected_colors.foreground === "string" || selected_colors.foreground instanceof CanvasPattern) {
			push_color_history(selected_colors.foreground);
		}
	});
}

export {
	DEFAULT_KEYMAP,
	SIZE_PRESETS,
	get_color_history,
	get_keymap,
	handle_canvas_pointerdown_extras,
	handle_selection_nudge,
	handle_speedrun_keydown,
	handle_speedrun_keyup,
	init_speedrun_features,
	pick_color_at,
	push_color_history,
	save_keymap,
	set_color_history,
	set_pointer_color_panel_handler,
	show_keyboard_shortcuts_window,
	space_down,
};
