import { assert, afterAll, beforeAll, test } from "vitest";
import { local } from "../../util/index.ts";
import genDepth from "./genDepth.hockey.ts";

// With exhibitionGamePlayers set, genDepth reads pos/ovrs straight off the player objects,
// which avoids needing a populated database
beforeAll(() => {
	local.exhibitionGamePlayers = {} as any;
});
afterAll(() => {
	local.exhibitionGamePlayers = undefined;
});

let pid = 0;
const makePlayer = (
	pos: "C" | "W" | "D" | "G",
	ovrs: { C?: number; W?: number; D?: number; G?: number },
) => {
	pid += 1;
	return {
		pid,
		ratings: [{ pos, ovrs: { C: 0, W: 0, D: 0, G: 0, ...ovrs } }],
	} as any;
};

const emptyDepth = () => ({ F: [], D: [], G: [] });

const pids = (players: { pid: number }[]) => players.map((p) => p.pid);

// 4 C, 8 W, 5 D, 2 G - a full roster except one D slot, so an elite D fits at pairing 1
const genRoster = () => ({
	centers: [73, 72, 71, 70].map((ovr) =>
		makePlayer("C", { C: ovr, W: ovr - 5 }),
	),
	wings: [67, 66, 65, 64, 63, 62, 61, 60].map((ovr) =>
		makePlayer("W", { C: ovr - 10, W: ovr }),
	),
	defensemen: [64, 63, 62, 61, 60].map((ovr) =>
		makePlayer("D", { C: ovr - 10, W: ovr - 10, D: ovr }),
	),
	goalies: [70, 65].map((ovr) => makePlayer("G", { G: ovr })),
});

test("an elite defenseman is not selected at center, even if his C ovr beats every natural center", async () => {
	const { centers, wings, defensemen, goalies } = genRoster();

	// C score of 96 beats the best natural center's 73 + 15 natural position bonus, so before
	// restricting selection to natural position groups this player became the first line center
	const eliteD = makePlayer("D", { C: 96, W: 96, D: 99 });

	const players = [...centers, ...wings, eliteD, ...defensemen, ...goalies];
	const depth = await genDepth(players, emptyDepth());

	assert.strictEqual(depth.D[0], eliteD.pid);
	assert.notInclude(depth.F.slice(0, 12), eliteD.pid);

	// Lines are stored C/W/W, so the centers are at 0/3/6/9
	assert.sameMembers(
		[depth.F[0], depth.F[3], depth.F[6], depth.F[9]],
		pids(centers),
	);
});

test("forward slots left open by a short roster are filled by out-of-position players", async () => {
	// Only 10 natural forwards for 12 forward slots
	const centers = [72, 71, 70].map((ovr) =>
		makePlayer("C", { C: ovr, W: ovr - 5 }),
	);
	const wings = [66, 65, 64, 63, 62, 61, 60].map((ovr) =>
		makePlayer("W", { C: ovr - 10, W: ovr }),
	);
	const defensemen = [85, 84, 83, 82, 81, 80].map((ovr) =>
		makePlayer("D", { C: 40, W: 40, D: ovr }),
	);
	// The spares' W-score order is the reverse of their C-score order, so these assertions fail
	// if the open wing slots are filled by anything other than remaining W score (like the C-score
	// ordering the leftovers tail uses)
	const spareA = makePlayer("D", { C: 30, W: 50, D: 52 });
	const spareB = makePlayer("D", { C: 50, W: 30, D: 51 });
	const goalies = [70, 65].map((ovr) => makePlayer("G", { G: ovr }));

	const players = [
		...centers,
		...wings,
		...defensemen,
		spareA,
		spareB,
		...goalies,
	];
	const depth = await genDepth(players, emptyDepth());

	// The top 6 defensemen keep the D pairings...
	assert.sameMembers(depth.D.slice(0, 6), pids(defensemen));

	// ...and the spare defensemen fill the line 4 wing slots, best W score first
	assert.strictEqual(depth.F[10], spareA.pid);
	assert.strictEqual(depth.F[11], spareB.pid);
});

test("onlyNewPlayers does not insert a new defenseman into the starting forward lines", async () => {
	const { centers, wings, defensemen, goalies } = genRoster();
	const players = [...centers, ...wings, ...defensemen, ...goalies];
	const initialDepth = await genDepth(players, emptyDepth());

	const eliteD = makePlayer("D", { C: 96, W: 96, D: 99 });
	const depth = await genDepth([...players, eliteD], initialDepth, true);

	// Starts on the top defensive pairing, but in the forwards list he can only be a scratch
	assert.strictEqual(depth.D[0], eliteD.pid);
	assert.isAtLeast(depth.F.indexOf(eliteD.pid), 12);
});

test("onlyNewPlayers does not insert a new forward into the D pairings or the goalie slot", async () => {
	const { centers, wings, defensemen, goalies } = genRoster();
	const players = [...centers, ...wings, ...defensemen, ...goalies];
	const initialDepth = await genDepth(players, emptyDepth());

	// D score of 90 beats the top pairing's 64 + 15 and G score of 90 beats the starter's 70 + 15,
	// so without the out-of-group cutoff he would be inserted as a starter in both lists
	const newW = makePlayer("W", { C: 80, W: 90, D: 90, G: 90 });
	const depth = await genDepth([...players, newW], initialDepth, true);

	assert.include(depth.F.slice(0, 12), newW.pid);
	assert.isAtLeast(depth.D.indexOf(newW.pid), 6);
	assert.strictEqual(depth.G[0], goalies[0].pid);
});

test("onlyNewPlayers still inserts a new better center at the top of the lines", async () => {
	const { centers, wings, defensemen, goalies } = genRoster();
	const players = [...centers, ...wings, ...defensemen, ...goalies];
	const initialDepth = await genDepth(players, emptyDepth());

	const newC = makePlayer("C", { C: 90, W: 85 });
	const depth = await genDepth([...players, newC], initialDepth, true);

	assert.strictEqual(depth.F[0], newC.pid);
});
