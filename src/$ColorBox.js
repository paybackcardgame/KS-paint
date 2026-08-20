// @ts-check
/* global $bottom, $left, $right, button, get_direction, localize, palette, pointer, selected_colors */
import { $Component } from "./$Component.js";
// import { get_direction, localize } from "./app-localization.js";
import { show_edit_colors_window } from "./edit-colors.js";
import { undoable_option_change } from "./functions.js";
import { $G, E, from_canvas_coords, get_help_folder_icon, is_fully_transparent_swatch, make_canvas } from "./helpers.js";
import { get_color_history, push_color_history, set_pointer_color_panel_handler } from "./speedrun-features.js";

/**
 * Used by the Colors Box and by the Edit Colors dialog.
 * @param {string | CanvasPattern} color
 * @returns {JQuery<HTMLDivElement>}
 */
function $Swatch(color) {
	const $swatch = $(E("div")).addClass("swatch");
	const swatch_canvas = make_canvas();
	$(swatch_canvas).css({ pointerEvents: "none" }).appendTo($swatch);

	// @TODO: clean up event listener
	$G.on("theme-load", () => { update_$swatch($swatch); });
	$swatch.data("swatch", color);
	update_$swatch($swatch, color);

	return $swatch;
}

/**
 * @param {JQuery<HTMLDivElement>} $swatch
 * @param {string | CanvasPattern | undefined=} new_color
 */
function update_$swatch($swatch, new_color) {
	if (new_color instanceof CanvasPattern) {
		$swatch.addClass("pattern");
		$swatch[0].dataset.color = "";
	} else if (typeof new_color === "string") {
		$swatch.removeClass("pattern");
		$swatch[0].dataset.color = new_color;
	} else if (new_color !== undefined) {
		throw new TypeError(`argument to update_$swatch must be CanvasPattern or string (or undefined); got type ${typeof new_color}`);
	}
	new_color = new_color || $swatch.data("swatch");
	$swatch.data("swatch", new_color);
	const transparent = is_fully_transparent_swatch(new_color);
	$swatch.toggleClass("transparent-swatch", transparent);
	if (transparent) {
		$swatch.attr("title", "Transparent");
	} else if ($swatch.attr("title") === "Transparent") {
		$swatch.removeAttr("title");
	}
	const swatch_canvas = /** @type {PixelCanvas} */ (
		$swatch.find("canvas")[0]
	);
	requestAnimationFrame(() => {
		swatch_canvas.width = $swatch.innerWidth();
		swatch_canvas.height = $swatch.innerHeight();
		if (new_color == null || new_color === "") {
			return;
		}
		const ctx = swatch_canvas.ctx;
		if (transparent) {
			const size = 4;
			for (let y = 0; y < swatch_canvas.height; y += size) {
				for (let x = 0; x < swatch_canvas.width; x += size) {
					ctx.fillStyle = ((x + y) / size) % 2 === 0 ? "#ffffff" : "#c0c0c0";
					ctx.fillRect(x, y, size, size);
				}
			}
			return;
		}
		ctx.fillStyle = new_color;
		ctx.fillRect(0, 0, swatch_canvas.width, swatch_canvas.height);
	});
}

/**
 * @param {boolean} vertical
 * @returns {JQuery<HTMLDivElement> & I$Component & I$ColorBox}
 */
