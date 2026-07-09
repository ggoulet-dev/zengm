import { assert, beforeEach, describe, test } from "vitest";
import { g } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import { reserveTenderedRfaSalaries } from "./normalizeContractDemands.ts";

const SEASON = 2025;

const makeFreeAgent = ({
	age = 24,
	rfaTid,
}: {
	age?: number;
	rfaTid?: number;
}) =>
	({
		born: { year: SEASON - age },
		ratings: [{ pos: "C" }],
		stats: [],
		contract: { amount: 4000, exp: SEASON },
		value: 60,
		rfaTid,
	}) as any;

beforeEach(() => {
	resetG();
	g.setWithoutSavingToDB("season", SEASON);
});

describe("reserveTenderedRfaSalaries", () => {
	test("a tendered RFA's asking price counts against his rights team's payroll", () => {
		const teams = [
			{ tid: 0, payroll: 50000 },
			{ tid: 1, payroll: 50000 },
		];
		reserveTenderedRfaSalaries(teams, [
			{ contractAmount: 8000, p: makeFreeAgent({ rfaTid: 0 }) },
			{ contractAmount: 3000, p: makeFreeAgent({ rfaTid: 0 }) },
			{ contractAmount: 5000, p: makeFreeAgent({ rfaTid: 1 }) },
		]);

		assert.strictEqual(teams[0]!.payroll, 61000);
		assert.strictEqual(teams[1]!.payroll, 55000);
	});

	test("unrestricted free agents reserve nothing", () => {
		const teams = [{ tid: 0, payroll: 50000 }];
		reserveTenderedRfaSalaries(teams, [
			// Never tendered
			{ contractAmount: 8000, p: makeFreeAgent({}) },
			// Stale rights: aged out of RFA eligibility
			{ contractAmount: 8000, p: makeFreeAgent({ age: 28, rfaTid: 0 }) },
		]);

		assert.strictEqual(teams[0]!.payroll, 50000);
	});

	test("does nothing when the rfa setting is off", () => {
		g.setWithoutSavingToDB("rfa", false);

		const teams = [{ tid: 0, payroll: 50000 }];
		reserveTenderedRfaSalaries(teams, [
			{ contractAmount: 8000, p: makeFreeAgent({ rfaTid: 0 }) },
		]);

		assert.strictEqual(teams[0]!.payroll, 50000);
	});
});
