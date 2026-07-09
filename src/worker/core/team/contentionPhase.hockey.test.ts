import { assert, test } from "vitest";
import {
	classifyContentionPhase,
	getPhaseAssetMultiplier,
	getPhaseContractsFactor,
} from "./contentionPhase.ts";

test("bad old team tears down", () => {
	assert.strictEqual(
		classifyContentionPhase({
			strengthPct: 0.1,
			coreAge: 29,
			pipeline: 2,
			dWon: 0,
		}),
		"teardown",
	);
});

test("bad young team with a pipeline accumulates", () => {
	assert.strictEqual(
		classifyContentionPhase({
			strengthPct: 0.2,
			coreAge: 24,
			pipeline: 4,
			dWon: 0,
		}),
		"accumulation",
	);
});

test("bad young team with no pipeline tears down to build one", () => {
	assert.strictEqual(
		classifyContentionPhase({
			strengthPct: 0.2,
			coreAge: 24,
			pipeline: 0,
			dWon: 0,
		}),
		"teardown",
	);
});

test("mid team with a young core emerges", () => {
	assert.strictEqual(
		classifyContentionPhase({
			strengthPct: 0.5,
			coreAge: 25,
			pipeline: 3,
			dWon: 0,
		}),
		"emergence",
	);
});

test("mid team with an old core tears down", () => {
	assert.strictEqual(
		classifyContentionPhase({
			strengthPct: 0.5,
			coreAge: 29.5,
			pipeline: 1,
			dWon: 0,
		}),
		"teardown",
	);
});

test("strong young team pushes", () => {
	assert.strictEqual(
		classifyContentionPhase({
			strengthPct: 0.8,
			coreAge: 25,
			pipeline: 3,
			dWon: 0,
		}),
		"push",
	);
});

test("strong old team goes all-in", () => {
	assert.strictEqual(
		classifyContentionPhase({
			strengthPct: 0.8,
			coreAge: 29,
			pipeline: 1,
			dWon: 0,
		}),
		"winNow",
	);
});

test("a surge in wins shifts a borderline team toward buying", () => {
	const base = {
		strengthPct: 0.6,
		coreAge: 29,
		pipeline: 1,
	};
	assert.strictEqual(classifyContentionPhase({ ...base, dWon: 0 }), "teardown");
	assert.strictEqual(classifyContentionPhase({ ...base, dWon: 20 }), "winNow");
});

test("sellers value picks and youth, buyers value the present", () => {
	const pick = { age: 20, treatAsFutureDraftPick: true };
	const vet30 = { age: 30, treatAsFutureDraftPick: false };
	const kid21 = { age: 21, treatAsFutureDraftPick: false };

	assert.isAbove(
		getPhaseAssetMultiplier("teardown", pick),
		getPhaseAssetMultiplier("winNow", pick),
	);
	assert.isAbove(
		getPhaseAssetMultiplier("winNow", vet30),
		getPhaseAssetMultiplier("teardown", vet30),
	);
	assert.isAbove(
		getPhaseAssetMultiplier("teardown", kid21),
		getPhaseAssetMultiplier("winNow", kid21),
	);

	// Every age has a defined multiplier in every phase
	for (const phase of [
		"teardown",
		"accumulation",
		"emergence",
		"push",
		"winNow",
	] as const) {
		for (let age = 17; age <= 45; age++) {
			const m = getPhaseAssetMultiplier(phase, {
				age,
				treatAsFutureDraftPick: false,
			});
			assert.isAbove(m, 0.5);
			assert.isBelow(m, 1.5);
		}
	}
});

test("contract surplus matters more to rebuilders than contenders", () => {
	assert.isAbove(
		getPhaseContractsFactor("teardown"),
		getPhaseContractsFactor("emergence"),
	);
	assert.isAbove(
		getPhaseContractsFactor("emergence"),
		getPhaseContractsFactor("winNow"),
	);
});
