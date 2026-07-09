import { copyFiles } from "../build/copyFiles.ts";
import { generateVersionNumber } from "../build/generateVersionNumber.ts";
import { buildIndexHtml } from "../build/buildIndexHtml.ts";
import { makeNormalWatcher } from "./makeNormalWatcher.ts";

export const watchFiles = makeNormalWatcher({
	build: async (sport, signal) => {
		// Would be better to only copy individual files on update, but this is fast enough
		await copyFiles(sport, true, signal);
		if (signal.aborted) {
			return;
		}

		const versionNumber = generateVersionNumber();
		await buildIndexHtml({ signal, sport, versionNumber, watch: true });
	},
	outFilename: "static files",
	watchFiles: ["public", "data", "node_modules/flag-icons"],
	// public/css is built and live-reloaded by the dedicated CSS watcher, and
	// copyFiles ignores it too, so a change there shouldn't trigger a redundant
	// (no-op) static files rebuild - which would otherwise force a full page
	// reload instead of a hot CSS swap.
	ignored: (file) => file.replaceAll("\\", "/").includes("public/css"),
});
