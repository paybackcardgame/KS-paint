#!/usr/bin/env node
/**
 * Round-trip checks for layered PSD I/O + dirty-layer undo snapshot reuse.
 * Run: node scripts/test-layers-psd-roundtrip.js
 */
const assert = require("assert");
const { writePsd, readPsd, initializeCanvas } = require("ag-psd");

class FakeImageData {
	constructor(dataOrW, wOrH, h) {
		if (typeof dataOrW === "number") {
			this.width = dataOrW;
			this.height = wOrH;
			this.data = new Uint8ClampedArray(this.width * this.height * 4);
		} else {
			this.data = dataOrW;
			this.width = wOrH;
			this.height = h;
		}
	}
}

function createCanvas(width, height) {
	const data = new Uint8ClampedArray(width * height * 4);
	return {
		width,
		height,
		getContext() {
			return {
				createImageData(w, h) {
					return new FakeImageData(w, h);
				},
				getImageData() {
					return new FakeImageData(data, width, height);
				},
				putImageData(img, x, y) {
					for (let row = 0; row < img.height; row++) {
						for (let col = 0; col < img.width; col++) {
							const dx = x + col;
							const dy = y + row;
							if (dx < 0 || dy < 0 || dx >= width || dy >= height) {
								continue;
							}
							const si = (row * img.width + col) * 4;
							const di = (dy * width + dx) * 4;
							data[di] = img.data[si];
							data[di + 1] = img.data[si + 1];
							data[di + 2] = img.data[si + 2];
							data[di + 3] = img.data[si + 3];
						}
					}
				},
				drawImage() { /* unused in this harness */ },
			};
		},
	};
}

initializeCanvas(createCanvas, (w, h) => new FakeImageData(w, h));

function fill(w, h, r, g, b, a = 255) {
	const img = new FakeImageData(w, h);
	for (let i = 0; i < img.data.length; i += 4) {
		img.data[i] = r;
		img.data[i + 1] = g;
		img.data[i + 2] = b;
		img.data[i + 3] = a;
	}
	return img;
}

function sample(img) {
	return [...img.data.slice(0, 4)];
}

function composite_flat(layers, width, height) {
	const out = new FakeImageData(width, height);
	for (const layer of layers) {
		if (layer.hidden || (layer.opacity ?? 1) <= 0) {
			continue;
		}
		const alphaScale = layer.opacity ?? 1;
		const src = layer.imageData;
		for (let i = 0; i < out.data.length; i += 4) {
			const sa = (src.data[i + 3] / 255) * alphaScale;
			if (sa <= 0) {
				continue;
			}
			const da = out.data[i + 3] / 255;
			const outA = sa + da * (1 - sa);
			for (let c = 0; c < 3; c++) {
				const s = src.data[i + c];
				const d = out.data[i + c];
				out.data[i + c] = outA === 0 ? 0 : Math.round((s * sa + d * da * (1 - sa)) / outA);
			}
			out.data[i + 3] = Math.round(outA * 255);
		}
	}
	return out;
}

function snapshot_layers(layers, dirty_ids, previous_snapshots = null) {
	const previous_by_id = new Map((previous_snapshots || []).map((snapshot) => [snapshot.id, snapshot]));
	const dirty = new Set(dirty_ids);
	return layers.map((layer) => {
		const previous = previous_by_id.get(layer.id);
		const can_reuse = previous &&
			!dirty.has(layer.id) &&
			previous.image_data &&
			previous.image_data.width === layer.image_data.width &&
			previous.image_data.height === layer.image_data.height;
		return {
			id: layer.id,
			name: layer.name,
			visible: !layer.hidden,
			opacity: layer.opacity ?? 1,
			image_data: can_reuse ? previous.image_data : new FakeImageData(new Uint8ClampedArray(layer.image_data.data), layer.image_data.width, layer.image_data.height),
			_reused: !!can_reuse,
		};
	});
}

function test_psd_roundtrip() {
	const width = 24;
	const height = 16;
	const background = fill(width, height, 255, 0, 0);
	const overlay = fill(width, height, 0, 0, 255, 180);
	const flat = composite_flat([
		{ imageData: background, opacity: 1 },
		{ imageData: overlay, opacity: 0.5 },
	], width, height);

	const buffer = writePsd({
		width,
		height,
		imageData: flat,
		children: [
			{ name: "Background", imageData: background, left: 0, top: 0, right: width, bottom: height },
			{ name: "Overlay", imageData: overlay, opacity: 0.5, hidden: false, left: 0, top: 0, right: width, bottom: height },
		],
	});

	assert.ok(buffer.byteLength > 100, "PSD buffer should be non-trivial");
	const signature = new Uint8Array(buffer.slice(0, 4));
	assert.deepStrictEqual([...signature], [0x38, 0x42, 0x50, 0x53], "PSD signature 8BPS");

	const loaded = readPsd(buffer, { useImageData: true, skipThumbnail: true });
	assert.strictEqual(loaded.width, width);
	assert.strictEqual(loaded.height, height);
	assert.strictEqual(loaded.children.length, 2);
	assert.strictEqual(loaded.children[0].name, "Background");
	assert.strictEqual(loaded.children[1].name, "Overlay");
	assert.ok(Math.abs((loaded.children[1].opacity ?? 1) - 0.5) < 0.02, `opacity should round-trip near 0.5, got ${loaded.children[1].opacity}`);
	assert.deepStrictEqual(sample(loaded.children[0].imageData), [255, 0, 0, 255]);
	assert.deepStrictEqual(sample(loaded.children[1].imageData), [0, 0, 255, 180]);

	// Export PNG equivalent: composite must match stored composite sample.
	const recomposite = composite_flat(loaded.children.map((layer) => ({
		imageData: layer.imageData,
		opacity: layer.opacity ?? 1,
		hidden: layer.hidden,
	})), width, height);
	assert.deepStrictEqual(sample(recomposite), sample(flat), "flattened composite should match export PNG pixels");
	console.log("PASS psd write→read layers + flat composite");
}

