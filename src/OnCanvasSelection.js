// @ts-check
/* global $canvas_area, $status_position, $status_size, layers, main_canvas, selected_colors, selection_all_layers, tool_transparent_mode */
import { Handles } from "./Handles.js";
import { OnCanvasObject } from "./OnCanvasObject.js";
import { get_tool_by_id, make_or_update_undoable, undoable, update_helper_layer } from "./functions.js";
import { $G, get_icon_for_tool, get_rgba_from_color, make_canvas, make_css_cursor, to_canvas_coords } from "./helpers.js";
import { rotate } from "./image-manipulation.js";
import { composite_layers, get_active_layer, get_active_layer_context, mark_layer_dirty } from "./layers.js";
import { TOOL_SELECT } from "./tools.js";

class OnCanvasSelection extends OnCanvasObject {
	/**
	 * @param {number} x
	 * @param {number} y
	 * @param {number} width
	 * @param {number} height
	 * @param {HTMLImageElement | HTMLCanvasElement | ImageData=} image_source
	 */
	constructor(x, y, width, height, image_source) {
		super(x, y, width, height, true);

		this.$el.addClass("selection");
		let last_tool_transparent_mode = tool_transparent_mode;
		let last_background_color = selected_colors.background;
		this._on_option_changed = () => {
			if (!this.source_canvas) {
				return;
			}
			if (last_tool_transparent_mode !== tool_transparent_mode ||
				last_background_color !== selected_colors.background) {
				last_tool_transparent_mode = tool_transparent_mode;
				last_background_color = selected_colors.background;
				this.update_tool_transparent_mode();
			}
		};
		$G.on("option-changed", this._on_option_changed);

		/** @type {{ layerId: string, canvas: PixelCanvas }[]} */
		this.layer_slices = [];
		this.instantiate(image_source);
	}
	position() {
		super.position(true);
		update_helper_layer(); // @TODO: under-grid specific helper layer?
	}
	/**
	 * @param {HTMLImageElement | HTMLCanvasElement | ImageData=} image_source
	 */
	instantiate(image_source) {
		this.$el.css({
			cursor: make_css_cursor("move", [8, 8], "move"),
			touchAction: "none",
		});
		this.position();

		const instantiate = () => {
			if (image_source) {
				// (this applies when pasting a selection)
				// NOTE: need to create a Canvas because something about imgs makes dragging not work with magnification
				// (width vs naturalWidth?)
				// and at least apply_image_transformation needs it to be a canvas now (and the property name says canvas anyways)
				this.source_canvas = make_canvas(image_source);
				// @TODO: is this width/height code needed? probably not! wouldn't it clear the canvas anyways?
				// but maybe we should assert in some way that the widths are the same, or resize the selection?
				if (this.source_canvas.width !== this.width) {
					this.source_canvas.width = this.width;
				}
				if (this.source_canvas.height !== this.height) {
					this.source_canvas.height = this.height;
				}
				this.canvas = make_canvas(this.source_canvas);
			} else {
				this.source_canvas = make_canvas(this.width, this.height);
				if (selection_all_layers) {
					composite_layers();
				}
				const source = selection_all_layers ? main_canvas : get_active_layer().canvas;
				this.source_canvas.ctx.drawImage(source, this.x, this.y, this.width, this.height, 0, 0, this.width, this.height);
				this.canvas = make_canvas(this.source_canvas);
				this.cut_out_background();
			}
			this.$el.append(this.canvas);
			this.handles = new Handles({
				$handles_container: this.$el,
				$object_container: $canvas_area,
				outset: 2,
				get_rect: () => ({ x: this.x, y: this.y, width: this.width, height: this.height }),
				set_rect: ({ x, y, width, height }) => {
					undoable({
						name: "Resize Selection",
						icon: get_icon_for_tool(get_tool_by_id(TOOL_SELECT)),
						soft: true,
					}, () => {
						this.x = x;
						this.y = y;
						this.width = width;
						this.height = height;
						this.position();
						this.resize();
					});
				},
				get_ghost_offset_left: () => parseFloat($canvas_area.css("padding-left")) + 1,
				get_ghost_offset_top: () => parseFloat($canvas_area.css("padding-top")) + 1,
			});
			let mox, moy;
			const pointermove = (e) => {
				make_or_update_undoable({
					// XXX: Localization hazard: logic based on English action names
					match: (history_node) =>
						(e.shiftKey && /^(Smear|Stamp|Move) Selection$/.test(history_node.name)) ||
						(!e.shiftKey && /^Move Selection$/.test(history_node.name)),
					name: e.shiftKey ? "Smear Selection" : "Move Selection",
					update_name: true,
					icon: get_icon_for_tool(get_tool_by_id(TOOL_SELECT)),
					soft: true,
				}, () => {
					const m = to_canvas_coords(e);
					this.x = Math.max(Math.min(m.x - mox, main_canvas.width), -this.width);
					this.y = Math.max(Math.min(m.y - moy, main_canvas.height), -this.height);
					this.position();
					if (e.shiftKey) {
						// Smear selection
						this.draw();
					}
				});
			};
			this.canvas_pointerdown = (e) => {
				e.preventDefault();
				const rect = this.canvas.getBoundingClientRect();
				const cx = e.clientX - rect.left;
				const cy = e.clientY - rect.top;
				mox = ~~(cx / rect.width * this.canvas.width);
				moy = ~~(cy / rect.height * this.canvas.height);
				$G.on("pointermove", pointermove);
				this.dragging = true;
				update_helper_layer(); // for thumbnail, which draws textbox outline if it's not being dragged
				$G.one("pointerup", () => {
					$G.off("pointermove", pointermove);
					this.dragging = false;
					update_helper_layer(); // for thumbnail, which draws selection outline if it's not being dragged
				});
				if (e.shiftKey) {
					// Stamp or start to smear selection
					undoable({
						name: "Stamp Selection",
						icon: get_icon_for_tool(get_tool_by_id(TOOL_SELECT)),
						soft: true,
					}, () => {
						this.draw();
					});
				} else if (e.ctrlKey || e.altKey) { // Alt-drag duplicates (stamp then move); Ctrl stamps as before
					// Stamp selection
					undoable({
						name: e.altKey ? "Duplicate Selection" : "Stamp Selection",
						icon: get_icon_for_tool(get_tool_by_id(TOOL_SELECT)),
						soft: true,
					}, () => {
						this.draw();
					});
				}
			};
			$(this.canvas).on("pointerdown", this.canvas_pointerdown);
			$canvas_area.trigger("resize"); // could use "update" event instead if this is just to hide the main canvas handles
			$status_position.text("");
			$status_size.text("");
		};

		instantiate();
	}
	/**
	 * Lift pixels inside the current selection mask and punch a hole.
	 * Default: copy/punch only the active layer, keeping each pixel's alpha.
	 * All layers: lift each visible layer separately and punch that same layer,
	 * so a move can put every slice back without flattening.
	 * @param {{ all_layers?: boolean }=} options
	 */
	cut_out_background(options = {}) {
		const all_layers = options.all_layers ?? selection_all_layers;
		const cutout = this.canvas;
		const maskImageData = cutout.ctx.getImageData(0, 0, this.width, this.height);

		const targets = all_layers ?
			layers.filter((layer) => layer.visible) :
			[get_active_layer()];
		/** @type {{ layerId: string, canvas: PixelCanvas }[]} */
		const slices = [];
		for (const layer of targets) {
			if (!layer) {
				continue;
			}
			const layerImageData = layer.ctx.getImageData(this.x, this.y, this.width, this.height);
			const lifted = cutout.ctx.createImageData(this.width, this.height);
			let any = false;
			for (let i = 0; i < maskImageData.data.length; i += 4) {
				if (maskImageData.data[i + 3] > 0) {
					lifted.data[i + 0] = layerImageData.data[i + 0];
					lifted.data[i + 1] = layerImageData.data[i + 1];
					lifted.data[i + 2] = layerImageData.data[i + 2];
					lifted.data[i + 3] = layerImageData.data[i + 3];
					if (layerImageData.data[i + 3] > 0) {
						any = true;
					}
					layerImageData.data[i + 0] = 0;
					layerImageData.data[i + 1] = 0;
					layerImageData.data[i + 2] = 0;
					layerImageData.data[i + 3] = 0;
				}
			}
			layer.ctx.putImageData(layerImageData, this.x, this.y);
			mark_layer_dirty(layer.id);
			if (any || !all_layers) {
				const slice_canvas = make_canvas(this.width, this.height);
				slice_canvas.ctx.putImageData(lifted, 0, 0);
				slices.push({ layerId: layer.id, canvas: slice_canvas });
			}
		}
		this.layer_slices = slices;

		cutout.ctx.clearRect(0, 0, this.width, this.height);
		for (const slice of slices) {
			const layer = layers.find((candidate) => candidate.id === slice.layerId);
			cutout.ctx.save();
			cutout.ctx.globalAlpha = layer && layer.opacity > 0 ? layer.opacity : 1;
			cutout.ctx.drawImage(slice.canvas, 0, 0);
			cutout.ctx.restore();
		}
		// Keep the lifted RGBA as the source so Transparent mode doesn't restore a composite/mask.
		this.source_canvas = make_canvas(this.canvas);

		this.update_tool_transparent_mode();
		composite_layers();

		$G.triggerHandler("session-update"); // autosave
		update_helper_layer();
	}
	/**
	 * @returns {{ layerId: string, image_data: ImageData }[] | null}
	 */
	get_layer_slice_data() {
		if (!this.layer_slices?.length) {
			return null;
		}
		return this.layer_slices.map((slice) => ({
			layerId: slice.layerId,
			image_data: slice.canvas.ctx.getImageData(0, 0, slice.canvas.width, slice.canvas.height),
		}));
	}
	/**
	 * @param {{ layerId: string, image_data: ImageData }[] | null | undefined} slices
	 */
	set_layer_slice_data(slices) {
		if (!slices?.length) {
			this.layer_slices = [];
			return;
		}
		this.layer_slices = slices.map((slice) => ({
			layerId: slice.layerId,
			canvas: make_canvas(slice.image_data),
		}));
	}
	update_tool_transparent_mode() {
		const sourceImageData = this.source_canvas.ctx.getImageData(0, 0, this.width, this.height);
		const cutoutImageData = this.canvas.ctx.createImageData(this.width, this.height);
		const background_color_rgba = get_rgba_from_color(selected_colors.background);
		// NOTE: In b&w mode, mspaint treats the transparency color as white,
		// regardless of the pattern selected, even if the selected background color is pure black.
		// We allow any kind of image data while in our "b&w mode".
		// Our b&w mode is essentially 'patterns in the palette'.
		const match_threshold = 1; // 1 is just enough for a workaround for Brave browser's farbling: https://github.com/1j01/jspaint/issues/184
		for (let i = 0; i < cutoutImageData.data.length; i += 4) {
			let in_cutout = sourceImageData.data[i + 3] > 1;
			if (tool_transparent_mode) {
				// @FIXME: work with transparent selected background color
				// (support treating partially transparent background colors as transparency)
				if (
					Math.abs(sourceImageData.data[i + 0] - background_color_rgba[0]) <= match_threshold &&
					Math.abs(sourceImageData.data[i + 1] - background_color_rgba[1]) <= match_threshold &&
					Math.abs(sourceImageData.data[i + 2] - background_color_rgba[2]) <= match_threshold &&
					Math.abs(sourceImageData.data[i + 3] - background_color_rgba[3]) <= match_threshold
				) {
					in_cutout = false;
				}
			}
			if (in_cutout) {
				cutoutImageData.data[i + 0] = sourceImageData.data[i + 0];
				cutoutImageData.data[i + 1] = sourceImageData.data[i + 1];
				cutoutImageData.data[i + 2] = sourceImageData.data[i + 2];
				cutoutImageData.data[i + 3] = sourceImageData.data[i + 3];
			} else {
				// cutoutImageData.data[i+0] = 0;
				// cutoutImageData.data[i+1] = 0;
				// cutoutImageData.data[i+2] = 0;
				// cutoutImageData.data[i+3] = 0;
			}
		}
		this.canvas.ctx.putImageData(cutoutImageData, 0, 0);

		update_helper_layer();
	}
	// @TODO: should Image > Invert apply to this.source_canvas or to this.canvas (replacing this.source_canvas with the result)?
	/**
	 * @param {PixelCanvas} new_source_canvas
	 * @param {PixelCanvas[]=} new_slice_canvases
	 */
	replace_source_canvas(new_source_canvas, new_slice_canvases) {
		const old_width = this.source_canvas.width;
		const old_height = this.source_canvas.height;
		if (new_slice_canvases?.length && this.layer_slices?.length) {
			this.layer_slices = this.layer_slices.map((slice, index) => ({
				layerId: slice.layerId,
				canvas: new_slice_canvases[index] || slice.canvas,
			}));
		} else if (
			this.layer_slices?.length &&
			(new_source_canvas.width !== old_width || new_source_canvas.height !== old_height)
		) {
			this.layer_slices = this.layer_slices.map((slice) => {
				const next = make_canvas(new_source_canvas.width, new_source_canvas.height);
				next.ctx.drawImage(slice.canvas, 0, 0, next.width, next.height);
				return { layerId: slice.layerId, canvas: next };
			});
		}
		this.source_canvas = new_source_canvas;
		const new_canvas = make_canvas(new_source_canvas);
		$(this.canvas).replaceWith(new_canvas);
		this.canvas = new_canvas;
		const center_x = this.x + this.width / 2;
		const center_y = this.y + this.height / 2;
		const new_width = new_canvas.width;
		const new_height = new_canvas.height;
		// NOTE: flooring the coordinates to integers avoids blurring
		// but it introduces "inching", where the selection can move along by pixels if you rotate it repeatedly
		// could introduce an "error offset" just to avoid this but that seems overkill
		// and then that would be weird hidden behavior, probably not worth it
		// Math.round() might make it do it on fewer occasions(?),
		// but then it goes down *and* to the right, 2 directions vs One Direction
		// and Math.ceil() is the worst of both worlds
		this.x = ~~(center_x - new_width / 2);
		this.y = ~~(center_y - new_height / 2);
		this.width = new_width;
		this.height = new_height;
		this.position();
		$(this.canvas).on("pointerdown", this.canvas_pointerdown);
		this.$el.triggerHandler("resize"); //?
		this.update_tool_transparent_mode();
	}
	resize() {
		const new_source_canvas = make_canvas(this.width, this.height);
		new_source_canvas.ctx.drawImage(this.source_canvas, 0, 0, this.width, this.height);
		this.replace_source_canvas(new_source_canvas);
	}
	scale(factor) {
		const new_width = Math.max(1, this.width * factor);
		const new_height = Math.max(1, this.height * factor);
		const new_source_canvas = make_canvas(new_width, new_height);
		new_source_canvas.ctx.drawImage(this.source_canvas, 0, 0, new_source_canvas.width, new_source_canvas.height);
		this.replace_source_canvas(new_source_canvas);
	}
	draw() {
		try {
			if (this.layer_slices?.length) {
				for (const slice of this.layer_slices) {
					const layer = layers.find((candidate) => candidate.id === slice.layerId);
					if (!layer) {
						continue;
					}
					let source = slice.canvas;
					if (tool_transparent_mode) {
						source = this._canvas_with_transparent_mode(slice.canvas);
					}
					layer.ctx.drawImage(source, this.x, this.y);
					mark_layer_dirty(layer.id);
				}
			} else {
				get_active_layer_context().drawImage(this.canvas, this.x, this.y);
				mark_layer_dirty();
			}
			composite_layers();
		} catch (_error) {
			// ignore
		}
	}
	/**
	 * @param {PixelCanvas} source
	 * @returns {PixelCanvas}
	 */
	_canvas_with_transparent_mode(source) {
		const filtered = make_canvas(source.width, source.height);
		const sourceImageData = source.ctx.getImageData(0, 0, source.width, source.height);
		const destImageData = filtered.ctx.createImageData(source.width, source.height);
		const background_color_rgba = get_rgba_from_color(selected_colors.background);
		const match_threshold = 1;
		for (let i = 0; i < destImageData.data.length; i += 4) {
			if (
				Math.abs(sourceImageData.data[i + 0] - background_color_rgba[0]) <= match_threshold &&
				Math.abs(sourceImageData.data[i + 1] - background_color_rgba[1]) <= match_threshold &&
				Math.abs(sourceImageData.data[i + 2] - background_color_rgba[2]) <= match_threshold &&
				Math.abs(sourceImageData.data[i + 3] - background_color_rgba[3]) <= match_threshold
			) {
				continue;
			}
			destImageData.data[i + 0] = sourceImageData.data[i + 0];
			destImageData.data[i + 1] = sourceImageData.data[i + 1];
			destImageData.data[i + 2] = sourceImageData.data[i + 2];
			destImageData.data[i + 3] = sourceImageData.data[i + 3];
		}
		filtered.ctx.putImageData(destImageData, 0, 0);
		return filtered;
	}
	/**
	 * While Y is held: dragging near edges/handles rotates (Photoshop-style)
	 * instead of stretching. Center drag still moves the selection.
	 * @param {boolean} on
	 */
	set_rotate_modifier(on) {
		this._rotate_modifier = on;
		this.$el.toggleClass("y-rotate-mode", on);

		if (on) {
			if (!this._on_rotate_pointerdown) {
				this._on_rotate_pointerdown = (e) => this._begin_edge_rotate(e);
				this._on_rotate_pointermove = (e) => this._update_rotate_cursor(e);
			}
			this.$el[0].addEventListener("pointerdown", this._on_rotate_pointerdown, true);
			this.$el[0].addEventListener("pointermove", this._on_rotate_pointermove, true);
			this._update_rotate_cursor_style(true);
		} else {
			if (this._on_rotate_pointerdown) {
				this.$el[0].removeEventListener("pointerdown", this._on_rotate_pointerdown, true);
				this.$el[0].removeEventListener("pointermove", this._on_rotate_pointermove, true);
			}
			this.$el.css({ transform: "", transformOrigin: "", cursor: "" });
			this._update_rotate_cursor_style(false);
			if (this._rotating) {
				this._rotating = false;
			}
		}
	}
	/**
	 * @param {boolean} rotate_mode
	 */
	_update_rotate_cursor_style(rotate_mode) {
		const cursor = rotate_mode ?
			make_css_cursor("move", [8, 8], "grab") :
			"";
		this.$el.find(".handle, .grab-region").each((_i, el) => {
			const $el = $(el);
			if (rotate_mode) {
				if (!$el.data("jspaint-resize-cursor")) {
					$el.data("jspaint-resize-cursor", $el.css("cursor"));
				}
				$el.css("cursor", cursor);
			} else {
				const prev = $el.data("jspaint-resize-cursor");
				if (prev != null) {
					$el.css("cursor", prev);
					$el.removeData("jspaint-resize-cursor");
				}
			}
		});
	}
	/**
	 * @param {PointerEvent} e
	 * @returns {boolean}
	 */
	_is_near_selection_edge(e) {
		const rect = this.$el[0].getBoundingClientRect();
		const margin = 28;
		const x = e.clientX;
		const y = e.clientY;
		const near_left = x >= rect.left - margin && x <= rect.left + margin;
		const near_right = x >= rect.right - margin && x <= rect.right + margin;
		const near_top = y >= rect.top - margin && y <= rect.top + margin;
		const near_bottom = y >= rect.bottom - margin && y <= rect.bottom + margin;
		const in_bounds =
			x >= rect.left - margin && x <= rect.right + margin &&
			y >= rect.top - margin && y <= rect.bottom + margin;
		if (!in_bounds) {
			return false;
		}
		const target = /** @type {HTMLElement} */ (e.target);
		const on_handle = !!(target.closest && target.closest(".handle, .grab-region"));
		// Corners / edges / handles → rotate. Deep interior → move.
		return on_handle || near_left || near_right || near_top || near_bottom;
	}
	/**
	 * @param {PointerEvent} e
	 */
	_update_rotate_cursor(e) {
		if (!this._rotate_modifier || this._rotating) {
			return;
		}
		if (this._is_near_selection_edge(e)) {
			this.$el.css("cursor", make_css_cursor("move", [8, 8], "grab"));
		} else {
			this.$el.css("cursor", make_css_cursor("move", [8, 8], "move"));
		}
	}
	/**
	 * @param {PointerEvent} e
	 */
	_begin_edge_rotate(e) {
		if (!this._rotate_modifier || e.button !== 0) {
			return;
		}
		if (!this._is_near_selection_edge(e)) {
			return; // let normal move / other handlers run
		}
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();

		this._rotating = true;
		const cx = this.x + this.width / 2;
		const cy = this.y + this.height / 2;
		const start = to_canvas_coords(e);
		const start_angle = Math.atan2(start.y - cy, start.x - cx);
		/** @type {number} */
		let pending_angle = 0;

		const on_move = (e2) => {
			const p = to_canvas_coords(e2);
			pending_angle = Math.atan2(p.y - cy, p.x - cx) - start_angle;
			this.$el.css({
				transform: `rotate(${pending_angle}rad)`,
				transformOrigin: "50% 50%",
			});
			if (window.$status_text) {
				window.$status_text.text(`Rotate: ${(pending_angle * 180 / Math.PI).toFixed(1)}°`);
			}
		};
		const on_up = () => {
			$G.off("pointermove", on_move);
			this._rotating = false;
			this.$el.css({ transform: "", transformOrigin: "" });
			if (Math.abs(pending_angle) > 0.001) {
				rotate(pending_angle);
			}
			if (window.$status_text?.default) {
				window.$status_text.default();
			}
		};
		$G.on("pointermove", on_move);
		$G.one("pointerup", on_up);
	}
	/** @deprecated use set_rotate_modifier — kept for callers */
	enable_free_transform() {
		this.set_rotate_modifier(true);
	}
	destroy() {
		this.set_rotate_modifier(false);
		super.destroy();
		$G.off("option-changed", this._on_option_changed);
		update_helper_layer(); // @TODO: under-grid specific helper layer?
	}
}

export { OnCanvasSelection };

