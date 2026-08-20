// @ts-check

/**
 * @typedef {{ width: number, height: number, data: Uint8ClampedArray }} PixelBuffer
 */

/**
 * Blank ImageData-shaped buffer. Prefer this over getImageData on an empty canvas:
 * getImageData also copies GPU pixels and can OOM after a full-size mask canvas.
 * @param {number} width
 * @param {number} height
 * @returns {PixelBuffer}
 */
function create_blank_pixel_buffer(width, height) {
	return {
		width,
		height,
		data: new Uint8ClampedArray(width * height * 4),
	};
}

/**
 * @param {Uint8ClampedArray} data
 * @param {number} pixel_pos
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 * @param {number} threshold
 */
function colors_match(data, pixel_pos, r, g, b, a, threshold) {
	return (
		Math.abs(data[pixel_pos + 0] - r) <= threshold &&
		Math.abs(data[pixel_pos + 1] - g) <= threshold &&
		Math.abs(data[pixel_pos + 2] - b) <= threshold &&
		Math.abs(data[pixel_pos + 3] - a) <= threshold
	);
}

/**
 * Flood-fill from source into dest.
 *
 * `mask`: dest starts empty; dest alpha 0 means unvisited (used for pattern stamps).
 * `paint`: dest is existing layer pixels; a compact visited buffer tracks the region
 * so other layers can bound the fill without allocating a third full-size canvas.
 *
 * @param {PixelBuffer} source_id
 * @param {PixelBuffer} dest_id
 * @param {number} start_x
 * @param {number} start_y
 * @param {number} fill_r
 * @param {number} fill_g
 * @param {number} fill_b
 * @param {number} fill_a
 * @param {number} fill_threshold
 * @param {{ mode: "mask" | "paint" }} [options]
 */
function flood_fill_from_source(source_id, dest_id, start_x, start_y, fill_r, fill_g, fill_b, fill_a, fill_threshold, options = { mode: "mask" }) {
	const c_width = source_id.width;
	const c_height = source_id.height;
	if (c_width < 1 || c_height < 1) {
		return;
	}
	if (fill_a === 0 && options.mode === "mask") {
		throw new Error("Filling with alpha of zero is not supported. Zero alpha is used for detecting whether a pixel has been visited.");
	}
	start_x = Math.max(0, Math.min(Math.floor(start_x), c_width - 1));
	start_y = Math.max(0, Math.min(Math.floor(start_y), c_height - 1));
	const stack = [[start_x, start_y]];
	const source_data = source_id.data;
	const dest_data = dest_id.data;
	const paint = options.mode === "paint";
	const visited = new Uint8Array(paint ? c_width * c_height : 0);
	let pixel_pos = (start_y * c_width + start_x) * 4;
	const start_r = source_data[pixel_pos + 0];
	const start_g = source_data[pixel_pos + 1];
	const start_b = source_data[pixel_pos + 2];
	const start_a = source_data[pixel_pos + 3];

	const should_fill_at = (pos) => {
		if (pos < 0 || pos >= source_data.length) {
			return false;
		}
		const pixel_index = pos / 4;
		if (paint) {
			if (visited[pixel_index]) {
				return false;
			}
		} else if (dest_data[pos + 3] !== 0) {
			return false;
		}
		return colors_match(source_data, pos, start_r, start_g, start_b, start_a, fill_threshold);
	};

	const do_fill_at = (pos) => {
		if (paint) {
			visited[pos / 4] = 1;
		}
		dest_data[pos + 0] = fill_r;
		dest_data[pos + 1] = fill_g;
		dest_data[pos + 2] = fill_b;
		dest_data[pos + 3] = fill_a;
	};

	while (stack.length) {
		const new_pos = stack.pop();
		let x = new_pos[0];
		let y = new_pos[1];

		pixel_pos = (y * c_width + x) * 4;
		while (should_fill_at(pixel_pos)) {
			y--;
			pixel_pos = (y * c_width + x) * 4;
		}
		let reach_left = false;
		let reach_right = false;

		while (true) {
			y++;
			pixel_pos = (y * c_width + x) * 4;

			if (!(y < c_height && should_fill_at(pixel_pos))) {
				break;
			}

			do_fill_at(pixel_pos);

			if (x > 0) {
				if (should_fill_at(pixel_pos - 4)) {
					if (!reach_left) {
						stack.push([x - 1, y]);
						reach_left = true;
					}
				} else if (reach_left) {
					reach_left = false;
				}
			}

			if (x < c_width - 1) {
				if (should_fill_at(pixel_pos + 4)) {
					if (!reach_right) {
						stack.push([x + 1, y]);
						reach_right = true;
					}
				} else if (reach_right) {
					reach_right = false;
				}
			}
		}
	}
}

/**
 * Paint dest pixels whose corresponding source pixels match the seed color.
 * @param {PixelBuffer} source_id
 * @param {PixelBuffer} dest_id
 * @param {number} x
 * @param {number} y
 * @param {number} fill_r
 * @param {number} fill_g
 * @param {number} fill_b
 * @param {number} fill_a
 * @param {number} fill_threshold
 */
function replace_matching_from_source(source_id, dest_id, x, y, fill_r, fill_g, fill_b, fill_a, fill_threshold) {
	const c_width = source_id.width;
	const c_height = source_id.height;
	if (c_width < 1 || c_height < 1) {
		return;
	}
	x = Math.max(0, Math.min(Math.floor(x), c_width - 1));
	y = Math.max(0, Math.min(Math.floor(y), c_height - 1));
	const start_index = (y * c_width + x) * 4;
	const start_r = source_id.data[start_index + 0];
	const start_g = source_id.data[start_index + 1];
	const start_b = source_id.data[start_index + 2];
	const start_a = source_id.data[start_index + 3];
	const source_data = source_id.data;
	const dest_data = dest_id.data;
	for (let i = 0; i < source_data.length; i += 4) {
		if (colors_match(source_data, i, start_r, start_g, start_b, start_a, fill_threshold)) {
			dest_data[i + 0] = fill_r;
			dest_data[i + 1] = fill_g;
			dest_data[i + 2] = fill_b;
			dest_data[i + 3] = fill_a;
		}
	}
}

export {
	create_blank_pixel_buffer,
	flood_fill_from_source,
	replace_matching_from_source
};
