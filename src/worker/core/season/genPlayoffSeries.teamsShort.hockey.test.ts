import { assert, beforeEach, test } from "vitest";
import { g, helpers } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { mockIDBLeague, resetCache, resetG } from "../../../test/helpers.ts";
import { team } from "../index.ts";
import genPlayoffSeries from "./genPlayoffSeries.ts";

// Regression for the cryptic "Cannot read properties of undefined (reading 'tid')"
// crash at playoff seeding: teams without a season row (like from a league file
// whose team "seasons" entries don't match startingSeason) are silently dropped
// by teamsPlus, so the bracket indexed past the end of the array.

const setup = async (numTeams: number, numTeamsWithSeasons = numTeams) => {
	resetG();
	idb.league = mockIDBLeague();
	const teamsDefault = helpers.getTeamsDefault().slice(0, numTeams);
	const teams = teamsDefault.map((t) => team.generate(t));
	g.setWithoutSavingToDB("numTeams", numTeams);
	g.setWithoutSavingToDB("numActiveTeams", numTeams);

	const withSeasons = teams.slice(0, numTeamsWithSeasons);
	await resetCache({
		teams,
		teamSeasons: withSeasons.map((t: any) => team.genSeasonRow(t)),
		teamStats: withSeasons.map((t: any) => team.genStatsRow(t.tid)),
	});
};

beforeEach(() => {
	resetG();
});

test("a full league seeds fine", async () => {
	await setup(32);
	const out = await genPlayoffSeries();
	assert.strictEqual(out.tidPlayoffs.length, 16);
});

test("teams missing season rows produce an actionable error, not an undefined crash", async () => {
	await setup(32, 8);
	try {
		await genPlayoffSeries();
		assert.fail("should have thrown");
	} catch (error) {
		assert.include((error as Error).message, "only 8 have data");
		assert.notInclude((error as Error).message, "undefined");
	}
});

test("a league that is genuinely too small still gets the settings error", async () => {
	await setup(4);
	try {
		await genPlayoffSeries();
		assert.fail("should have thrown");
	} catch (error) {
		assert.include((error as Error).message, "only 4 teams in the league");
	}
});
