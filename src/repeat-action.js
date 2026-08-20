// @ts-check

/** @type {(() => void) | null} */
let last_repeatable_action = null;

/**
 * Register an action that can be re-run with Repeat (F3 / Ctrl+Shift+R).
 * @param {() => void} action
 */
function set_repeatable_action(action) {
	last_repeatable_action = action;
}

/**
 * Re-run the last registered repeatable action, if any.
 * @returns {boolean} whether an action was repeated
 */
function repeat_last_action() {
	if (!last_repeatable_action) {
		return false;
	}
	last_repeatable_action();
	return true;
}

export { repeat_last_action, set_repeatable_action };
