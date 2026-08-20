// @ts-check
/* global MENU_DIVIDER */

import { $DialogWindow } from "./$ToolWindow.js";
import { E, MOD_KEY_LABEL, display_shortcut_label } from "./helpers.js";
import { localStore } from "./storage.js";

/** @type {{ DEFAULT_KEYMAP: Record<string, string>, get_keymap: () => Record<string, string>, save_keymap: (next: Record<string, string>) => void } | null} */
let tool_keymap_api = null;

const MENU_STORAGE_KEY = "jspaint menu shortcuts";

/** Keys Chromium/Electron steal unless the main process intercepts them. */
const RESERVED_COMBOS = new Set([
	"Ctrl+N", "Ctrl+T", "Ctrl+W", "Ctrl+Shift+N", "Ctrl+Shift+T",
	"Ctrl+L", "Ctrl+R", "Ctrl+P", "Ctrl+F", "Ctrl+G", "Ctrl+Shift+W",
	"Ctrl+Shift+V",
	"Ctrl+PgUp", "Ctrl+PgDn", "Alt+F4", "F11",
]);

const TOOL_SHORTCUTS = [
	{ action: "tool:TOOL_BRUSH", group: "Tools", label: "Brush" },
	{ action: "tool:TOOL_PENCIL", group: "Tools", label: "Pencil" },
	{ action: "tool:TOOL_ERASER", group: "Tools", label: "Eraser" },
	{ action: "tool:TOOL_AIRBRUSH", group: "Tools", label: "Airbrush" },
	{ action: "tool:TOOL_MAGIC_WAND", group: "Tools", label: "Magic Wand" },
	{ action: "tool:TOOL_PICK_COLOR", group: "Tools", label: "Pick Color" },
	{ action: "tool:TOOL_LINE", group: "Tools", label: "Line" },
	{ action: "tool:TOOL_ELLIPSE", group: "Tools", label: "Ellipse" },
	{ action: "tool:TOOL_TEXT", group: "Tools", label: "Text" },
	{ action: "tool:TOOL_SELECT", group: "Tools", label: "Select" },
	{ action: "tool:TOOL_FREE_FORM_SELECT", group: "Tools", label: "Free-Form Select" },
	{ action: "tool:TOOL_MAGNIFIER", group: "Tools", label: "Magnifier" },
	{ action: "fill-contiguous", group: "Tools", label: "Fill (contiguous)" },
	{ action: "cycle:shapes", group: "Tools", label: "Cycle shapes" },
	{ action: "swap-colors", group: "Tools", label: "Swap colors" },
	{ action: "reset-colors", group: "Tools", label: "Reset colors (black/white)" },
	{ action: "color-panel", group: "Tools", label: "Color panel (at pointer)" },
	{ action: "toggle-recent-tool", group: "Tools", label: "Last tool" },
	{ action: "size-down", group: "Tools", label: "Decrease tool size" },
	{ action: "size-up", group: "Tools", label: "Increase tool size" },
	{ action: "size:1", group: "Tools", label: "Tool size 1px" },
	{ action: "size:3", group: "Tools", label: "Tool size 3px" },
	{ action: "size:5", group: "Tools", label: "Tool size 5px" },
	{ action: "size:10", group: "Tools", label: "Tool size 10px" },
	{ action: "pan", group: "Tools", label: "Pan (hold)" },
	{ action: "repeat-last", group: "Tools", label: "Repeat last action" },
];

/** @type {Record<string, string>} */
let menu_overrides = load_menu_overrides_sync();

/** @type {OSGUITopLevelMenus | null} */
let menus_ref = null;

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $settings_window = null;

/** @type {string | null} */
let recording_id = null;

let recording_is_tool = false;

/**
 * @returns {Record<string, string>}
 */
function load_menu_overrides_sync() {
	try {
		const raw = localStorage.getItem(MENU_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			// localStore.set JSON.stringifies; some callers double-encode.
			if (typeof parsed === "string") {
				const nested = JSON.parse(parsed);
				return nested && typeof nested === "object" ? nested : {};
			}
			return parsed;
		}
	} catch (_error) { /* ignore */ }
	return {};
}

/**
 * @param {string} id
 * @param {string} fallback
 */
function get_menu_shortcut(id, fallback) {
	const value = menu_overrides[id];
	if (typeof value === "string") {
		return value;
	}
	return fallback;
}