function $ColorBox(vertical) {
	const $cb = $(E("div")).addClass("color-box");

	const $current_colors = $Swatch(selected_colors.ternary).addClass("current-colors");
	const $palette = $(E("div")).addClass("palette");
	const $color_history = $(E("div")).addClass("color-history").attr("title", "Recent colors");

	$cb.append($current_colors, $palette, $color_history);

	const $foreground_color = $Swatch(selected_colors.foreground).addClass("color-selection foreground-color");
	const $background_color = $Swatch(selected_colors.background).addClass("color-selection background-color");
	$current_colors.append($background_color, $foreground_color);

	$G.on("option-changed", () => {
		update_$swatch($foreground_color, selected_colors.foreground);
		update_$swatch($background_color, selected_colors.background);
		update_$swatch($current_colors, selected_colors.ternary);
	});

	$current_colors.on("pointerdown", () => {
		undoable_option_change({ name: "Swap Colors", icon: get_help_folder_icon("p_color.png") }, () => {
			const new_bg = selected_colors.foreground;
			selected_colors.foreground = selected_colors.background;
			selected_colors.background = new_bg;
			$G.triggerHandler("option-changed");
		});
	});

	const make_color_button = (color, $parent = $palette) => {

		const $b = $Swatch(color).addClass("color-button");
		$b.appendTo($parent);

		const double_click_period_ms = 400;
		let within_double_click_period = false;
		let double_click_button = null;
		let double_click_tid;
		// @TODO: handle left+right click at same time
		// can do this with mousedown instead of pointerdown, but may need to improve Dwell Clicker click simulation
		$b.on("pointerdown", (e) => {
			// @TODO: allow metaKey for ternary color, and selection cropping, on macOS?

			if (button === 0) {
				$c.data("$last_fg_color_button", $b);
			}

			const color_selection_slot = e.ctrlKey ? "ternary" : e.button === 0 ? "foreground" : e.button === 2 ? "background" : null;
			if (color_selection_slot) {
				if (within_double_click_period && e.button === double_click_button) {
					show_edit_colors_window($b, color_selection_slot);
				} else {
					undoable_option_change({ name: "Select Color", icon: get_help_folder_icon("p_color.png") }, () => {
						selected_colors[color_selection_slot] = $b.data("swatch");
						if (color_selection_slot === "foreground") {
							push_color_history($b.data("swatch"));
						}
						$G.trigger("option-changed");
					});
				}

				clearTimeout(double_click_tid);
				double_click_tid = setTimeout(() => {
					within_double_click_period = false;
					double_click_button = null;
				}, double_click_period_ms);
				within_double_click_period = true;
				double_click_button = e.button;
			}
		});
		return $b;
	};

	const rebuild_color_history = () => {
		$color_history.empty();
		for (const color of get_color_history()) {
			make_color_button(color, $color_history).addClass("color-history-button");
		}
	};

	const build_palette = () => {
		$palette.empty();

		palette.forEach((color) => make_color_button(color));

		// Note: this doesn't work until the colors box is in the DOM
		const $some_button = $palette.find(".color-button");
		const rows = /** @type {{ rows?: number }} */ (palette).rows || 2;
		const columns = Math.max(1, Math.ceil(palette.length / rows));
		if (vertical) {
			const height_per_button =
				$some_button.outerHeight() +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-top")) +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-bottom"));
			const width_per_button =
				$some_button.outerWidth() +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-left")) +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-right"));
			$palette.height(columns * height_per_button);
			$palette.width(rows * width_per_button);
			$cb.width(rows * width_per_button);
			$c.css({ width: rows * width_per_button + 15 });
			$color_history.css({ maxWidth: rows * width_per_button, maxHeight: "" });
		} else {
			const width_per_button =
				$some_button.outerWidth() +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-left")) +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-right"));
			const height_per_button =
				$some_button.outerHeight() +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-top")) +
				parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-bottom"));
			$palette.width(columns * width_per_button);
			$palette.height(rows * height_per_button);
			$cb.height(rows * height_per_button);
			$c.css({ height: rows * height_per_button + 15 });
			$color_history.css({ maxHeight: rows * height_per_button, maxWidth: "" });
		}

		// the "last foreground color button" starts out as the first in the palette
		$c.data("$last_fg_color_button", $palette.find(".color-button:first-child"));
		rebuild_color_history();
	};

	let $c;
	if (vertical) {
		$c = $Component(localize("Colors"), "colors-component", "tall", $cb);
		$c.appendTo(get_direction() === "rtl" ? $left : $right); // opposite ToolBox by default
	} else {
		$c = $Component(localize("Colors"), "colors-component", "wide", $cb);
		$c.appendTo($bottom);
	}

	build_palette();
	$(window).on("theme-change", build_palette);
	$G.on("color-history-change", rebuild_color_history);

	// I'm gonna do things messy, got a long road to go!
	// eslint-disable-next-line no-self-assign
	$c = /** @type {JQuery<HTMLDivElement> & I$Component & I$ColorBox} */ ($c);

	$c.rebuild_palette = build_palette;

	return $c;
}

