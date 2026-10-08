import { assert, test } from "vitest";
import { player } from "../index.ts";
import { g } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";

const mulberry32 = (seed: number) => {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

test("generated skaters never cross the F/D/G line while developing", async () => {
	const origRandom = Math.random;
	Math.random = mulberry32(20261008);
	try {
		resetG();
		g.setWithoutSavingToDB("season", 2026);

		const players: any[] = [];
		for (let i = 0; i < 400; i++) {
			players.push(player.generate(0, 18, 2026, false, DEFAULT_LEVEL));
		}
		const startPos = players.map((p) => p.ratings.at(-1).pos as string);
		const numD = startPos.filter((pos) => pos === "D").length;
		assert.isAbove(
			numD / players.length,
			0.25,
			"generator should produce ~30% D",
		);

		for (const p of players) {
			await player.develop(p, 8, false, DEFAULT_LEVEL);
		}

		let cwSwaps = 0;
		for (const [i, p] of players.entries()) {
			const before = startPos[i]!;
			const after = p.ratings.at(-1).pos as string;
			if (before === "D" || before === "G") {
				assert.strictEqual(after, before, `${before} became ${after}`);
			} else {
				assert.notInclude(["D", "G"], after, `forward became ${after}`);
				if (after !== before) {
					cwSwaps++;
				}
			}
		}
		assert.isAbove(cwSwaps, 0, "C/W should still float");
	} finally {
		Math.random = origRandom;
	}
});
