import fs from "node:fs/promises";
import { makeSpinners } from "./spinners.ts";
import { watchCss } from "./watchCss.ts";
import { watchFiles } from "./watchFiles.ts";
import { watchJs } from "./watchJs.ts";
import { watchJsonSchema } from "./watchJsonSchema.ts";
import { startServer } from "../lib/server.ts";
import { createLiveReload } from "../lib/liveReload.ts";
import { reset } from "../build/reset.ts";
import { parseCliParams } from "../lib/parseCliParams.ts";
import { getSport } from "../lib/getSport.ts";

const { exposeToNetwork } = parseCliParams();

const initialSport = getSport();
const spinners = makeSpinners(initialSport);
const liveReload = createLiveReload();

await startServer({
	exposeToNetwork,
	waitForBuild: () => spinners.waitForBuild(),
	liveReload,
});
console.log("");

// Tracks which builds are in flight and which finished, so we can tell the
// browser to refresh once everything settles (rather than once per output).
const CSS_FILENAMES = new Set(["build/gen/light.css", "build/gen/dark.css"]);
const JS_FILENAMES = ["build/gen/ui.js", "build/gen/worker.js"];
const building = new Set<string>();
const builtSinceSettle = new Set<string>();
let erroredSinceSettle = false;
let initialBuildDone = false;
let settleTimeout: NodeJS.Timeout | undefined;

const onSettled = () => {
	const built = [...builtSinceSettle];
	const errored = erroredSinceSettle;
	builtSinceSettle.clear();
	erroredSinceSettle = false;

	// Treat the build that produces the JS bundles as the end of startup. Until
	// then there's no page to reload, and individual outputs (static files, CSS,
	// schema) finish at different times, so we'd otherwise reload spuriously.
	if (!initialBuildDone) {
		if (JS_FILENAMES.some((filename) => built.includes(filename))) {
			initialBuildDone = true;
		}
		return;
	}

	// On a failed build, leave the working page up; the error is in the logs.
	if (errored || built.length === 0) {
		return;
	}

	const onlyCss = built.every((filename) => CSS_FILENAMES.has(filename));
	liveReload.broadcast(onlyCss ? "css" : "reload");
};

const noteLiveReload = (
	filename: string,
	status: "spin" | "success" | "error",
) => {
	if (status === "spin") {
		building.add(filename);
		clearTimeout(settleTimeout);
		settleTimeout = undefined;
		return;
	}

	building.delete(filename);
	if (status === "success") {
		builtSinceSettle.add(filename);
	} else {
		erroredSinceSettle = true;
	}

	if (building.size === 0) {
		// Debounce so a single change that rebuilds several bundles (e.g. the UI
		// and worker sharing a module) results in one reload, not a flurry.
		clearTimeout(settleTimeout);
		settleTimeout = setTimeout(() => {
			settleTimeout = undefined;
			if (building.size === 0) {
				onSettled();
			}
		}, 150);
	}
};

const update = (
	filename: string,
	info:
		| {
				status: "spin";
		  }
		| {
				status: "success";
		  }
		| {
				status: "error";
				error: Error;
		  },
) => {
	noteLiveReload(filename, info.status);

	if (info.status === "success") {
		(async () => {
			let size;
			if (filename !== "static files") {
				size = (await fs.stat(filename)).size;
			}

			spinners.setStatus(filename, {
				status: "success",
				size,
			});
		})();
	} else {
		spinners.setStatus(filename, info);
	}
};
export type Update = typeof update;

// Needs to run first, to create output folder
await reset();

void watchFiles(initialSport, update, spinners.eventEmitter);

watchCss(update);

// Schema is needed for JS bundle, and watchJsonSchema is async
await watchJsonSchema(initialSport, update, spinners.eventEmitter);

watchJs(initialSport, update, spinners.eventEmitter);

spinners.initialized = true;
