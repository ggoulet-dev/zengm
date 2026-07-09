import { assert, test } from "vitest";
import {
	FRENZY_BASELINE_FACTOR,
	FRENZY_PEAK_FACTOR,
	FRENZY_WINDOW_DAYS,
	getTradeFrenzyFactor,
} from "./frenzy.ts";

test("no deadline -> neutral 1x (no frenzy, no halving)", () => {
	assert.strictEqual(getTradeFrenzyFactor(undefined), 1);
});

test("far from deadline -> halved baseline", () => {
	assert.strictEqual(
		getTradeFrenzyFactor(FRENZY_WINDOW_DAYS),
		FRENZY_BASELINE_FACTOR,
	);
	assert.strictEqual(getTradeFrenzyFactor(50), FRENZY_BASELINE_FACTOR);
});

test("after deadline has passed -> halved baseline", () => {
	assert.strictEqual(getTradeFrenzyFactor(-1), FRENZY_BASELINE_FACTOR);
});

test("inside window -> monotonically increasing toward peak at day 0", () => {
	let prev = getTradeFrenzyFactor(FRENZY_WINDOW_DAYS - 1);
	assert.isAtLeast(prev, 1);

	for (
		let daysUntilDeadline = FRENZY_WINDOW_DAYS - 2;
		daysUntilDeadline >= 0;
		daysUntilDeadline--
	) {
		const factor = getTradeFrenzyFactor(daysUntilDeadline);
		assert.isAbove(factor, prev);
		prev = factor;
	}

	assert.strictEqual(getTradeFrenzyFactor(0), FRENZY_PEAK_FACTOR);
});
