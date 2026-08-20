// @ts-check

const HISTORY_DB_NAME = "jspaint-document-history";
const HISTORY_DB_VERSION = 1;
const HISTORY_STORE = "sessions";
const HISTORY_FORMAT_VERSION = 1;
/** Drop branches / old undos rather than failing the whole backup. */
const MAX_PERSIST_BYTES = 80 * 1024 * 1024;

/**
 * @param {Pick<ImageData, "width" | "height" | "data"> | null | undefined} image_data
 * @returns {number}
 */
function image_data_bytes(image_data) {
	return image_data?.data?.length || 0;
}

/**
 * @param {HistoryNode | null | undefined} node
 * @returns {number}
 */
function node_bytes(node) {
	if (!node) {
		return 0;
	}
	return image_data_bytes(node.image_data) + image_data_bytes(node.selection_image_data);
}

/**
 * @param {HistoryNode[]} nodes
 * @returns {number}
 */
function estimate_history_bytes(nodes) {
	return nodes.reduce((sum, node) => sum + node_bytes(node), 0);
}

/**
 * @param {HistoryNode | null | undefined} root
 * @returns {HistoryNode[]}
 */
function collect_tree_nodes(root) {
	/** @type {HistoryNode[]} */
	const nodes = [];
	const seen = new Set();
	/** @param {HistoryNode | null | undefined} node */
	const visit = (node) => {
		if (!node || seen.has(node)) {
			return;
		}
		seen.add(node);
		nodes.push(node);
		for (const future of node.futures || []) {
			visit(future);
		}
	};
	visit(root);
	return nodes;
}

/**
 * @param {string | CanvasPattern | undefined} color
 * @returns {string | null}
 */
function serializable_color(color) {
	return typeof color === "string" ? color : null;
}

/**
 * @param {Pick<ImageData, "width" | "height" | "data"> | null | undefined} image_data
 * @returns {{width: number, height: number, data: ArrayBuffer} | null}
 */
function pack_image_data(image_data) {
	if (!image_data?.data) {
		return null;
	}
	return {
		width: image_data.width,
		height: image_data.height,
		data: image_data.data.slice().buffer,
	};
}

/**
 * @param {{width: number, height: number, data: ArrayBuffer} | null | undefined} packed
 * @returns {ImageData | null}
 */
function unpack_image_data(packed) {
	if (!packed?.data) {
		return null;
	}
	const data = new Uint8ClampedArray(packed.data);
	if (typeof ImageData === "function") {
		return new ImageData(data, packed.width, packed.height);
	}
	return /** @type {ImageData} */ ({ width: packed.width, height: packed.height, data });
}

/**
 * @param {HistoryNode} node
 * @param {Set<HistoryNode>} included
 * @returns {HistoryNode | null}
 */
function nearest_included_parent(node, included) {
	let parent = node.parent;
	while (parent && !included.has(parent)) {
		parent = parent.parent;
	}
	return parent || null;
}

/**
 * Prefer the full history tree; if it's too large, keep the undo/redo path; if still too large, keep recent states.
 * @param {HistoryNode} root
 * @param {HistoryNode} current
 * @param {HistoryNode[]} undos
 * @param {HistoryNode[]} redos
 * @param {number} [max_bytes]
 * @returns {HistoryNode[]}
 */
function choose_nodes_to_persist(root, current, undos, redos, max_bytes = MAX_PERSIST_BYTES) {
	const tree = collect_tree_nodes(root);
	if (estimate_history_bytes(tree) <= max_bytes) {
		return tree;
	}

	/** @type {HistoryNode[]} */
	const linear = [];
	const add = (/** @type {HistoryNode | null | undefined} */ node) => {
		if (node && !linear.includes(node)) {
			linear.push(node);
		}
	};
	add(root);
	for (const node of undos) {
		add(node);
	}
	add(current);
	for (const node of redos) {
		add(node);
	}
	if (estimate_history_bytes(linear) <= max_bytes) {
		return linear;
	}

	/** @type {HistoryNode[]} */
	const recent = [];
	const add_recent = (/** @type {HistoryNode | null | undefined} */ node) => {
		if (node && !recent.includes(node)) {
			recent.push(node);
		}
	};
	add_recent(root);
	add_recent(current);
	for (const node of redos) {
		add_recent(node);
	}
	for (let i = undos.length - 1; i >= 0; i--) {
		const candidate = undos[i];
		if (estimate_history_bytes([...recent, candidate]) > max_bytes) {
			break;
		}
		add_recent(candidate);
	}
	return recent;
}

/**
 * @param {object} state
 * @param {HistoryNode} state.root
 * @param {HistoryNode} state.current
 * @param {HistoryNode[]} state.undos
 * @param {HistoryNode[]} state.redos
 */
