import { assert, beforeEach, test } from "vitest";
import { g } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { player } from "../index.ts";
import getPayroll from "./getPayroll.ts";
import getContracts from "./getContracts.ts";
import { FARM_CAP_RELIEF } from "../../../common/constants.hockey.ts";

const genPlayer = (tid: number, amount: number, farm?: boolean) => {
	const p = player.generate(tid, 25, 2010, true, DEFAULT_LEVEL);
	p.contract.amount = amount;
	p.contract.exp = g.get("season") + 2;
	if (farm) {
		p.farm = true;
	}
	return p;
};

beforeEach(async () => {
	resetG();
	await resetCache({
		players: [
			genPlayer(0, 2000),
			genPlayer(0, 3000),
			genPlayer(0, g.get("minContract"), true), // fully buried
			genPlayer(0, 5000, true), // partially buried
		],
	});
});

test("cap view applies buried-contract relief to farm players", async () => {
	const payroll = await getPayroll(0);
	assert.strictEqual(payroll, 2000 + 3000 + 0 + (5000 - FARM_CAP_RELIEF));
});

test("cash view (noFarmRelief) counts full salaries", async () => {
	const payroll = await getPayroll(0, undefined, { noFarmRelief: true });
	assert.strictEqual(payroll, 2000 + 3000 + g.get("minContract") + 5000);
});

test("released players' dead money always counts in full", async () => {
	await idb.cache.releasedPlayers.add({
		pid: 999,
		tid: 0,
		contract: { amount: 4000, exp: g.get("season") + 1 },
	});

	const payroll = await getPayroll(0);
	assert.strictEqual(
		payroll,
		2000 + 3000 + 0 + (5000 - FARM_CAP_RELIEF) + 4000,
	);
});

test("ContractInfo overload matches the tid overload", async () => {
	const contracts = await getContracts(0);
	const fromContracts = await getPayroll(contracts);
	const fromTid = await getPayroll(0);
	assert.strictEqual(fromContracts, fromTid);
});

test("no relief when the farm system is disabled", async () => {
	g.setWithoutSavingToDB("farmSystem", false);
	const payroll = await getPayroll(0);
	assert.strictEqual(payroll, 2000 + 3000 + g.get("minContract") + 5000);
});
