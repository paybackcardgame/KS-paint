// @ts-check
/* global airbrush_size:writable, aliasing:writable, brush_shape:writable, brush_size:writable, current_history_node:writable, current_palette_id:writable, eraser_size:writable, fill_all_layers:writable, fill_replace_all:writable, history_node_to_cancel_to:writable, last_non_winter_palette_id:writable, magnification, my_canvas_height:writable, my_canvas_width:writable, palette:writable, pencil_size:writable, polychrome_palette:writable, redos:writable, root_history_node:writable, selected_colors:writable, selected_tool, selection_all_layers:writable, show_grid:writable, stroke_size:writable, text_tool_font:writable, tool_transparent_mode:writable, transparency:writable, undos:writable, wand_all_layers:writable, wand_replace_all:writable */
/* global $canvas_area, $colorbox, default_magnification, localize, main_canvas, main_ctx, new_local_session, systemHooks */

import { template_formats } from "./file-format-data.js";
import { are_you_sure, cancel, deselect, get_tool_by_id, make_history_node, reset_canvas_and_history, reset_file, reset_selected_colors, select_tool, set_magnification, show_error_message, update_disable_aa, update_helper_layer, update_title } from "./functions.js";
import { $G, get_help_folder_icon } from "./helpers.js";
import { get_fill_threshold, get_wand_threshold, set_fill_threshold, set_wand_threshold } from "./image-manipulation.js";
import { deserialize_layers_document, get_active_layer, initialize_layer_stack_from_layers, select_layer, serialize_layers_document, snapshot_layers } from "./layers.js";
import { showMessageBox } from "./msgbox.js";
import { get_menu_overrides, set_menu_overrides } from "./shortcut-settings.js";
import { get_color_history, get_keymap, save_keymap, set_color_history } from "./speedrun-features.js";
import { localStore } from "./storage.js";
import { get_theme, set_theme } from "./theme.js";
import { tools } from "./tools.js";

const TEMPLATE_KIND = "jspaint-template";
const TEMPLATE_VERSION = 1;
const TEMPLATE_DB_NAME = "jspaint-templates";
const TEMPLATE_DB_VERSION = 1;
const TEMPLATE_STORE = "templates";
const DEFAULT_TEMPLATE_KEY = "default";

/** Bumped when a file/session load should win over a still-running File > New / first-open template apply. */
let default_template_apply_generation = 0;

function cancel_pending_default_template() {
	default_template_apply_generation += 1;
}

/**
 * @param {string | CanvasPattern | undefined} color
 * @returns {string}
 */
function serializable_color(color) {
	return typeof color === "string" ? color : "";
}

/**
 * @param {(string | CanvasPattern)[] | undefined} colors
 * @returns {string[]}
 */
function serializable_colors(colors) {
	/** @type {string[]} */
	const result = [];
	for (const color of colors || []) {
		if (typeof color === "string") {
			result.push(color);
		}
	}
	return result;
}

function collect_shape_styles() {
	/** @type {Record<string, {fill: boolean, stroke: boolean}>} */
	const styles = {};
	for (const tool of tools) {
		if (tool.$options && typeof tool.$options.fill === "boolean") {
			styles[tool.id] = {
				fill: !!tool.$options.fill,
				stroke: !!tool.$options.stroke,
			};
		}
	}
	return styles;
}

/**
 * @returns {object}
 */
function collect_workspace_template() {
	return {
		kind: TEMPLATE_KIND,
		version: TEMPLATE_VERSION,
		saved_at: new Date().toISOString(),
		document: serialize_layers_document(),
		colors: {
			palette: serializable_colors(palette),
			palette_rows: palette.rows || null,
			palette_id: current_palette_id,
			foreground: serializable_color(selected_colors.foreground),
			background: serializable_color(selected_colors.background),
			ternary: serializable_color(selected_colors.ternary),
			history: serializable_colors(get_color_history()),
		},
		tools: {
			selected: selected_tool_id(),
			brush_size,
			brush_shape,
			eraser_size,
			airbrush_size,
			pencil_size,
			stroke_size,
			tool_transparent_mode: !!tool_transparent_mode,
			fill_replace_all: !!fill_replace_all,
			fill_all_layers: !!fill_all_layers,
			wand_replace_all: !!wand_replace_all,
			wand_all_layers: !!wand_all_layers,
			selection_all_layers: !!selection_all_layers,
			fill_threshold: get_fill_threshold(),
			wand_threshold: get_wand_threshold(),
			shape_styles: collect_shape_styles(),
		},
		shortcuts: {
			menu: get_menu_overrides(),
			tools: { ...get_keymap() },
		},
		view: {
			theme: get_theme(),
			magnification,
			show_grid: !!show_grid,
			aliasing: !!aliasing,
			transparency: !!transparency,
		},
		text: {
			family: text_tool_font.family,
			size: text_tool_font.size,
			line_scale: text_tool_font.line_scale,
			bold: !!text_tool_font.bold,
			italic: !!text_tool_font.italic,
			underline: !!text_tool_font.underline,
			vertical: !!text_tool_font.vertical,
			color: serializable_color(text_tool_font.color),
			background: serializable_color(text_tool_font.background),
		},
	};
}