function serialize_document_history({ root, current, undos, redos }, max_bytes = MAX_PERSIST_BYTES) {
	const nodes = choose_nodes_to_persist(root, current, undos, redos, max_bytes);
	const included = new Set(nodes);
	/** @type {Map<HistoryNode, number>} */
	const ids = new Map();
	nodes.forEach((node, index) => ids.set(node, index));

	return {
		version: HISTORY_FORMAT_VERSION,
		current_id: ids.get(current) ?? nodes.length - 1,
		undo_ids: undos.map((node) => ids.get(node)).filter((id) => id != null),
		redo_ids: redos.map((node) => ids.get(node)).filter((id) => id != null),
		nodes: nodes.map((node) => {
			const parent = nearest_included_parent(node, included);
			return {
				parent_id: parent ? ids.get(parent) : null,
				future_ids: (node.futures || []).map((future) => ids.get(future)).filter((id) => id != null),
				timestamp: node.timestamp,
				soft: !!node.soft,
				name: node.name,
				image: pack_image_data(node.image_data),
				selection: node.selection_image_data ? {
					x: node.selection_x,
					y: node.selection_y,
					image: pack_image_data(node.selection_image_data),
				} : null,
				textbox_text: node.textbox_text,
				textbox_x: node.textbox_x,
				textbox_y: node.textbox_y,
				textbox_width: node.textbox_width,
				textbox_height: node.textbox_height,
				text_tool_font: node.text_tool_font ? JSON.parse(JSON.stringify(node.text_tool_font)) : null,
				tool_transparent_mode: !!node.tool_transparent_mode,
				foreground_color: serializable_color(node.foreground_color),
				background_color: serializable_color(node.background_color),
				ternary_color: serializable_color(node.ternary_color),
				tool_sizes: node.tool_sizes ? { ...node.tool_sizes } : null,
			};
		}),
	};
}

/**
 * @param {any} payload
 * @param {(options: Partial<HistoryNode>) => HistoryNode} make_history_node
 */
function deserialize_document_history(payload, make_history_node) {
	if (!payload || payload.version !== HISTORY_FORMAT_VERSION || !Array.isArray(payload.nodes) || payload.nodes.length === 0) {
		return null;
	}

	const nodes = payload.nodes.map((record) => make_history_node({
		parent: null,
		futures: [],
		timestamp: record.timestamp,
		soft: !!record.soft,
		name: record.name || "Unknown",
		image_data: unpack_image_data(record.image),
		selection_image_data: unpack_image_data(record.selection?.image),
		selection_x: record.selection?.x,
		selection_y: record.selection?.y,
		textbox_text: record.textbox_text,
		textbox_x: record.textbox_x,
		textbox_y: record.textbox_y,
		textbox_width: record.textbox_width,
		textbox_height: record.textbox_height,
		text_tool_font: record.text_tool_font,
		tool_transparent_mode: !!record.tool_transparent_mode,
		// `null` for a color means it was a pattern, which can't be serialized; leave it unrecorded.
		foreground_color: record.foreground_color ?? undefined,
		background_color: record.background_color ?? undefined,
		ternary_color: record.ternary_color ?? undefined,
		tool_sizes: record.tool_sizes || undefined,
	}));

	payload.nodes.forEach((record, index) => {
		const node = nodes[index];
		if (record.parent_id != null && nodes[record.parent_id]) {
			node.parent = nodes[record.parent_id];
		}
		node.futures = (record.future_ids || [])
			.map((id) => nodes[id])
			.filter(Boolean);
	});

	const current = nodes[payload.current_id] || nodes[nodes.length - 1];
	const root = nodes.find((node) => !node.parent) || nodes[0];
	const undos = (payload.undo_ids || [])
		.map((id) => nodes[id])
		.filter(Boolean);
	const redos = (payload.redo_ids || [])
		.map((id) => nodes[id])
		.filter(Boolean);

	return { root, current, undos, redos };
}

/**
 * @returns {Promise<IDBDatabase | null>}
 */
function open_history_db() {
	if (typeof indexedDB === "undefined") {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(HISTORY_STORE)) {
					db.createObjectStore(HISTORY_STORE);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
		} catch (_error) {
			resolve(null);
		}
	});
}

/**
 * @param {string} session_id
 * @param {any} payload
 * @returns {Promise<void>}
 */
async function save_document_history(session_id, payload) {
	const db = await open_history_db();
	if (!db) {
		return;
	}
	try {
		await new Promise((resolve, reject) => {
			const tx = db.transaction(HISTORY_STORE, "readwrite");
			tx.oncomplete = () => resolve(undefined);
			tx.onerror = () => reject(tx.error);
			tx.objectStore(HISTORY_STORE).put(payload, session_id);
		});
	} finally {
		db.close();
	}
}

/**
 * @param {string} session_id
 * @returns {Promise<any | null>}
 */
async function load_document_history(session_id) {
	const db = await open_history_db();
	if (!db) {
		return null;
	}
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(HISTORY_STORE, "readonly");
			const request = tx.objectStore(HISTORY_STORE).get(session_id);
			request.onsuccess = () => resolve(request.result || null);
			request.onerror = () => reject(request.error);
		});
	} catch (_error) {
		return null;
	} finally {
		db.close();
	}
}

/**
 * @param {string} session_id
 * @returns {Promise<void>}
 */
async function delete_document_history(session_id) {
	const db = await open_history_db();
	if (!db) {
		return;
	}
	try {
		await new Promise((resolve, reject) => {
			const tx = db.transaction(HISTORY_STORE, "readwrite");
			tx.oncomplete = () => resolve(undefined);
			tx.onerror = () => reject(tx.error);
			tx.objectStore(HISTORY_STORE).delete(session_id);
		});
	} catch (_error) {
		// Ignore missing IndexedDB / already-deleted keys.
	} finally {
		db.close();
	}
}

export {
	HISTORY_FORMAT_VERSION,
	MAX_PERSIST_BYTES,
	choose_nodes_to_persist,
	collect_tree_nodes,
	delete_document_history,
	deserialize_document_history,
	estimate_history_bytes,
	load_document_history,
	pack_image_data,
	save_document_history,
	serialize_document_history,
	unpack_image_data
};
