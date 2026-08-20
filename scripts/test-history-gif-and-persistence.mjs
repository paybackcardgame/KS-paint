#!/usr/bin/env node
/**
 * Unit checks for history GIF memory planning and history serialization.
 * Run: node scripts/test-history-gif-and-persistence.mjs
 */
import assert from "node:assert/strict";
import {
	drop_every_other_indices,
	HISTORY_GIF_FRAME_DELAY_MS,
	is_out_of_memory_error,
	plan_history_gif,
	subsample_indices,
} from "../src/history-gif.js";
import {
	choose_nodes_to_persist,
	deserialize_document_history,
	estimate_history_bytes,
	serialize_document_history,
} from "../src/history-persistence.js";

function pixels(width, height, fill = 7) {
	const data = new Uint8ClampedArray(width * height * 4);
	data.fill(fill);
	return { width, height, data };
}

function make_history_node({
	parent = null,
	futures = [],
	timestamp = 1,
	soft = false,
	image_data = null,
	selection_image_data = null,
	selection_x,
	selection_y,
	name = "Test",
	foreground_color,
	background_color,
	ternary_color,
	text_tool_font = null,
	tool_transparent_mode = false,
} = {}) {
	return {
		parent,
		futures,
		timestamp,
		soft,
		image_data,
		selection_image_data,
		selection_x,
		selection_y,
		name,
		foreground_color,
		background_color,
		ternary_color,
		text_tool_font,
		tool_transparent_mode,
		icon: null,
	};
}

// --- GIF planning ---

assert.deepEqual(subsample_indices(0, 10), []);
assert.deepEqual(subsample_indices(5, 10), [0, 1, 2, 3, 4]);
assert.deepEqual(subsample_indices(5, 5), [0, 1, 2, 3, 4]);
assert.deepEqual(subsample_indices(100, 1), [99]);
const sampled = subsample_indices(100, 5);
assert.equal(sampled[0], 0);
assert.equal(sampled[sampled.length - 1], 99);
assert.ok(sampled.length <= 5);
assert.deepEqual(subsample_indices(10, 3), [0, 5, 9]);

assert.equal(HISTORY_GIF_FRAME_DELAY_MS, 250);
assert.deepEqual(drop_every_other_indices([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), [0, 2, 4, 6, 8, 9]);
assert.deepEqual(drop_every_other_indices([0, 2, 4, 6, 8, 9]), [0, 4, 8, 9]);
assert.deepEqual(drop_every_other_indices([0, 1]), [0, 1]);
assert.deepEqual(drop_every_other_indices([0]), [0]);

const small = plan_history_gif({
	frame_count: 10,
	width: 100,
	height: 50,
	max_copy_bytes: 64 * 1024 * 1024,
	max_dimension: 1280,
	max_frames: 400,
});
assert.equal(small.width, 100);
assert.equal(small.height, 50);
assert.equal(small.scaled, false);
assert.equal(small.subsampled, false);
assert.deepEqual(small.frame_indices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

const many = plan_history_gif({
	frame_count: 1000,
	width: 100,
	height: 100,
	max_copy_bytes: 64 * 1024 * 1024,
	max_dimension: 1280,
});
assert.equal(many.subsampled, false);
assert.equal(many.frame_indices.length, 1000);
assert.equal(many.frame_indices[0], 0);
assert.equal(many.frame_indices[many.frame_indices.length - 1], 999);
assert.equal(many.width, 100);
assert.equal(many.height, 100);

const tight = plan_history_gif({
	frame_count: 10,
	width: 100,
	height: 100,
	max_copy_bytes: 20 * 100 * 4,
	max_dimension: 1280,
});
assert.equal(tight.subsampled, false);
assert.deepEqual(tight.frame_indices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.equal(tight.scaled, true);
assert.ok(tight.width * tight.height * 4 * 10 <= 20 * 100 * 4);

const huge = plan_history_gif({
	frame_count: 200,
	width: 4000,
	height: 4000,
	max_copy_bytes: 64 * 1024 * 1024,
	max_dimension: 1280,
	max_frames: 400,
});
assert.equal(huge.scaled, true);
assert.ok(huge.width <= 1280);
assert.ok(huge.height <= 1280);
assert.ok(huge.width * huge.height * 4 * huge.frame_indices.length <= 64 * 1024 * 1024);

assert.equal(is_out_of_memory_error(new RangeError("Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Out of memory at ImageData creation")), true);
assert.equal(is_out_of_memory_error(new Error("boom")), false);
assert.equal(is_out_of_memory_error({ name: "RangeError", message: "Out of memory at ImageData creation" }), true);

// --- History serialize / deserialize ---

const root = make_history_node({
	name: "New",
	image_data: pixels(2, 2, 1),
	foreground_color: "#000000",
	background_color: "#ffffff",
});
const mid = make_history_node({
	parent: root,
	name: "Pencil",
	image_data: pixels(2, 2, 2),
	foreground_color: "#111111",
	selection_image_data: pixels(1, 1, 9),
	selection_x: 1,
	selection_y: 0,
});
const current = make_history_node({
	parent: mid,
	name: "Fill",
	image_data: pixels(2, 2, 3),
	foreground_color: "#222222",
});
root.futures.push(mid);
mid.futures.push(current);

const payload = serialize_document_history({
	root,
	current,
	undos: [root, mid],
	redos: [],
});
assert.equal(payload.version, 1);
assert.equal(payload.nodes.length, 3);
assert.equal(payload.undo_ids.length, 2);
assert.ok(payload.nodes[0].image.data.byteLength === 16);

const restored = deserialize_document_history(payload, make_history_node);
assert.ok(restored);
assert.equal(restored.undos.length, 2);
assert.equal(restored.current.name, "Fill");
assert.equal(restored.root.name, "New");
assert.equal(restored.current.parent.name, "Pencil");
assert.equal(restored.root.futures[0].name, "Pencil");
assert.deepEqual([...restored.current.image_data.data.slice(0, 4)], [3, 3, 3, 3]);
assert.equal(restored.undos[1].selection_x, 1);
assert.equal(restored.undos[1].selection_image_data.width, 1);

const branch = make_history_node({
	parent: root,
	name: "Other branch",
	image_data: pixels(2, 2, 8),
});
root.futures.push(branch);
const with_branch = serialize_document_history({
	root,
	current,
	undos: [root, mid],
	redos: [],
});
assert.equal(with_branch.nodes.length, 4);

const oversized_root = make_history_node({ name: "New", image_data: pixels(4, 4, 1) });
let prev = oversized_root;
const huge_undos = [oversized_root];
for (let i = 0; i < 5; i++) {
	const node = make_history_node({
		parent: prev,
		name: `Step ${i}`,
		image_data: pixels(4, 4, i + 2),
	});
	prev.futures.push(node);
	huge_undos.push(node);
	prev = node;
}
const tiny_budget = 4 * 4 * 4 * 3; // three 4x4 frames
const chosen = choose_nodes_to_persist(oversized_root, prev, huge_undos.slice(0, -1), [], tiny_budget);
assert.ok(estimate_history_bytes(chosen) <= tiny_budget);
assert.ok(chosen.includes(oversized_root));
assert.ok(chosen.includes(prev));
assert.ok(chosen.length < huge_undos.length);

console.log("history gif + persistence tests passed");
