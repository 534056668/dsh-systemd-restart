/**
 * dsh-systemd-restart — host half.
 *
 * Why this shape: a process cannot replace itself, and a detached helper is
 * exactly what a unit with the default KillMode=control-group kills along with
 * the host -- so "spawn something that starts the successor" cannot work there.
 * What does work is the arrangement systemd expects: end the process, let the
 * unit start it again. The DSH core already implements the graceful half (it
 * maps SIGTERM to an orderly dispose and exit 0), so all this plugin has to do
 * is schedule that exit after the HTTP answer is on the wire, and leave enough
 * state behind for the next boot to report what happened.
 *
 * @module dsh-systemd-restart
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import {
	decideMode,
	isUserUnit,
	loopGuardTripped,
	readState,
	restartsInWindow,
	settleBoot,
	unitFromCgroup,
	writeState
} from "./policy.js";

/** The web carrier is the only hard dependency: without it there is no route. */
export const inject = ["webServer"];

/** The two routes this plugin owns. */
const STATUS_ROUTE = "/dsh-systemd-restart/api/status";
const RESTART_ROUTE = "/dsh-systemd-restart/api/restart";

/** How long a supervisor probe (a systemctl call) stays fresh. */
const PROBE_TTL_MS = 30000;

/** This package's version, for the status page. */
function pluginVersion() {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	} catch (error) {
		return "unknown";
	}
}

/** Where the restart bookkeeping lives. */
function statePath(config) {
	if (typeof config.stateFile === "string" && config.stateFile.length > 0) return config.stateFile;
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "storages", "dsh-systemd-restart", "state.json");
}

/** Whether an executable is on PATH (systemd-run is optional, not assumed). */
function onPath(name) {
	const path = typeof process.env.PATH === "string" ? process.env.PATH : "";
	return path.split(delimiter).some(function (dir) {
		return dir.length > 0 && existsSync(join(dir, name));
	});
}