/**
 * @param {string} shortcutLabel
 */
function aria_from_shortcut_label(shortcutLabel) {
	if (!shortcutLabel) {
		return "";
	}
	// aria-keyshortcuts names the Command key "Meta".
	return shortcutLabel.replace(/\bCtrl\b/g, "Control").replace(/\bCmd\b/g, "Meta").replace(/\bDel\b/, "Delete");
}

/**
 * @param {string} id
 * @param {string} defaultLabel
 * @returns {{shortcut_id: string, defaultShortcut: string, shortcutLabel?: string, ariaKeyShortcuts?: string}}
 */
function shortcut(id, defaultLabel) {
	// Shortcuts are defined, stored, and recorded in terms of Ctrl; the label shown
	// to the user says Cmd on Mac, where that's the key you actually press.
	const shortcutLabel = display_shortcut_label(get_menu_shortcut(id, defaultLabel));
	if (!shortcutLabel) {
		return { shortcut_id: id, defaultShortcut: defaultLabel };
	}
	return {
		shortcut_id: id,
		defaultShortcut: defaultLabel,
		shortcutLabel,
		ariaKeyShortcuts: aria_from_shortcut_label(shortcutLabel),
	};
}

/**
 * @param {KeyboardEvent} event
 * @param {string} shortcutLabel
 */
function event_matches_shortcut(event, shortcutLabel) {
	if (!shortcutLabel) {
		return false;
	}
	const parts = shortcutLabel.split("+").map((part) => part.trim()).filter(Boolean);
	const key = parts.pop();
	if (!key) {
		return false;
	}
	const want_ctrl = parts.some((part) => /^Ctrl$/i.test(part));
	const want_alt = parts.some((part) => /^Alt$/i.test(part));
	const want_shift = parts.some((part) => /^Shift$/i.test(part));
	const want_meta = parts.some((part) => /^(Meta|Cmd|Command)$/i.test(part));
	const want_mod = want_ctrl || want_meta;
	const has_mod = event.ctrlKey || event.metaKey;
	if (want_mod !== has_mod) {
		return false;
	}
	if (want_alt !== event.altKey) {
		return false;
	}
	if (want_shift !== event.shiftKey) {
		return false;
	}
	return key_matches_event(event, key);
}

/**
 * @param {KeyboardEvent} event
 * @param {string} key
 */
function key_matches_event(event, key) {
	const expected = key.toUpperCase();
	if (expected === "DEL" || expected === "DELETE") {
		return event.key === "Delete";
	}
	if (expected === "PGUP" || expected === "PAGEUP") {
		return event.key === "PageUp";
	}
	if (expected === "PGDN" || expected === "PAGEDOWN") {
		return event.key === "PageDown";
	}
	if (expected === "ESC" || expected === "ESCAPE") {
		return event.key === "Escape";
	}
	if (expected === "SPACE") {
		return event.key === " " || event.code === "Space";
	}
	if (/^F\d+$/i.test(expected)) {
		return event.key.toUpperCase() === expected;
	}
	return event.key.toUpperCase() === expected;
}

/**
 * @param {KeyboardEvent} event
 */
function shortcut_label_from_event(event) {
	const parts = [];
	if (event.ctrlKey || event.metaKey) {
		parts.push("Ctrl");
	}
	if (event.altKey) {
		parts.push("Alt");
	}
	if (event.shiftKey) {
		parts.push("Shift");
	}
	const key = key_token_from_event(event);
	if (!key) {
		return "";
	}
	parts.push(key);
	return parts.join("+");
}

/**
 * @param {KeyboardEvent} event
 */
function key_token_from_event(event) {
	if (/^F\d+$/i.test(event.key)) {
		return event.key.toUpperCase();
	}
	if (event.key === "Delete") {
		return "Del";
	}
	if (event.key === "PageUp") {
		return "PgUp";
	}
	if (event.key === "PageDown") {
		return "PgDn";
	}
	if (event.key === "Escape") {
		return "Esc";
	}
	if (event.key === " " || event.code === "Space") {
		return "Space";
	}
	if (event.key === "Enter") {
		return "Enter";
	}
	if (event.key.length === 1) {
		const ch = event.key.toUpperCase();
		if (/^[A-Z0-9]$/.test(ch)) {
			return ch;
		}
	}
	if (event.code.startsWith("Key") && event.code.length === 4) {
		return event.code.slice(3);
	}
	if (event.code.startsWith("Digit") && event.code.length === 6) {
		return event.code.slice(5);
	}
	return "";
}

