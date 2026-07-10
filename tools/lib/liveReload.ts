import { randomUUID } from "node:crypto";
import type http from "node:http";

const ENDPOINT = "/__reload";

// Injected into index.html by the dev server. Connects to the SSE endpoint and
// either reloads the page or hot-swaps the stylesheets when a rebuild finishes.
// Kept dependency-free and ES5-ish since it runs before any bundle loads.
const CLIENT_SCRIPT = `(function () {
	if (window.__zengmLiveReload) {
		return;
	}
	window.__zengmLiveReload = true;

	var bootId = null;

	function refreshCss() {
		var links = document.querySelectorAll('link[rel="stylesheet"]');
		for (var i = 0; i < links.length; i++) {
			var link = links[i];
			var href = link.getAttribute("href");
			if (!href || href.indexOf("/gen/") === -1) {
				continue;
			}

			var base = href.split("?")[0];
			var fresh = link.cloneNode();
			fresh.setAttribute("href", base + "?t=" + Date.now());

			// Swap in the new stylesheet, then drop the old one once the new
			// one has loaded, to avoid a flash of unstyled content.
			(function (oldLink, newLink) {
				newLink.addEventListener("load", function () {
					if (oldLink.parentNode) {
						oldLink.parentNode.removeChild(oldLink);
					}
				});
				newLink.addEventListener("error", function () {
					if (newLink.parentNode) {
						newLink.parentNode.removeChild(newLink);
					}
				});
			})(link, fresh);
			link.parentNode.insertBefore(fresh, link.nextSibling);

			if (window.themeCSSLink === link) {
				window.themeCSSLink = fresh;
			}
		}
	}

	function connect() {
		var source = new EventSource("${ENDPOINT}");

		source.addEventListener("hello", function (event) {
			// The server sends its boot id on every (re)connection. EventSource
			// silently reconnects after any blip (laptop sleep/wake, tab
			// throttling, a network hiccup), so only reload when the id actually
			// changes - i.e. the dev server was restarted - rather than on every
			// reconnect, which would needlessly wipe in-memory state.
			if (bootId !== null && bootId !== event.data) {
				location.reload();
			}
			bootId = event.data;
		});

		source.addEventListener("reload", function () {
			location.reload();
		});

		source.addEventListener("css", refreshCss);
	}

	connect();
})();`;

export type LiveReload = ReturnType<typeof createLiveReload>;

export const createLiveReload = () => {
	const clients = new Set<http.ServerResponse>();

	// Unique per server process, so a browser can tell an ordinary reconnect
	// (same id) from a dev server restart (new id) and only reload for the latter.
	const bootId = randomUUID();

	// Keep connections alive (and detect dead ones) by sending a comment line
	// periodically. unref so this never keeps the process running on its own.
	const ping = setInterval(() => {
		for (const client of clients) {
			client.write(": ping\n\n");
		}
	}, 30_000);
	ping.unref();

	return {
		endpoint: ENDPOINT,

		// Hold the request open as an SSE stream and remember it so we can push
		// events to it later.
		openStream(req: http.IncomingMessage, res: http.ServerResponse) {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
			});
			res.write("retry: 1000\n\n");
			res.write(`event: hello\ndata: ${bootId}\n\n`);
			res.flushHeaders?.();

			clients.add(res);
			req.on("close", () => {
				clients.delete(res);
			});
		},

		// Insert the client script just before </body> so it loads on every page.
		injectInto(html: string) {
			const tag = `\n<script>${CLIENT_SCRIPT}</script>\n`;
			const index = html.lastIndexOf("</body>");
			if (index === -1) {
				return html + tag;
			}
			return html.slice(0, index) + tag + html.slice(index);
		},

		broadcast(type: "reload" | "css") {
			if (clients.size === 0) {
				return;
			}
			const payload = `event: ${type}\ndata: {}\n\n`;
			for (const client of clients) {
				client.write(payload);
			}
		},
	};
};
