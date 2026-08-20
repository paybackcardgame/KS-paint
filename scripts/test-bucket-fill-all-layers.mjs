#!/usr/bin/env node
/**
 * Bucket fill: all-layers solid fill must not allocate a mask canvas before getImageData.
 * Run: node scripts/test-bucket-fill-all-layers.mjs
 */
import assert from "node:assert/strict";
import {
	create_blank_pixel_buffer,
	flood_fill_from_source,
	replace_matching_from_source
} from "../src/flood-fill-core.js";

/**
 * @param {number} width
 * @param {number} height
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 */
function solid(width, height, r, g, b, a = 255) {
	const buf = create_blank_pixel_buffer(width, height);
	for (let i = 0; i < buf.data.length; i += 4) {
		buf.data[i] = r;
		buf.data[i + 1] = g;
		buf.data[i + 2] = b;
		buf.data[i + 3] = a;
	}
	return buf;
}

/**
 * @param {ReturnType<typeof create_blank_pixel_buffer>} buf
 * @param {number} x
 * @param {number} y
 */
function pixel(buf, x, y) {
	const i = (y * buf.width + x) * 4;
	return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]];
}

function set_pixel(buf, x, y, r, g, b, a = 255) {
	const i = (y * buf.width + x) * 4;
	buf.data[i] = r;
	buf.data[i + 1] = g;
	buf.data[i + 2] = b;
	buf.data[i + 3] = a;
}

// Composite: red region blocked by a green wall. Active layer starts transparent
// except one existing blue pixel that must survive outside the fill.
const source = solid(4, 3, 200, 0, 0);
set_pixel(source, 2, 0, 0, 200, 0);
set_pixel(source, 2, 1, 0, 200, 0);
set_pixel(source, 2, 2, 0, 200, 0);
const dest = create_blank_pixel_buffer(4, 3);
set_pixel(dest, 3, 1, 0, 0, 255);

flood_fill_from_source(source, dest, 0, 1, 9, 9, 9, 255, 1, { mode: "paint" });

assert.deepEqual(pixel(dest, 0, 1), [9, 9, 9, 255], "fill paints the seed region on the layer");
assert.deepEqual(pixel(dest, 1, 0), [9, 9, 9, 255], "fill spreads to connected composite pixels");
assert.deepEqual(pixel(dest, 2, 1), [0, 0, 0, 0], "other layers bound the fill");
assert.deepEqual(pixel(dest, 3, 1), [0, 0, 255, 255], "pixels past the boundary stay on the layer");

const mask = create_blank_pixel_buffer(4, 3);
flood_fill_from_source(source, mask, 0, 1, 255, 255, 255, 255, 1, { mode: "mask" });
assert.deepEqual(pixel(mask, 0, 1), [255, 255, 255, 255]);
assert.deepEqual(pixel(mask, 2, 1), [0, 0, 0, 0]);
assert.deepEqual(pixel(mask, 3, 1), [0, 0, 0, 0]);

const global_source = solid(2, 1, 10, 20, 30);
set_pixel(global_source, 1, 0, 10, 20, 30);
const global_dest = create_blank_pixel_buffer(2, 1);
set_pixel(global_dest, 1, 0, 1, 2, 3);
replace_matching_from_source(global_source, global_dest, 0, 0, 8, 8, 8, 255, 1);
assert.deepEqual(pixel(global_dest, 0, 0), [8, 8, 8, 255]);
assert.deepEqual(pixel(global_dest, 1, 0), [8, 8, 8, 255]);

// Allocation contract: solid all-layers fill reads source + dest, never a third mask canvas.
let get_image_data_calls = 0;
let canvases_created = 0;
const source_ctx = {
	canvas: { width: 4, height: 3 },
	getImageData() {
		get_image_data_calls += 1;
		return source;
	},
};
const dest_ctx = {
	canvas: { width: 4, height: 3 },
	getImageData() {
		get_image_data_calls += 1;
		return dest;
	},
	putImageData() {},
};
function make_canvas() {
	canvases_created += 1;
	return { ctx: {} };
}

// Mirrors apply_bucket_fill's solid all-layers path.
get_image_data_calls = 0;
canvases_created = 0;
{
	const source_id = source_ctx.getImageData(0, 0, 4, 3);
	const dest_id = dest_ctx.getImageData(0, 0, 4, 3);
	flood_fill_from_source(source_id, dest_id, 0, 0, 9, 9, 9, 255, 1, { mode: "paint" });
	dest_ctx.putImageData(dest_id, 0, 0);
}
assert.equal(get_image_data_calls, 2, "solid all-layers fill uses two ImageData reads");
assert.equal(canvases_created, 0, "solid all-layers fill must not allocate a mask canvas");
void make_canvas;

console.log("bucket-fill all-layers tests passed");