/** @type {JQuery<HTMLDivElement> | null} */
let $pointer_color_panel = null;
/** @type {{ x: number, y: number }} */
let last_pointer_client = { x: 0, y: 0 };
let has_last_pointer_client = false;

$G.on("pointermove", (e) => {
	if (isFinite(e.clientX) && isFinite(e.clientY)) {
		last_pointer_client = { x: e.clientX, y: e.clientY };
		has_last_pointer_client = true;
	}
});

function pointer_client_anchor() {
	if (has_last_pointer_client) {
		return last_pointer_client;
	}
	if (pointer) {
		const client = from_canvas_coords(pointer);
		return { x: client.clientX, y: client.clientY };
	}
	return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

function close_pointer_color_panel() {
	if (!$pointer_color_panel) {
		return;
	}
	window.removeEventListener("pointerdown", on_pointer_color_panel_pointerdown, true);
	window.removeEventListener("keydown", on_pointer_color_panel_keydown, true);
	$pointer_color_panel.remove();
	$pointer_color_panel = null;
}

/**
 * @param {PointerEvent} event
 */
function on_pointer_color_panel_pointerdown(event) {
	if ($pointer_color_panel && $pointer_color_panel[0].contains(/** @type {Node} */ (event.target))) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	close_pointer_color_panel();
}

/**
 * @param {KeyboardEvent} event
 */
function on_pointer_color_panel_keydown(event) {
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		close_pointer_color_panel();
	}
}

/**
 * @param {string | CanvasPattern} color
 */
function $PopupSwatch(color) {
	const $swatch = $(E("div")).addClass("swatch");
	const swatch_canvas = make_canvas();
	$(swatch_canvas).css({ pointerEvents: "none" }).appendTo($swatch);
	update_$swatch($swatch, color);
	return $swatch;
}

/**
 * @param {JQuery<HTMLDivElement>} $parent
 * @param {string | CanvasPattern} color
 */
function add_pointer_panel_swatch($parent, color) {
	const $b = $PopupSwatch(color).addClass("color-button");
	$b.appendTo($parent);
	$b.on("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		const color_selection_slot = e.ctrlKey ? "ternary" : e.button === 0 ? "foreground" : e.button === 2 ? "background" : null;
		if (!color_selection_slot) {
			return;
		}
		undoable_option_change({ name: "Select Color", icon: get_help_folder_icon("p_color.png") }, () => {
			selected_colors[color_selection_slot] = $b.data("swatch");
			if (color_selection_slot === "foreground") {
				push_color_history($b.data("swatch"));
			}
			$G.trigger("option-changed");
		});
		close_pointer_color_panel();
	});
	$b.on("contextmenu", (e) => {
		e.preventDefault();
	});
	return $b;
}

function position_pointer_color_panel() {
	if (!$pointer_color_panel) {
		return;
	}
	const pad = 8;
	const offset = 16;
	const el = $pointer_color_panel[0];
	const rect = el.getBoundingClientRect();
	const anchor = pointer_client_anchor();
	let x = anchor.x + offset;
	let y = anchor.y + offset;
	if (x + rect.width > innerWidth - pad) {
		x = anchor.x - rect.width - offset;
	}
	if (y + rect.height > innerHeight - pad) {
		y = anchor.y - rect.height - offset;
	}
	x = Math.max(pad, Math.min(x, innerWidth - rect.width - pad));
	y = Math.max(pad, Math.min(y, innerHeight - rect.height - pad));
	$pointer_color_panel.css({ left: `${x}px`, top: `${y}px` });
}