/**
 * @param {string} code
 */
function label_from_code(code) {
	if (code.startsWith("Key") && code.length === 4) {
		return code.slice(3);
	}
	if (code.startsWith("Digit") && code.length === 6) {
		return code.slice(5);
	}
	if (code === "BracketLeft") {
		return "[";
	}
	if (code === "BracketRight") {
		return "]";
	}
	if (code === "Backquote") {
		return "`";
	}
	if (code === "Space") {
		return "Space";
	}
	return code;
}

/**
 * @param {any} item
 * @param {(item: any) => void} visit
 */
function walk_menu_items(item, visit) {
	if (!item || item === MENU_DIVIDER) {
		return;
	}
	visit(item);
	if (item.submenu) {
		for (const child of item.submenu) {
			walk_menu_items(child, visit);
		}
	}
}

function for_each_menu_item(visit) {
	if (!menus_ref) {
		return;
	}
	for (const menu of Object.values(menus_ref)) {
		for (const item of menu) {
			walk_menu_items(item, visit);
		}
	}
}

function persist_menu_overrides() {
	localStore.set(MENU_STORAGE_KEY, menu_overrides, (_error) => { /* ignore */ });
}

/**
 * @returns {Record<string, string>}
 */
function get_menu_overrides() {
	return { ...menu_overrides };
}

/**
 * @param {Record<string, string> | null | undefined} next
 */
function set_menu_overrides(next) {
	menu_overrides = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
	persist_menu_overrides();
	apply_shortcuts_to_menus();
}

function apply_shortcuts_to_menus() {
	for_each_menu_item((item) => {
		if (!item.shortcut_id) {
			return;
		}
		const next = shortcut(item.shortcut_id, item.defaultShortcut || "");
		item.shortcutLabel = next.shortcutLabel;
		item.ariaKeyShortcuts = next.ariaKeyShortcuts;
	});
	document.querySelectorAll(".menu-item").forEach((el) => {
		const name = el.getAttribute("aria-label");
		let matched = null;
		for_each_menu_item((item) => {
			if (!item.shortcut_id || !item.label) {
				return;
			}
			const text = String(item.label).replace(/&/g, "");
			if (text === name) {
				matched = item;
			}
		});
		if (!matched) {
			return;
		}
		el.setAttribute("aria-keyshortcuts", matched.ariaKeyShortcuts || "");
		const shortcut_el = el.querySelector(".menu-item-shortcut");
		if (shortcut_el) {
			shortcut_el.textContent = matched.shortcutLabel || "";
		}
	});
	if (window.is_electron_app && window.setMenus && menus_ref) {
		window.setMenus(menus_ref);
	}
	sync_electron_captured_shortcuts();
}

function reserved_descriptors_from_label(shortcutLabel) {
	// RESERVED_COMBOS is written in the canonical form, so undo the Mac display label.
	const canonical_label = (shortcutLabel || "").replace(/\bCmd\b/g, "Ctrl");
	if (!canonical_label || !RESERVED_COMBOS.has(canonical_label)) {
		return null;
	}
	const parts = canonical_label.split("+").map((part) => part.trim());
	const key = parts.pop();
	if (!key) {
		return null;
	}
	let normalized = key.toLowerCase();
	if (normalized === "pgup") {
		normalized = "pageup";
	}
	if (normalized === "pgdn") {
		normalized = "pagedown";
	}
	if (normalized === "del") {
		normalized = "delete";
	}
	return {
		key: normalized,
		mod: parts.some((part) => /^Ctrl$/i.test(part)),
		alt: parts.some((part) => /^Alt$/i.test(part)),
		shift: parts.some((part) => /^Shift$/i.test(part)),
	};
}

function sync_electron_captured_shortcuts() {
	if (!window.is_electron_app || typeof window.setCapturedShortcuts !== "function") {
		return;
	}
	/** @type {object[]} */
	const captured = [];
	for_each_menu_item((item) => {
		const desc = reserved_descriptors_from_label(item.shortcutLabel || "");
		if (desc) {
			captured.push(desc);
		}
	});
	window.setCapturedShortcuts(captured);
}

