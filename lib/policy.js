/**
 * dsh-systemd-restart — pure decision logic.
 *
 * Three questions, none of which needs a running Harness to answer:
 *   1. Who supervises this process? (systemd unit name out of /proc/self/cgroup)
 *   2. Would that supervisor start it again after it exits? (the unit's Restart=)
 *   3. Is another restart allowed right now? (how many happened in the window)
 *
 * @module dsh-systemd-restart/policy
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The systemd unit name out of /proc/self/cgroup.
 *
 * A cgroup line carries several .service components: user@1000.service is the
 * user manager itself, and the LAST one owns this process -- e.g.
 * "0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service"
 * is owned by dsh-web.service.
 * @param {string} text - contents of /proc/self/cgroup.
 * @returns {string|null} the unit name, or null when there is none.
 */
export function unitFromCgroup(text) {
	if (typeof text !== "string") return null;
	const parts = text.split("/");
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = parts[index].trim();
		if (!/\.service$/.test(part)) continue;
		// Reaching the user manager means the walk left the unit that owns us:
		// a process in a transient scope (systemd-run --user --scope, which is
		// how a sandbox runner starts its children) has no owning service, and
		// user@<uid>.service supervises nothing but itself.
		if (/^user@\d+\.service$/.test(part)) return null;
		return part;
	}
	return null;
}

/**
 * Whether the cgroup says this is a --user unit (which decides whether
 * systemctl and systemd-run need the --user flag).
 * @param {string} text - contents of /proc/self/cgroup.
 * @returns {boolean} true for a user manager unit.
 */
export function isUserUnit(text) {
	return typeof text === "string" && /\/user@\d+\.service\//.test(text);
}

/**
 * How a restart should be carried out here.
 *
 * "kill" is the good case: the supervisor restarts on any exit, so ending the
 * process politely is the whole procedure -- no privileges, nothing detached.
 * "systemctl" is the fallback for a unit whose Restart= does not cover a clean
 * exit; it goes through systemd-run so the command runs in its own cgroup and
 * survives the unit stopping. "off" refuses, and says why.
 * @param {{unit: string|null, userUnit: boolean, restartPolicy: string|null, hasSystemdRun: boolean, config: object}} input
 * @returns {{mode: "kill"|"systemctl"|"off", why: string}} the decision.
 */
export function decideMode(input) {
	const config = input.config === undefined || input.config === null ? {} : input.config;
	if (config.mode === "kill" || config.mode === "systemctl" || config.mode === "off") {
		return { mode: config.mode, why: "配置 mode=" + config.mode + " 显式指定" };
	}
	if (input.unit === null || input.unit === undefined) {
		return { mode: "off", why: "本进程不在任何 systemd unit 里：退出之后没有东西会把它拉起来" };
	}
	const policy = input.restartPolicy === undefined || input.restartPolicy === null ? "unknown" : input.restartPolicy;
	if (policy === "always") {
		return {
			mode: "kill",
			why: "unit " + input.unit + " 的 Restart=always：进程退出即被拉起，不需要任何权限"
		};
	}
	if (input.hasSystemdRun === true && input.userUnit === true) {
		return {
			mode: "systemctl",
			why: "unit " + input.unit + " 的 Restart=" + policy + "（正常退出不触发重启），改用 systemd-run 在独立 cgroup 里执行 systemctl --user restart"
		};
	}
	return {
		mode: "off",
		why: "unit " + input.unit + " 的 Restart=" + policy + "，自行退出后没人拉起（也没有可用的 systemd-run 用户实例），拒绝重启"
	};
}

/**
 * How many restarts happened inside the window.
 * @param {number[]} history - past restart timestamps.
 * @param {number} now - current time.
 * @param {{maxRestarts?: number, windowMs?: number}} options - the guard.
 * @returns {number} the count.
 */
export function restartsInWindow(history, now, options) {
	const opts = options === undefined || options === null ? {} : options;
	const windowMs = typeof opts.windowMs === "number" ? opts.windowMs : 600000;
	const list = Array.isArray(history) ? history : [];
	return list.filter(function (at) { return typeof at === "number" && now - at < windowMs; }).length;
}

/**
 * Whether the loop guard refuses another restart right now.
 * @param {number[]} history - past restart timestamps.
 * @param {number} now - current time.
 * @param {{maxRestarts?: number, windowMs?: number}} options - the guard.
 * @returns {boolean} true when a restart must be refused.
 */
export function loopGuardTripped(history, now, options) {
	const opts = options === undefined || options === null ? {} : options;
	const maxRestarts = typeof opts.maxRestarts === "number" ? opts.maxRestarts : 3;
	return restartsInWindow(history, now, opts) >= maxRestarts;
}

/**
 * Coerce anything read off disk into a usable state object.
 * @param {unknown} value - parsed JSON, or anything else.
 * @returns {{pending: object|null, history: number[], last: object|null}} the state.
 */
export function normalizeState(value) {
	if (value === null || typeof value !== "object") return { pending: null, history: [], last: null };
	const pending = value.pending !== undefined && value.pending !== null && typeof value.pending.at === "number" ? value.pending : null;
	const history = Array.isArray(value.history) ? value.history.filter(function (at) { return typeof at === "number"; }).slice(-50) : [];
	return { pending: pending, history: history, last: value.last === undefined ? null : value.last };
}

/**
 * Read the state file, treating a missing or corrupt file as a fresh start.
 * @param {string} path - state file path.
 * @returns {{pending: object|null, history: number[], last: object|null}} the state.
 */
export function readState(path) {
	try {
		return normalizeState(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		return normalizeState(null);
	}
}

/**
 * Write the state file atomically-ish: temp file plus rename.
 * @param {string} path - state file path.
 * @param {object} state - the state to persist.
 * @returns {void}
 */
export function writeState(path, state) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = path + ".tmp";
	writeFileSync(tmp, JSON.stringify(normalizeState(state), null, 2), { mode: 0o600 });
	renameSync(tmp, path);
}

/**
 * Settle the boot bookkeeping.
 *
 * The process that asked for the restart wrote a pending record before it went
 * away; this boot turns it into the "last restart" line the settings row shows.
 * A record older than staleMs is dropped instead of trusted: the restart may
 * never have happened, and a made-up downtime is worse than none.
 * @param {object} state - state as read at boot.
 * @param {number} now - current time.
 * @param {{staleMs?: number}} [options] - staleness bound.
 * @returns {{state: object, last: object|null, restarted: boolean}} the settled result.
 */
export function settleBoot(state, now, options) {
	const opts = options === undefined || options === null ? {} : options;
	const staleMs = typeof opts.staleMs === "number" ? opts.staleMs : 300000;
	const base = normalizeState(state);
	if (base.pending === null) return { state: base, last: base.last, restarted: false };
	if (now - base.pending.at > staleMs) {
		return { state: Object.assign({}, base, { pending: null }), last: base.last, restarted: false };
	}
	const last = {
		at: now,
		downtimeMs: now - base.pending.at,
		mode: base.pending.mode === undefined ? "kill" : base.pending.mode
	};
	return { state: Object.assign({}, base, { pending: null, last: last }), last: last, restarted: true };
}
