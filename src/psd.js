// @ts-check
/* global agPsd, layers, main_canvas */

import { make_canvas } from "./helpers.js";

const PSD_MIME_TYPE = "image/vnd.adobe.photoshop";

function layer_to_psd_child(layer) {
	return {
		name: layer.name,
		canvas: layer.canvas,
		hidden: !layer.visible,
		opacity: layer.opacity,
		blendMode: "normal",
		left: 0,
		top: 0,
		right: layer.canvas.width,
		bottom: layer.canvas.height,
	};
}

function write_psd_blob() {
	// ag-psd children[0] is the bottom layer, matching `layers`.
	const children = layers.map(layer_to_psd_child);
	const buffer = agPsd.writePsd({
		width: main_canvas.width,
		height: main_canvas.height,
		canvas: main_canvas,
		children,
	}, { noBackground: true });
	return new Blob([buffer], { type: PSD_MIME_TYPE });
}

/**
 * @param {any[]} children
 * @param {any[]} output
 * @param {{skipped_groups: number, skipped_unsupported: number}} stats
 */
function collect_raster_layers(children, output, stats) {
	for (const child of children || []) {
		if (child.children?.length) {
			stats.skipped_groups += 1;
			collect_raster_layers(child.children, output, stats);
			continue;
		}
		if (child.canvas || child.imageData) {
			output.push(child);
			continue;
		}
		stats.skipped_unsupported += 1;
	}
}

/**
 * @param {Blob} blob
 */
async function read_psd_document(blob) {
	const psd = agPsd.readPsd(await blob.arrayBuffer(), {
		skipThumbnail: true,
	});
	const stats = { skipped_groups: 0, skipped_unsupported: 0 };
	const psd_layers = [];
	collect_raster_layers(psd.children, psd_layers, stats);
	const decoded_layers = psd_layers.map((layer, index) => {
		const source = layer.canvas || layer.imageData;
		const canvas = make_canvas(psd.width, psd.height);
		const left = layer.left || 0;
		const top = layer.top || 0;
		if (source instanceof ImageData) {
			canvas.ctx.putImageData(source, left, top);
		} else {
			canvas.ctx.drawImage(source, left, top);
		}
		return {
			name: layer.name || `Layer ${index + 1}`,
			canvas,
			visible: !layer.hidden,
			opacity: layer.opacity ?? 1,
		};
	});
	if (!decoded_layers.length && psd.canvas) {
		decoded_layers.push({
			name: "Background",
			canvas: make_canvas(psd.canvas),
			visible: true,
			opacity: 1,
		});
	}
	if (!decoded_layers.length) {
		throw new Error("The PSD contains no raster image data that JS Paint can edit.");
	}
	const notices = [];
	if (stats.skipped_groups > 0) {
		notices.push(`${stats.skipped_groups} layer group${stats.skipped_groups === 1 ? " was" : "s were"} flattened into contained raster layers.`);
	}
	if (stats.skipped_unsupported > 0) {
		notices.push(`${stats.skipped_unsupported} unsupported layer${stats.skipped_unsupported === 1 ? "" : "s"} (masks, adjustments, smart objects, or text-only) ${stats.skipped_unsupported === 1 ? "was" : "were"} skipped.`);
	}
	return {
		width: psd.width,
		height: psd.height,
		layers: decoded_layers,
		notice: notices.length ? notices.join(" ") : null,
	};
}

/**
 * @param {Blob} blob
 */
async function is_psd_blob(blob) {
	if (blob instanceof File && /\.psd$/i.test(blob.name)) {
		return true;
	}
	const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return signature.length === 4 &&
		signature[0] === 0x38 && signature[1] === 0x42 &&
		signature[2] === 0x50 && signature[3] === 0x53;
}

export { PSD_MIME_TYPE, is_psd_blob, read_psd_document, write_psd_blob };