function decode_layers_like_jspaint(psd) {
	// Mirrors src/psd.js: ag-psd children[0] is the bottom layer, same as JS Paint `layers`.
	return (psd.children || []).map((layer, index) => ({
		name: layer.name || `Layer ${index + 1}`,
		hidden: !!layer.hidden,
		opacity: layer.opacity ?? 1,
	}));
}

function write_layers_like_jspaint(stack, width, height, flat) {
	return writePsd({
		width,
		height,
		imageData: flat,
		children: stack.map((layer) => ({
			name: layer.name,
			imageData: layer.imageData,
			hidden: !!layer.hidden,
			opacity: layer.opacity ?? 1,
			left: 0,
			top: 0,
			right: width,
			bottom: height,
		})),
	}, { noBackground: true });
}

function test_psd_preserves_reordered_layers() {
	const width = 8;
	const height = 8;
	const red = fill(width, height, 255, 0, 0);
	const green = fill(width, height, 0, 255, 0);
	const blue = fill(width, height, 0, 0, 255);
	// JS Paint stack is bottom → top. After a reorder, Background is no longer on the bottom.
	const reordered = [
		{ name: "Layer 1", imageData: green },
		{ name: "Background", imageData: red },
		{ name: "Layer 2", imageData: blue },
	];
	const flat = composite_flat(reordered, width, height);
	const buffer = write_layers_like_jspaint(reordered, width, height, flat);
	const loaded = readPsd(buffer, { useImageData: true, skipThumbnail: true });
	assert.deepStrictEqual(
		decode_layers_like_jspaint(loaded).map((layer) => layer.name),
		["Layer 1", "Background", "Layer 2"],
		"PSD export must keep the current bottom-to-top layer order"
	);
	assert.strictEqual(loaded.children[0].name, "Layer 1");
	assert.strictEqual(loaded.children[loaded.children.length - 1].name, "Layer 2");
	console.log("PASS psd export preserves reordered layer stack");
}

function test_dirty_layer_snapshots() {
	const a = { id: "a", name: "A", hidden: false, opacity: 1, image_data: fill(4, 4, 10, 20, 30) };
	const b = { id: "b", name: "B", hidden: false, opacity: 0.75, image_data: fill(4, 4, 40, 50, 60) };
	const snap1 = snapshot_layers([a, b], ["a", "b"]);
	assert.strictEqual(snap1[0]._reused, false);
	assert.strictEqual(snap1[1]._reused, false);

	// Only layer B painted → A should reuse prior ImageData reference.
	b.image_data = fill(4, 4, 1, 2, 3);
	const snap2 = snapshot_layers([a, b], ["b"], snap1);
	assert.strictEqual(snap2[0]._reused, true);
	assert.strictEqual(snap2[0].image_data, snap1[0].image_data);
	assert.strictEqual(snap2[1]._reused, false);
	assert.deepStrictEqual(sample(snap2[1].image_data), [1, 2, 3, 255]);
	console.log("PASS dirty-layer undo snapshot reuse");
}

function test_skip_stats_logic() {
	const stats = { skipped_groups: 0, skipped_unsupported: 0 };
	const output = [];
	function collect(children) {
		for (const child of children || []) {
			if (child.children?.length) {
				stats.skipped_groups += 1;
				collect(child.children);
				continue;
			}
			if (child.canvas || child.imageData) {
				output.push(child);
				continue;
			}
			stats.skipped_unsupported += 1;
		}
	}
	collect([
		{ name: "Group", children: [{ name: "Nested", imageData: fill(2, 2, 1, 1, 1) }] },
		{ name: "Adjustment" },
		{ name: "Raster", imageData: fill(2, 2, 2, 2, 2) },
	]);
	assert.strictEqual(stats.skipped_groups, 1);
	assert.strictEqual(stats.skipped_unsupported, 1);
	assert.strictEqual(output.length, 2);
	console.log("PASS PSD skip notice stats");
}

try {
	test_psd_roundtrip();
	test_psd_preserves_reordered_layers();
	test_dirty_layer_snapshots();
	test_skip_stats_logic();
	console.log("All layer/PSD ship checks passed.");
} catch (error) {
	console.error("FAIL", error);
	process.exit(1);
}