function show_pointer_color_panel() {
	close_pointer_color_panel();

	const $panel = $(E("div")).addClass("pointer-color-panel inset-deep");
	$pointer_color_panel = /** @type {JQuery<HTMLDivElement>} */ ($panel);

	const $row = $(E("div")).addClass("pointer-color-panel-row").appendTo($panel);

	const $current_colors = $PopupSwatch(selected_colors.ternary).addClass("current-colors");
	const $foreground_color = $PopupSwatch(selected_colors.foreground).addClass("color-selection foreground-color");
	const $background_color = $PopupSwatch(selected_colors.background).addClass("color-selection background-color");
	$current_colors.append($background_color, $foreground_color);
	$current_colors.on("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		undoable_option_change({ name: "Swap Colors", icon: get_help_folder_icon("p_color.png") }, () => {
			const new_bg = selected_colors.foreground;
			selected_colors.foreground = selected_colors.background;
			selected_colors.background = new_bg;
			$G.triggerHandler("option-changed");
		});
		update_$swatch($foreground_color, selected_colors.foreground);
		update_$swatch($background_color, selected_colors.background);
	});
	$row.append($current_colors);

	const $palette = $(E("div")).addClass("palette").appendTo($row);
	for (const color of palette) {
		add_pointer_panel_swatch($palette, color);
	}

	const history = get_color_history();
	if (history.length) {
		const $history = $(E("div")).addClass("pointer-color-panel-history").attr("title", "Recent colors");
		for (const color of history) {
			add_pointer_panel_swatch($history, color).addClass("color-history-button");
		}
		$panel.append($history);
	}

	const edit_label = `${String(localize("&Edit Colors")).replace(/&/g, "")}…`;
	const $edit = $(E("button")).addClass("pointer-color-panel-edit").attr({
		type: "button",
		title: edit_label,
	}).text(edit_label);
	$edit.on("pointerdown", (e) => {
		e.stopPropagation();
	});
	$edit.on("click", (e) => {
		e.preventDefault();
		close_pointer_color_panel();
		show_edit_colors_window();
	});
	$panel.append($edit);

	$panel.on("pointerdown", (e) => {
		e.stopPropagation();
	});

	$panel.appendTo(document.body);

	const rows = /** @type {{ rows?: number }} */ (palette).rows || 2;
	const columns = Math.max(1, Math.ceil(palette.length / rows));
	const $some_button = $palette.find(".color-button");
	if ($some_button[0]) {
		const width_per_button =
			$some_button.outerWidth() +
			parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-left")) +
			parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-right"));
		const height_per_button =
			$some_button.outerHeight() +
			parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-top")) +
			parseFloat(getComputedStyle($some_button[0]).getPropertyValue("margin-bottom"));
		$palette.css({
			width: columns * width_per_button,
			height: rows * height_per_button,
		});
		$row.css({ height: rows * height_per_button });
	}

	position_pointer_color_panel();
	window.addEventListener("keydown", on_pointer_color_panel_keydown, true);
	// Wait a tick so the C key's associated pointer state cannot dismiss the panel immediately.
	requestAnimationFrame(() => {
		if ($pointer_color_panel) {
			window.addEventListener("pointerdown", on_pointer_color_panel_pointerdown, true);
		}
	});
}

function toggle_pointer_color_panel() {
	if ($pointer_color_panel) {
		close_pointer_color_panel();
		return;
	}
	show_pointer_color_panel();
}

set_pointer_color_panel_handler(toggle_pointer_color_panel);

export {
	$ColorBox,
	$Swatch,
	toggle_pointer_color_panel,
	update_$swatch
};

