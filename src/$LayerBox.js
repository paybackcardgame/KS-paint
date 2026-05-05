// @ts-check
/* global $right, get_direction */

import { $Component } from "./$Component.js";
import { $G, E } from "./helpers.js";
import { layerManager } from "./layers.js";

/**
 * Creates the Layers panel UI, matching jspaint's Windows-98 component style.
 * Docks to the right side by default.
 *
 * @returns {JQuery & { dock: Function, undock_to: Function }}
 */
function $LayerBox() {

	const $layers_container = $(E("div")).addClass("layers-list");
	const $fill_mode = $(E("div")).addClass("layers-fill-mode");

	// ── Fill mode toggle (sample all layers) ────────────────────────
	const $fill_toggle_label = $(E("label")).addClass("layers-fill-toggle");
	const $fill_checkbox = $(E("input")).attr("type", "checkbox").prop("checked", true);
	$fill_toggle_label.append($fill_checkbox, " Sample all layers");
	$fill_mode.append($fill_toggle_label);

	// expose the fill mode globally
	window.ks_fill_sample_all = true;
	$fill_checkbox.on("change", () => {
		window.ks_fill_sample_all = $fill_checkbox.prop("checked");
	});

	// ── Build the component ─────────────────────────────────────────
	const $component_content = $(E("div")).addClass("layers-content");
	$component_content.append($layers_container, $fill_mode);

	const $c = $Component(
		"Layers",
		"layers-component",
		"tall",
		$component_content,
	);

	$c.addClass("layers-box");

	// ── Render layer rows ───────────────────────────────────────────
	let dragSrcIdx = null;

	function render() {
		$layers_container.empty();

		// Render top-to-bottom (reversed from internal bottom-to-top order)
		const layersTopDown = [...layerManager.layers].reverse();

		layersTopDown.forEach((layer, visualIdx) => {
			const realIdx = layerManager.layers.length - 1 - visualIdx;

			const $row = $(E("div"))
				.addClass("layer-row")
				.toggleClass("active", layer === layerManager.activeLayer)
				.attr("draggable", "true")
				.attr("data-real-idx", String(realIdx));

			// ── Drag handle ─────────────────────────────────────────
			const $grip = $(E("span")).addClass("layer-grip").text("⠿");
			$row.append($grip);

			// ── Layer name ──────────────────────────────────────────
			const $name = $(E("span"))
				.addClass("layer-name")
				.text(layer.name);
			$row.append($name);

			// ── Bypass (visibility) button ───────────────────────────
			const $bypass = $(E("button"))
				.addClass("layer-btn layer-btn-bypass")
				.toggleClass("layer-btn-on", !layer.visible)
				.attr("title", layer.visible ? "Hide layer (Bypass)" : "Show layer")
				.text(layer.visible ? "👁" : "—");
			$bypass.on("click", (e) => {
				e.stopPropagation();
				layerManager.toggleVisibility(layer.id);
			});
			$row.append($bypass);

			// ── Solo button ─────────────────────────────────────────
			const $solo = $(E("button"))
				.addClass("layer-btn layer-btn-solo")
				.toggleClass("layer-btn-on", layer.solo)
				.attr("title", "Solo – show only this layer")
				.text("S");
			$solo.on("click", (e) => {
				e.stopPropagation();
				layerManager.toggleSolo(layer.id);
			});
			$row.append($solo);

			// ── Lock button ─────────────────────────────────────────
			const $lock = $(E("button"))
				.addClass("layer-btn layer-btn-lock")
				.toggleClass("layer-btn-on", layer.locked)
				.attr("title", layer.locked ? "Unlock layer" : "Lock layer")
				.text(layer.locked ? "🔒" : "🔓");
			$lock.on("click", (e) => {
				e.stopPropagation();
				layerManager.toggleLock(layer.id);
			});
			$row.append($lock);

			// ── Click to activate ───────────────────────────────────
			$row.on("click", () => {
				layerManager.setActive(layer.id);
			});

			// ── Drag & drop reorder ─────────────────────────────────
			$row[0].addEventListener("dragstart", (e) => {
				dragSrcIdx = realIdx;
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", String(realIdx));
				$row.addClass("dragging");
			});

			$row[0].addEventListener("dragend", () => {
				$row.removeClass("dragging");
				$layers_container.find(".layer-row").removeClass("drag-over");
			});

			$row[0].addEventListener("dragover", (e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				$layers_container.find(".layer-row").removeClass("drag-over");
				$row.addClass("drag-over");
			});

			$row[0].addEventListener("drop", (e) => {
				e.preventDefault();
				e.stopPropagation();
				$row.removeClass("drag-over");
				const targetRealIdx = realIdx;
				if (dragSrcIdx !== null && dragSrcIdx !== targetRealIdx) {
					layerManager.reorder(dragSrcIdx, targetRealIdx);
				}
				dragSrcIdx = null;
			});

			$layers_container.append($row);
		});
	}

	// Initial render + subscribe
	layerManager.onChange(render);

	// Re-render when layer system initializes
	$G.on("layers-init", render);

	return $c;
}

export { $LayerBox };