/**
 * @param {OSGUITopLevelMenus} menus
 * @param {{ DEFAULT_KEYMAP: Record<string, string>, get_keymap: () => Record<string, string>, save_keymap: (next: Record<string, string>) => void }} [tool_api]
 */
function init_shortcut_settings(menus, tool_api) {
	menus_ref = menus;
	tool_keymap_api = tool_api || null;
	sync_electron_captured_shortcuts();
}

/**
 * @param {KeyboardEvent | JQuery.KeyDownEvent} event
 */
function handle_menu_shortcut_event(event) {
	if (recording_id) {
		return false;
	}
	const native = /** @type {KeyboardEvent} */ (/** @type {unknown} */ (event.originalEvent ?? event));
	if (native.repeat) {
		return false;
	}
	let matched = null;
	for_each_menu_item((item) => {
		if (matched || !item.shortcutLabel) {
			return;
		}
		if (event_matches_shortcut(native, item.shortcutLabel)) {
			matched = item;
		}
	});
	if (!matched) {
		return false;
	}
	if (typeof matched.enabled === "function" && !matched.enabled()) {
		native.preventDefault();
		return true;
	}
	native.preventDefault();
	native.stopPropagation?.();
	if (matched.checkbox?.toggle) {
		matched.checkbox.toggle();
	} else {
		matched.action?.();
	}
	return true;
}

function is_recording_shortcut() {
	return !!recording_id;
}

/**
 * @param {string} action
 */
function codes_for_tool_action(action) {
	const keymap = tool_keymap_api?.get_keymap() || {};
	return Object.keys(keymap).filter((code) => keymap[code] === action);
}

/**
 * @param {string} action
 * @param {string} code
 */
function set_tool_shortcut(action, code) {
	if (!tool_keymap_api) {
		return;
	}
	const next = { ...tool_keymap_api.get_keymap() };
	for (const existing of Object.keys(next)) {
		if (next[existing] === action) {
			delete next[existing];
		}
		if (existing === code) {
			delete next[existing];
		}
	}
	next[code] = action;
	tool_keymap_api.save_keymap(next);
}

function reset_all_shortcuts() {
	menu_overrides = {};
	persist_menu_overrides();
	tool_keymap_api?.save_keymap({});
	apply_shortcuts_to_menus();
}

function stop_recording() {
	recording_id = null;
	recording_is_tool = false;
	window.removeEventListener("keydown", on_record_keydown, true);
	$settings_window?.$content.find(".shortcut-bind.recording").removeClass("recording").text(function () {
		return /** @type {HTMLElement} */ (this).dataset.display || "None";
	});
}

/**
 * @param {KeyboardEvent} event
 */
