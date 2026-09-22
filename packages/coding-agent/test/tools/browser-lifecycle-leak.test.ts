/**
 * Regression tests for issue #3963: the browser tool leaks Chromium/Puppeteer
 * resources at two termination boundaries.
 *
 * 1. An aborted `open` observes abort only in its `untilAborted` wrapper — the
 *    inner launch resolves in the background and `acquireBrowser` publishes
 *    the handle unconditionally, leaving a live browser at refCount:0 with no
 *    tab holding it. `releaseAllTabs` walks tabs, not browsers, so nothing
 *    ever reaps it.
 * 2. Browser + tab state lives in module-global maps. `AgentSession.dispose()`
 *    walks jobs, eval kernels, provider sessions, and MCP, but has no browser
 *    teardown hook, so any tabs the session opened outlive the session.
 *
 * The tests below cover both by driving `acquireBrowser` / `acquireTab` /
 * `releaseTabsForOwner` directly, with `CmuxSocketClient` prototype methods
 * spied so no real cmux socket / puppeteer process is needed.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import {
	acquireBrowser,
	disposeUnreferencedBrowsers,
	getBrowsersMapForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function makeKind(socketSuffix: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/omp-test-${socketSuffix}.sock`, surface: `surface-${socketSuffix}` };
}

async function drainAllTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

describe("browser lifecycle — aborted open must not leak a browser handle", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("disposes a cmux browser whose launch resolved after the caller aborted", async () => {
		const gate = Promise.withResolvers<void>();
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			await gate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		try {
			const kind = makeKind("abort-orphan");
			const controller = new AbortController();
			const pending = acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal });
			// The reporter's scenario: abort fires while the launch is in flight.
			controller.abort();
			// The launch resolves *after* the abort has been observed by the caller.
			gate.resolve();

			await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			// The freshly-launched browser MUST be torn down before publication so it
			// does not sit at refCount:0 in the global map, leaking a live cmux socket
			// (or, for headless, a live Chromium process) that no `releaseAllTabs`
			// / `dropHeadlessTabs` walk would ever reap.
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});

	it("does not launch at all when the signal was already aborted", async () => {
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		try {
			const kind = makeKind("preaborted");
			const controller = new AbortController();
			controller.abort();
			await expect(acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal })).rejects.toBeInstanceOf(
				ToolAbortError,
			);
			// Not called: pre-abort short-circuit fires before openBrowserHandle.
			expect(connectSpy).not.toHaveBeenCalled();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});
});

describe("browser lifecycle — session-scoped teardown reaps owned tabs", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("acquireTab records ownerSessionId and releaseTabsForOwner tears down only that session's tabs", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		let openCount = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					openCount++;
					return { surface_id: `surface-${openCount}`, url: "about:blank" };
				}
				if (method === "browser.wait") return {};
				if (method === "surface.close") return {};
				if (method === "browser.snapshot" || method === "browser.geometry") return {};
				if (method === "browser.eval") return {};
				return {};
			},
		);

		const kindA = makeKind("owner-a");
		const kindB = makeKind("owner-b");
		const browserA = await acquireBrowser(kindA, { cwd: "/tmp" });
		const browserB = await acquireBrowser(kindB, { cwd: "/tmp" });

		const tabA = await acquireTab("tab-a", browserA, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const tabB = await acquireTab("tab-b", browserB, { timeoutMs: 1_000, ownerSessionId: "session-B" });

		expect(tabA.tab.ownerSessionId).toBe("session-A");
		expect(tabB.tab.ownerSessionId).toBe("session-B");
		expect(getTabsMapForTest().size).toBe(2);

		// Dispose only session A. Session B's tab (and its browser) must survive
		// because a shared long-lived process may still be running under B.
		const released = await releaseTabsForOwner("session-A", { kill: false });
		expect(released).toBe(1);
		expect(getTabsMapForTest().has("tab-a")).toBe(false);
		expect(getTabsMapForTest().has("tab-b")).toBe(true);

		await releaseTabsForOwner("session-B", { kill: false });
		expect(getTabsMapForTest().size).toBe(0);
		expect(getBrowsersMapForTest().size).toBe(0);
	});

	it("acquireTab reusing an existing tab preserves the original owner", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-reuse", url: "about:blank" };
				return {};
			},
		);

		const kind = makeKind("reuse");
		const browser = await acquireBrowser(kind, { cwd: "/tmp" });

		const first = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const second = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-B" });

		expect(first.tab).toBe(second.tab);
		expect(second.created).toBe(false);
		// Reuse must NOT reassign ownership — a subagent re-driving an existing
		// tab shouldn't yank teardown responsibility from the session that opened it.
		expect(second.tab.ownerSessionId).toBe("session-A");

		// releaseTabsForOwner("session-B") is a no-op here — the tab belongs to A.
		const releasedB = await releaseTabsForOwner("session-B", { kill: false });
		expect(releasedB).toBe(0);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(true);

		const releasedA = await releaseTabsForOwner("session-A", { kill: false });
		expect(releasedA).toBe(1);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(false);
	});
});

describe("browser lifecycle — dispose reaps browsers left at refCount 0", () => {
	afterEach(async () => {
		await drainAllTabs();
		await disposeUnreferencedBrowsers({ kill: false });
	});

	it("closes an unreferenced browser but leaves one another session still holds", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);

		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-live", url: "about:blank" };
				return {};
			},
		);

		const orphan = await acquireBrowser(makeKind("orphan"), { cwd: "/tmp" });
		const live = await acquireBrowser(makeKind("live"), { cwd: "/tmp" });
		await acquireTab("live-tab", live, { timeoutMs: 1_000, ownerSessionId: "session-live" });

		expect(orphan.refCount).toBe(0);
		expect(getBrowsersMapForTest().size).toBe(2);

		const disposed = await disposeUnreferencedBrowsers({ kill: true });

		expect(disposed).toBe(1);

		expect(getBrowsersMapForTest().has(orphan.key)).toBe(false);
		expect(getBrowsersMapForTest().has(live.key)).toBe(true);
		expect(getTabsMapForTest().has("live-tab")).toBe(true);
	});

	it("fails fast when tab open races a sweep that disposed the browser", async () => {
		const stale = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			browser: { connected: false },
			pid: 1,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		} as unknown as Parameters<typeof acquireTab>[1];

		// Not in the registry (a sweep already deleted + killed it): acquireTab
		// must reject before spawning a worker against the dead browser.
		await expect(acquireTab("stale-tab", stale, { timeoutMs: 1_000 })).rejects.toThrow(
			"Browser was disposed during tab open",
		);
		expect(getTabsMapForTest().has("stale-tab")).toBe(false);
	});
});