function selected_tool_id() {
	return selected_tool?.id || "TOOL_PENCIL";
}

/**
 * @param {any} template
 */
function assert_template(template) {
	if (!template || template.kind !== TEMPLATE_KIND || !template.document?.layers?.length) {
		throw new Error("This file is not a JS Paint template.");
	}
}

/**
 * @param {any} template
 * @param {{history_name?: string, history_icon?: string, loaded_layers?: Awaited<ReturnType<typeof deserialize_layers_document>>}} [options]
 */
async function apply_workspace_template(template, options = {}) {
	assert_template(template);
	deselect();
	cancel();

	const loaded_layers = options.loaded_layers || await deserialize_layers_document(template.document);
	initialize_layer_stack_from_layers(loaded_layers);
	if (template.document.active_layer_id) {
		select_layer(template.document.active_layer_id);
	}

	my_canvas_width = main_canvas.width;
	my_canvas_height = main_canvas.height;

	apply_template_colors(template.colors);
	apply_template_tools(template.tools);
	apply_template_shortcuts(template.shortcuts);
	apply_template_view(template.view);
	apply_template_text(template.text);

	undos.length = 0;
	redos.length = 0;
	history_node_to_cancel_to = null;
	current_history_node = root_history_node = make_history_node({
		name: options.history_name || localize("New"),
		icon: get_help_folder_icon(options.history_icon || "p_blank.png"),
		image_data: main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height),
		layers: snapshot_layers(),
		active_layer_id: get_active_layer().id,
	});
	$canvas_area.trigger("resize");
	$G.triggerHandler("history-update");
	$G.trigger("option-changed");
	$G.trigger("tool-changed");
	update_helper_layer();
	update_disable_aa();
	update_title();
}

/**
 * @param {any} colors
 */
function apply_template_colors(colors) {
	if (!colors) {
		return;
	}
	if (Array.isArray(colors.palette) && colors.palette.length) {
		palette = colors.palette.slice();
		if (colors.palette_rows) {
			palette.rows = colors.palette_rows;
		}
		polychrome_palette = palette;
		current_palette_id = colors.palette_id || "custom";
		if (current_palette_id !== "winter") {
			last_non_winter_palette_id = current_palette_id;
		}
		if ($colorbox) {
			$colorbox.rebuild_palette();
		}
	}
	selected_colors = {
		foreground: colors.foreground || "#000000",
		background: colors.background || "#ffffff",
		ternary: colors.ternary || "",
	};
	set_color_history(colors.history || []);
}

/**
 * @param {any} tool_state
 */
function apply_template_tools(tool_state) {
	if (!tool_state) {
		return;
	}
	if (typeof tool_state.brush_size === "number") {
		brush_size = tool_state.brush_size;
	}
	if (typeof tool_state.brush_shape === "string") {
		brush_shape = tool_state.brush_shape;
	}
	if (typeof tool_state.eraser_size === "number") {
		eraser_size = tool_state.eraser_size;
	}
	if (typeof tool_state.airbrush_size === "number") {
		airbrush_size = tool_state.airbrush_size;
	}
	if (typeof tool_state.pencil_size === "number") {
		pencil_size = tool_state.pencil_size;
	}
	if (typeof tool_state.stroke_size === "number") {
		stroke_size = tool_state.stroke_size;
	}
	tool_transparent_mode = !!tool_state.tool_transparent_mode;
	fill_replace_all = !!tool_state.fill_replace_all;
	fill_all_layers = !!tool_state.fill_all_layers;
	wand_replace_all = !!tool_state.wand_replace_all;
	wand_all_layers = !!tool_state.wand_all_layers;
	selection_all_layers = !!tool_state.selection_all_layers;
	if (typeof tool_state.fill_threshold === "number") {
		set_fill_threshold(tool_state.fill_threshold);
	}
	if (typeof tool_state.wand_threshold === "number") {
		set_wand_threshold(tool_state.wand_threshold);
	}
	if (tool_state.shape_styles) {
		for (const tool of tools) {
			const style = tool_state.shape_styles[tool.id];
			if (style && tool.$options && typeof tool.$options.fill === "boolean") {
				tool.$options.fill = !!style.fill;
				tool.$options.stroke = !!style.stroke;
			}
		}
	}
	const tool = get_tool_by_id(tool_state.selected) || get_tool_by_id("TOOL_PENCIL");
	if (tool) {
		select_tool(tool);
	}
}

/**
 * @param {any} shortcuts
 */
function apply_template_shortcuts(shortcuts) {
	if (!shortcuts) {
		return;
	}
	set_menu_overrides(shortcuts.menu || {});
	if (shortcuts.tools && typeof shortcuts.tools === "object") {
		save_keymap(shortcuts.tools);
	}
}

/**
 * @param {any} view
 */
function apply_template_view(view) {
	if (!view) {
		return;
	}
	if (view.theme && view.theme !== get_theme()) {
		set_theme(view.theme);
	}
	if (typeof view.magnification === "number" && view.magnification > 0) {
		set_magnification(view.magnification);
	}
	show_grid = !!view.show_grid;
	aliasing = view.aliasing !== false;
	transparency = !!view.transparency;
}