function on_record_keydown(event) {
	if (!recording_id) {
		return;
	}
	if (event.key === "Control" || event.key === "Shift" || event.key === "Alt" || event.key === "Meta") {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	if (event.key === "Escape") {
		stop_recording();
		return;
	}
	if (event.key === "Backspace" || event.key === "Delete") {
		if (recording_is_tool && tool_keymap_api) {
			const next = { ...tool_keymap_api.get_keymap() };
			for (const code of Object.keys(next)) {
				if (next[code] === recording_id) {
					delete next[code];
				}
			}
			tool_keymap_api.save_keymap(next);
		} else {
			menu_overrides[recording_id] = "";
			persist_menu_overrides();
			apply_shortcuts_to_menus();
		}
		stop_recording();
		show_shortcut_settings_window();
		return;
	}
	if (recording_is_tool) {
		if (event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		set_tool_shortcut(recording_id, event.code);
	} else {
		const label = shortcut_label_from_event(event);
		if (!label) {
			return;
		}
		menu_overrides[recording_id] = label;
		persist_menu_overrides();
		apply_shortcuts_to_menus();
	}
	stop_recording();
	show_shortcut_settings_window();
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} id
 * @param {boolean} is_tool
 */
function begin_recording(button, id, is_tool) {
	stop_recording();
	recording_id = id;
	recording_is_tool = is_tool;
	button.classList.add("recording");
	button.textContent = "Press a key…";
	window.addEventListener("keydown", on_record_keydown, true);
}

function shortcut_rows() {
	/** @type {{id: string, group: string, label: string, display: string, is_tool: boolean}[]} */
	const rows = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for_each_menu_item((item) => {
		if (!item.shortcut_id || seen.has(item.shortcut_id)) {
			return;
		}
		seen.add(item.shortcut_id);
		const group = Object.entries(menus_ref || {}).find(([, items]) => {
			return items.some((candidate) => candidate === item || candidate?.submenu?.includes(item));
		})?.[0]?.replace(/&/g, "") || "Menus";
		rows.push({
			id: item.shortcut_id,
			group,
			label: String(item.label || item.shortcut_id).replace(/&/g, ""),
			display: item.shortcutLabel || "None",
			is_tool: false,
		});
	});
	for (const tool of TOOL_SHORTCUTS) {
		const codes = codes_for_tool_action(tool.action);
		const defaults = tool_keymap_api?.DEFAULT_KEYMAP || {};
		const fallback = Object.keys(defaults).filter((code) => defaults[code] === tool.action);
		const codes_to_show = codes.length ? codes : fallback;
		rows.push({
			id: tool.action,
			group: tool.group,
			label: tool.label,
			display: codes_to_show.map(label_from_code).join(", ") || "None",
			is_tool: true,
		});
	}
	return rows;
}

function render_shortcut_list() {
	if (!$settings_window) {
		return;
	}
	const $filter = $settings_window.$main.find(".shortcut-filter");
	const $list = $settings_window.$main.find(".shortcut-list");
	const list_el = $list[0];
	if (!list_el) {
		return;
	}
	const query = String($filter.val() || "").trim().toLowerCase();
	const scroll_top = list_el.scrollTop;
	$list.empty();
	let last_group = "";
	for (const row of shortcut_rows()) {
		const haystack = `${row.group} ${row.label} ${row.display}`.toLowerCase();
		if (query && !haystack.includes(query)) {
			continue;
		}
		if (row.group !== last_group) {
			last_group = row.group;
			$(E("div")).addClass("shortcut-group").text(row.group).appendTo($list);
		}
		const $row = $(E("div")).addClass("shortcut-row").appendTo($list);
		$(E("div")).addClass("shortcut-name").text(row.label).appendTo($row);
		const $bind = $(E("button")).addClass("shortcut-bind").attr({
			type: "button",
			title: "Click, then press a new shortcut. Backspace clears. Esc cancels.",
		}).text(row.display).appendTo($row);
		$bind[0].dataset.display = row.display;
		$bind.on("click", () => {
			begin_recording(/** @type {HTMLButtonElement} */ ($bind[0]), row.id, row.is_tool);
		});
	}
	list_el.scrollTop = scroll_top;
}

function show_shortcut_settings_window() {
	if ($settings_window) {
		stop_recording();
		$settings_window.bringToFront();
		render_shortcut_list();
		return;
	}
	stop_recording();
	const $w = $DialogWindow("Keyboard Shortcuts");
	$settings_window = $w;
	$w.addClass("shortcut-settings-window");
	$w.$content.css({ maxWidth: "560px" });

	const note = window.is_electron_app ?
		`These shortcuts belong to the app. ${MOD_KEY_LABEL}+N opens a new document instead of a new window.` :
		`In a browser tab, ${MOD_KEY_LABEL}+N, T, and W stay reserved by the browser. Use the desktop app to capture them, or assign different keys.`;

	$(E("p")).addClass("shortcut-settings-note").text(note).appendTo($w.$main);

	const $filter = $(E("input")).attr({
		type: "search",
		placeholder: "Filter shortcuts",
		"aria-label": "Filter shortcuts",
	}).addClass("shortcut-filter").appendTo($w.$main);

	$(E("div")).addClass("shortcut-list inset-deep").appendTo($w.$main);

	$filter.on("input", render_shortcut_list);
	render_shortcut_list();

	$w.$Button("Reset All", () => {
		reset_all_shortcuts();
		render_shortcut_list();
	});
	$w.$Button("Close", () => {
		$w.close();
	});
	$w.on("close", () => {
		stop_recording();
		if ($settings_window === $w) {
			$settings_window = null;
		}
	});
	$w.center();
}

export {
	event_matches_shortcut,
	get_menu_overrides,
	get_menu_shortcut,
	handle_menu_shortcut_event,
	init_shortcut_settings,
	is_recording_shortcut,
	set_menu_overrides,
	shortcut,
	show_shortcut_settings_window,
};