/** The unit's Restart= policy, or null when systemctl cannot answer. */
function readRestartPolicy(unit, userUnit) {
	const args = ["show", unit, "-p", "Restart", "--value"];
	if (userUnit) args.unshift("--user");
	try {
		const value = execFileSync("systemctl", args, { encoding: "utf8", timeout: 2500, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return value.length === 0 ? null : value;
	} catch (error) {
		return null;
	}
}

/**
 * Whether a request may control this process: a loopback peer, no forwarding
 * trace, and an Origin that names exactly this authority. The restart route is
 * a "kill this process" button, so it is the one thing here that has to be
 * fenced -- a page on any other origin must not be able to reach it.
 * @param {import("node:http").IncomingMessage} req - the request.
 * @returns {boolean} true when the request is trusted.
 */
export function trustedRequest(req) {
	const address = req.socket === undefined ? undefined : req.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	if (req.headers.forwarded !== undefined || req.headers["x-forwarded-for"] !== undefined || req.headers["x-real-ip"] !== undefined) return false;
	const origin = req.headers.origin;
	const host = req.headers.host;
	if (origin === undefined || host === undefined) return false;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
	} catch (error) {
		return false;
	}
}

/**
 * Mount the plugin: one status route and one guarded restart route.
 * @param {import("@deepseek-ai/cordis").Context} ctx - the host context.
 * @param {{mode?: string, delayMs?: number, unit?: string, stateFile?: string, maxRestarts?: number, windowMs?: number}} [config] - the plugin row's config.
 */
export function apply(ctx, config = {}) {
	const boot = { id: randomBytes(6).toString("hex"), at: Date.now() };
	const stateFile = statePath(config);
	writeState(stateFile, settleBoot(readState(stateFile), boot.at).state);

	const guard = {
		maxRestarts: typeof config.maxRestarts === "number" ? config.maxRestarts : 3,
		windowMs: typeof config.windowMs === "number" ? config.windowMs : 600000
	};
	const delayMs = typeof config.delayMs === "number" && config.delayMs >= 0 ? config.delayMs : 1500;

	let scheduled = false;
	let cache = null;

	const probe = function () {
		const now = Date.now();
		if (cache !== null && now - cache.at < PROBE_TTL_MS) return cache;
		let cgroup = "";
		try {
			cgroup = readFileSync("/proc/self/cgroup", "utf8");
		} catch (error) {
			cgroup = "";
		}
		const userUnit = isUserUnit(cgroup);
		const detected = unitFromCgroup(cgroup);
		const unit = typeof config.unit === "string" && config.unit.length > 0 ? config.unit : detected;
		const restartPolicy = unit === null ? null : readRestartPolicy(unit, userUnit);
		cache = {
			at: now,
			unit: unit,
			userUnit: userUnit,
			detected: detected,
			restartPolicy: restartPolicy,
			mode: decideMode({
				unit: unit,
				userUnit: userUnit,
				restartPolicy: restartPolicy,
				hasSystemdRun: onPath("systemd-run"),
				config: config
			})
		};
		return cache;
	};

	const send = function (res, status, body) {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};

	const snapshot = function () {
		const p = probe();
		const state = readState(stateFile);
		const now = Date.now();
		return {
			ok: true,
			version: pluginVersion(),
			boot: { id: boot.id, at: boot.at, uptimeMs: now - boot.at },
			pid: process.pid,
			unit: p.unit,
			userUnit: p.userUnit,
			restartPolicy: p.restartPolicy,
			mode: p.mode,
			last: state.last,
			guard: {
				maxRestarts: guard.maxRestarts,
				windowMs: guard.windowMs,
				restartsInWindow: restartsInWindow(state.history, now, guard)
			},
			scheduled: scheduled
		};
	};

	/** The systemctl fallback: run it from a transient unit, in its own cgroup. */
	const spawnSystemctlRestart = function (unit, userUnit) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const args = ["--user", "--collect", "--unit", "dsh-systemd-restart-" + stamp, "--on-active=2", "systemctl"];
		if (userUnit) args.push("--user");
		args.push("restart", unit);
		try {
			const child = spawn("systemd-run", args, { detached: true, stdio: "ignore", env: process.env });
			child.on("error", function () {});
			child.unref();
		} catch (error) {
			/* the state file already records the attempt; nothing else to do here */
		}
	};

	/** Do the thing this plugin is for. */
	const carryOut = function (p) {
		if (p.mode.mode === "kill") {
			process.kill(process.pid, "SIGTERM");
			return;
		}
		spawnSystemctlRestart(p.unit, p.userUnit);
	};

	ctx.effect(function () {
		return ctx.webServer.register({
			kind: "exact",
			path: STATUS_ROUTE,
			handler: function (req, res) {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { allow: "GET" });
					res.end();
					return;
				}
				send(res, 200, snapshot());
			}
		});
	}, "dsh-systemd-restart: status route");

	ctx.effect(function () {
		return ctx.webServer.register({
			kind: "exact",
			path: RESTART_ROUTE,
			handler: function (req, res) {
				if (req.method !== "POST") {
					res.writeHead(405, { allow: "POST" });
					res.end();
					return;
				}
				if (!trustedRequest(req)) {
					send(res, 403, { ok: false, error: "restart is limited to same-origin loopback requests" });
					return;
				}
				const p = probe();
				if (p.mode.mode === "off") {
					send(res, 403, { ok: false, error: "这里不能自重启：" + p.mode.why });
					return;
				}
				if (scheduled) {
					send(res, 409, { ok: false, error: "重启已经排程，正在等新进程" });
					return;
				}
				const state = readState(stateFile);
				const now = Date.now();
				if (loopGuardTripped(state.history, now, guard)) {
					send(res, 429, {
						ok: false,
						error: String(Math.round(guard.windowMs / 60000)) + " 分钟内已经重启 " + String(guard.maxRestarts) + " 次，先查日志再重启"
					});
					return;
				}
				scheduled = true;
				writeState(stateFile, Object.assign({}, state, {
					pending: { at: now, pid: process.pid, mode: p.mode.mode },
					history: state.history.concat([now]).slice(-50)
				}));
				send(res, 202, { ok: true, mode: p.mode.mode, unit: p.unit, pid: process.pid, delayMs: delayMs, boot: { id: boot.id, at: boot.at } });
				setTimeout(function () { carryOut(p); }, delayMs).unref();
			}
		});
	}, "dsh-systemd-restart: restart route");
}
