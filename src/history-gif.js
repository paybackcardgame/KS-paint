// @ts-check

/** Extra ImageData copies gif.js keeps for every frame. */
const DEFAULT_MAX_COPY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 1280;
/** Kept for callers; frames are no longer dropped to meet this cap. */
const DEFAULT_MAX_FRAMES = Infinity;
/** Frame duration for Render History As GIF. GIF stores delay in 1/100s, so 25 = 250ms. */
const HISTORY_GIF_FRAME_DELAY_MS = 250;

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function is_out_of_memory_error(error) {
	if (!error) {
		return false;
	}
	const name = /** @type {{name?: string}} */ (error).name;
	const message = String(/** @type {{message?: string}} */ (error).message || error);
	return name === "RangeError" ||
		/out of memory/i.test(message) ||
		/allocation failed/i.test(message) ||
		/Maximum call stack/i.test(message);
}

/**
 * Keep the first and last frames, drop every other in-between frame.
 * @param {number[]} indices
 * @returns {number[]}
 */
function drop_every_other_indices(indices) {
	if (indices.length <= 2) {
		return indices.slice();
	}
	/** @type {number[]} */
	const kept = [];
	for (let i = 0; i < indices.length; i++) {
		if (i % 2 === 0) {
			kept.push(indices[i]);
		}
	}
	const last = indices[indices.length - 1];
	if (kept[kept.length - 1] !== last) {
		kept.push(last);
	}
	return kept;
}

/**
 * Evenly spaced indices that always include the first and last frame.
 * @param {number} length
 * @param {number} max_count
 * @returns {number[]}
 */
function subsample_indices(length, max_count) {
	const count = Math.max(0, length | 0);
	const cap = Math.max(0, max_count | 0);
	if (count <= 0 || cap <= 0) {
		return [];
	}
	if (count <= cap) {
		return Array.from({ length: count }, (_, i) => i);
	}
	if (cap === 1) {
		return [count - 1];
	}
	const indices = [];
	for (let i = 0; i < cap; i++) {
		indices.push(Math.round(i * (count - 1) / (cap - 1)));
	}
	return [...new Set(indices)];
}

/**
 * @typedef {object} HistoryGifPlan
 * @property {number} width
 * @property {number} height
 * @property {number[]} frame_indices
 * @property {boolean} scaled
 * @property {boolean} subsampled
 */

/**
 * @param {number} width
 * @param {number} height
 * @param {number} frame_count
 * @returns {number}
 */
function copy_bytes_for(width, height, frame_count) {
	return width * height * 4 * Math.max(1, frame_count);
}

/**
 * Pick GIF dimensions so gif.js copies stay within a memory budget.
 * Every history frame is kept; oversized exports shrink pixels instead of dropping frames.
 * @param {object} options
 * @param {number} options.frame_count
 * @param {number} options.width
 * @param {number} options.height
 * @param {number=} options.max_copy_bytes
 * @param {number=} options.max_dimension
 * @param {number=} options.max_frames unused; all frames are kept
 * @returns {HistoryGifPlan}
 */
function plan_history_gif({
	frame_count,
	width,
	height,
	max_copy_bytes = DEFAULT_MAX_COPY_BYTES,
	max_dimension = DEFAULT_MAX_DIMENSION,
}) {
	const source_width = Math.max(1, Math.round(Number(width) || 1));
	const source_height = Math.max(1, Math.round(Number(height) || 1));
	const count = Math.max(0, frame_count | 0);
	const frame_indices = Array.from({ length: count }, (_, i) => i);

	const dim_scale = Math.min(1, max_dimension / Math.max(source_width, source_height));
	let gif_width = Math.max(1, Math.round(source_width * dim_scale));
	let gif_height = Math.max(1, Math.round(source_height * dim_scale));

	let copy_bytes = copy_bytes_for(gif_width, gif_height, frame_indices.length);
	if (copy_bytes > max_copy_bytes) {
		const frame_n = Math.max(1, frame_indices.length);
		const scale = Math.sqrt(max_copy_bytes / copy_bytes);
		gif_width = Math.max(1, Math.floor(gif_width * scale));
		gif_height = Math.max(1, Math.floor(gif_height * scale));
		copy_bytes = copy_bytes_for(gif_width, gif_height, frame_n);
		while (copy_bytes > max_copy_bytes && (gif_width > 1 || gif_height > 1)) {
			if (gif_width >= gif_height && gif_width > 1) {
				gif_width -= 1;
			} else if (gif_height > 1) {
				gif_height -= 1;
			} else {
				break;
			}
			copy_bytes = copy_bytes_for(gif_width, gif_height, frame_n);
		}
	}

	return {
		width: gif_width,
		height: gif_height,
		frame_indices,
		scaled: gif_width !== source_width || gif_height !== source_height,
		subsampled: false,
	};
}

export {
	DEFAULT_MAX_COPY_BYTES,
	DEFAULT_MAX_DIMENSION,
	DEFAULT_MAX_FRAMES,
	HISTORY_GIF_FRAME_DELAY_MS,
	drop_every_other_indices,
	is_out_of_memory_error,
	plan_history_gif,
	subsample_indices
};