/**
 * @param {any} text
 */
function apply_template_text(text) {
	if (!text) {
		return;
	}
	text_tool_font = {
		...text_tool_font,
		family: text.family || text_tool_font.family,
		size: typeof text.size === "number" ? text.size : text_tool_font.size,
		line_scale: typeof text.line_scale === "number" ? text.line_scale : text_tool_font.line_scale,
		bold: !!text.bold,
		italic: !!text.italic,
		underline: !!text.underline,
		vertical: !!text.vertical,
		color: text.color || text_tool_font.color,
		background: text.background || text_tool_font.background,
	};
}

/**
 * @returns {Promise<IDBDatabase | null>}
 */
function open_template_db() {
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(TEMPLATE_DB_NAME, TEMPLATE_DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(TEMPLATE_STORE)) {
					db.createObjectStore(TEMPLATE_STORE);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
		} catch (_error) {
			resolve(null);
		}
	});
}

/**
 * @param {object} template
 */
async function save_default_template(template) {
	const db = await open_template_db();
	if (!db) {
		throw new Error("Templates could not be stored in this browser.");
	}
	try {
		await new Promise((resolve, reject) => {
			const tx = db.transaction(TEMPLATE_STORE, "readwrite");
			tx.oncomplete = () => resolve(undefined);
			tx.onerror = () => reject(tx.error);
			tx.objectStore(TEMPLATE_STORE).put(template, DEFAULT_TEMPLATE_KEY);
		});
	} finally {
		db.close();
	}
}

/**
 * @returns {Promise<object | null>}
 */
async function load_default_template() {
	const db = await open_template_db();
	if (!db) {
		return null;
	}
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(TEMPLATE_STORE, "readonly");
			const request = tx.objectStore(TEMPLATE_STORE).get(DEFAULT_TEMPLATE_KEY);
			request.onsuccess = () => resolve(request.result || null);
			request.onerror = () => reject(request.error);
		});
	} catch (_error) {
		return null;
	} finally {
		db.close();
	}
}

/**
 * Used by File > New and first-open. Returns true if a default template was applied.
 * Aborts if a file or session image is opened while this is still loading.
 * @returns {Promise<boolean>}
 */
async function apply_default_template_or_blank() {
	const generation = ++default_template_apply_generation;
	try {
		const template = await load_default_template();
		if (generation !== default_template_apply_generation) {
			return false;
		}
		if (template) {
			assert_template(template);
			const loaded_layers = await deserialize_layers_document(template.document);
			if (generation !== default_template_apply_generation) {
				return false;
			}
			await apply_workspace_template(template, {
				history_name: localize("New"),
				history_icon: "p_blank.png",
				loaded_layers,
			});
			return true;
		}
	} catch (error) {
		if (generation !== default_template_apply_generation) {
			return false;
		}
		show_error_message("The default template could not be loaded. A blank document will be used instead.", error);
	}
	if (generation !== default_template_apply_generation) {
		return false;
	}
	reset_selected_colors();
	reset_canvas_and_history();
	set_magnification(default_magnification);
	return false;
}

async function save_as_default_template() {
	try {
		const template = collect_workspace_template();
		await save_default_template(template);
		localStore.set({
			width: String(main_canvas.width),
			height: String(main_canvas.height),
		}, (_error) => { /* ignore */ });
		showMessageBox({
			title: localize("Save as Default Template"),
			message: "Saved. File > New will open this layout, including layers, colors, tools, and shortcuts.",
			iconID: "info",
		});
	} catch (error) {
		show_error_message("The default template could not be saved.", error);
	}
}

function save_template_to_file() {
	const template = collect_workspace_template();
	const blob = new Blob([JSON.stringify(template)], { type: "application/json" });
	systemHooks.showSaveFileDialog({
		dialogTitle: localize("Save Template"),
		formats: template_formats,
		defaultFileName: "template.jspaint-template",
		defaultFileFormatID: "JSPAINT_TEMPLATE",
		getBlob: () => Promise.resolve(blob),
		savedCallbackUnreliable: () => {},
	});
}

async function import_template_from_file() {
	let file;
	try {
		({ file } = await systemHooks.showOpenFileDialog({ formats: template_formats }));
	} catch (_error) {
		return;
	}
	if (!file) {
		return;
	}
	let template;
	try {
		template = JSON.parse(await file.text());
		assert_template(template);
	} catch (error) {
		show_error_message("Paint cannot open this template.", error);
		return;
	}
	are_you_sure(() => {
		cancel_pending_default_template();
		$G.triggerHandler("session-update");
		new_local_session();
		reset_file();
		apply_workspace_template(template, {
			history_name: "Import Template",
			history_icon: "p_open.png",
		}).then(() => {
			$G.triggerHandler("session-update");
		}).catch((error) => {
			show_error_message("The template could not be applied.", error);
		});
	});
}

export {
	apply_default_template_or_blank,
	cancel_pending_default_template,
	collect_workspace_template,
	import_template_from_file,
	save_as_default_template,
	save_template_to_file
};
