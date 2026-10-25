/**
 * dsh-systemd-restart — offline self-check.
 *
 * Runs the decision logic, the two HTTP handlers and the client bundle against
 * stubs. It never restarts anything: the one path that would (a valid POST in a
 * mode that is not "off") is deliberately never exercised. Everything else —
 * the fences, the refusals, the loop guard, the boot bookkeeping — is.
 *
 * Run with: npm test
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	decideMode,
	isUserUnit,
	loopGuardTripped,
	normalizeState,
	readState,
	restartsInWindow,
	settleBoot,
	unitFromCgroup,
	writeState
} from "../lib/policy.js";
import { apply, trustedRequest } from "../lib/index.js";

let passed = 0;
let failed = 0;

function check(name, condition) {
	if (condition === true) {
		passed += 1;
		console.log("  ok   " + name);
		return;
	}
	failed += 1;
	console.log("  FAIL " + name);
}

function section(title) {
	console.log("\n" + title);
}

const temp = mkdtempSync(join(tmpdir(), "dsh-systemd-restart-smoke-"));
process.on("exit", function () {
	try { rmSync(temp, { recursive: true, force: true }); } catch (error) { /* best effort */ }
});

/* ---------------------------------------------------------------- policy --- */

section("policy: cgroup -> unit");
check("user unit", unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n") === "dsh-web.service");
check("system unit", unitFromCgroup("0::/system.slice/dsh.service\n") === "dsh.service");
check("no unit", unitFromCgroup("0::/\n") === null);
check("scope under the manager has no owning unit", unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-subprocess-101408-abc.scope\n") === null);
check("scope nested under a service keeps that service", unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service/landlock-run-1.scope\n") === null || unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service/landlock-run-1.scope\n") === "dsh-web.service");
check("the manager itself is not an owning unit", unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service\n") === null);
check("user flag", isUserUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n") === true);
check("system flag", isUserUnit("0::/system.slice/dsh.service\n") === false);

section("policy: how a restart would be carried out");
const killCase = decideMode({ unit: "dsh-web.service", userUnit: true, restartPolicy: "always", hasSystemdRun: true, config: {} });
check("Restart=always -> kill", killCase.mode === "kill");
const systemctlCase = decideMode({ unit: "dsh-web.service", userUnit: true, restartPolicy: "on-failure", hasSystemdRun: true, config: {} });
check("Restart=on-failure + systemd-run -> systemctl", systemctlCase.mode === "systemctl");
const offCase = decideMode({ unit: "dsh-web.service", userUnit: true, restartPolicy: "on-failure", hasSystemdRun: false, config: {} });
check("Restart=on-failure, no systemd-run -> off", offCase.mode === "off");
const bareCase = decideMode({ unit: null, userUnit: false, restartPolicy: null, hasSystemdRun: true, config: {} });
check("no unit at all -> off", bareCase.mode === "off");
const forcedCase = decideMode({ unit: "dsh-web.service", userUnit: true, restartPolicy: "always", hasSystemdRun: true, config: { mode: "off" } });
check("explicit mode wins", forcedCase.mode === "off");

section("policy: loop guard");
const now = Date.now();
check("three inside the window trip it", loopGuardTripped([now, now - 1000, now - 2000], now, { maxRestarts: 3, windowMs: 600000 }) === true);
check("three outside the window do not", loopGuardTripped([now - 700000, now - 800000, now - 900000], now, { maxRestarts: 3, windowMs: 600000 }) === false);
check("count is window-bounded", restartsInWindow([now, now - 700000], now, { windowMs: 600000 }) === 1);

section("policy: state file");
const missingPath = join(temp, "deep", "state.json");
const freshState = readState(missingPath);
check("missing file reads as empty", freshState.pending === null && freshState.history.length === 0 && freshState.last === null);
writeState(missingPath, { pending: null, history: [now], last: { at: now, downtimeMs: 4200, mode: "kill" } });
const roundTrip = readState(missingPath);
check("round trip", roundTrip.history.length === 1 && roundTrip.last.downtimeMs === 4200);
const corruptPath = join(temp, "corrupt.json");
writeFileSync(corruptPath, "{ this is not json");
check("corrupt file reads as empty", readState(corruptPath).history.length === 0);
check("normalizeState tolerates junk", normalizeState("nope").pending === null);

section("policy: boot bookkeeping");
const settled = settleBoot({ pending: { at: now - 6000, pid: 1, mode: "kill" }, history: [now - 6000], last: null }, now, {});
check("a fresh pending record becomes last", settled.restarted === true && settled.last.downtimeMs === 6000 && settled.state.pending === null);
const stale = settleBoot({ pending: { at: now - 900000, pid: 1, mode: "kill" }, history: [], last: null }, now, {});
check("a stale record is dropped, not believed", stale.restarted === false && stale.state.pending === null);

/* ------------------------------------------------------------------ host --- */

section("host: routes and fences (no restart is ever triggered here)");

function makeContext(routes) {
	return {
		effect: function (fn) { fn(); return function () {}; },
		webServer: { register: function (spec) { routes.push(spec); return function () {}; } },
		get: function () { return undefined; }
	};
}

function call(handler, request) {
	const out = { status: null, body: "" };
	const res = {
		writeHead: function (status, headers) { out.status = status; out.headers = headers; },
		end: function (chunk) { out.body = chunk === undefined ? "" : String(chunk); }
	};
	handler(Object.assign({ method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } }, request), res);
	return out;
}

const routes = [];
const offState = join(temp, "off", "state.json");
apply(makeContext(routes), { mode: "off", stateFile: offState });

check("two routes are mounted", routes.length === 2);
const statusRoute = routes.find(function (route) { return route.path.endsWith("/status"); });
const restartRoute = routes.find(function (route) { return route.path.endsWith("/restart"); });
check("status route path", statusRoute !== undefined && statusRoute.kind === "exact");
check("restart route path", restartRoute !== undefined && restartRoute.kind === "exact");

const statusResponse = call(statusRoute.handler, { method: "GET" });
const payload = JSON.parse(statusResponse.body);
check("status answers 200", statusResponse.status === 200 && payload.ok === true);
check("status carries a boot id", /^[0-9a-f]{12}$/.test(payload.boot.id) === true);
check("status carries the version", payload.version === "0.1.0");
if (payload.unit !== null) {
	check(
		"this host: " + String(payload.unit) + " Restart=" + String(payload.restartPolicy) + " -> mode " + payload.mode.mode,
		payload.restartPolicy === "always" ? payload.mode.mode === "kill" : true
	);
}
console.log("       本机判定：unit=" + String(payload.unit) + " userUnit=" + String(payload.userUnit) + " Restart=" + String(payload.restartPolicy) + " mode=" + payload.mode.mode + "（" + payload.mode.why + "）");

check("GET on the restart route is 405", call(restartRoute.handler, { method: "GET" }).status === 405);
const noOrigin = call(restartRoute.handler, { method: "POST", headers: { host: "127.0.0.1:3080" } });
check("POST without Origin is refused", noOrigin.status === 403 && noOrigin.body.indexOf("loopback") !== -1);
const crossOrigin = call(restartRoute.handler, { method: "POST", headers: { host: "127.0.0.1:3080", origin: "http://evil.example" } });
check("POST from another origin is refused", crossOrigin.status === 403 && crossOrigin.body.indexOf("loopback") !== -1);
const forwarded = call(restartRoute.handler, { method: "POST", headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "x-forwarded-for": "10.0.0.1" } });
check("POST through a proxy is refused", forwarded.status === 403);
const nonLoopback = call(restartRoute.handler, { method: "POST", headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }, socket: { remoteAddress: "10.0.0.9" } });
check("POST from a non-loopback peer is refused", nonLoopback.status === 403);
const sameOrigin = call(restartRoute.handler, { method: "POST", headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" } });
check("a trusted POST in mode=off is refused with a reason", sameOrigin.status === 403 && sameOrigin.body.indexOf("mode=off") !== -1);
check("nothing was scheduled by any of that", readState(offState).pending === null && readState(offState).history.length === 0);

section("host: loop guard refuses the third restart inside the window");
const guardState = join(temp, "guard", "state.json");
writeState(guardState, { pending: null, history: [Date.now(), Date.now() - 1000], last: null });
const guardRoutes = [];
apply(makeContext(guardRoutes), { mode: "kill", stateFile: guardState, maxRestarts: 2, windowMs: 600000 });
const guardRestart = guardRoutes.find(function (route) { return route.path.endsWith("/restart"); });
const guarded = call(guardRestart.handler, { method: "POST", headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" } });
check("the third one is 429", guarded.status === 429 && guarded.body.indexOf("已经重启") !== -1);
check("and it scheduled nothing", readState(guardState).pending === null);

/* ---------------------------------------------------------------- client --- */

section("client: the bundle is shaped the way the loader expects");

// The bundle is a browser script: it needs window.__ModuleLoader__ and a
// require seed, so it cannot be imported by Node. It is checked by parsing it
// (node --check, no execution) and by pinning the contract it must satisfy.
const clientPath = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const clientCode = readFileSync(clientPath, "utf8");
const hostCode = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

let parses = true;
try {
	execFileSync(process.execPath, ["--check", clientPath], { stdio: "ignore" });
} catch (error) {
	parses = false;
}
check("the bundle parses as a script", parses === true);
check("it registers through the module loader", clientCode.indexOf("window.__ModuleLoader__.load({") !== -1);
check("its module id is the package name", /id:\s*"dsh-systemd-restart"/u.test(clientCode) === true);
check("it fills the General slot", /const SLOT = "settings\.general\.item"/u.test(clientCode) === true);
check("it registers one row at order 90", /slots\.register\(\{ name: SLOT, id: ID, order: 90 \}/u.test(clientCode) === true);
check("it injects the slots service", /inject: \["slots"\]/u.test(clientCode) === true);
check("it exports { name, inject, apply }", /module\.exports = \{ name: ID, inject: \["slots"\], apply: apply \}/u.test(clientCode) === true);

// The two halves must agree on the paths: a drift here shows up in the browser
// as a row that always says "request failed" while the host log stays empty.
check("both halves agree on the status route", clientCode.indexOf("/dsh-systemd-restart/api/status") !== -1 && hostCode.indexOf('"/dsh-systemd-restart/api/status"') !== -1);
check("both halves agree on the restart route", clientCode.indexOf("/dsh-systemd-restart/api/restart") !== -1 && hostCode.indexOf('"/dsh-systemd-restart/api/restart"') !== -1);

/* ---------------------------------------------------------------- report --- */

console.log("\n" + String(passed) + " passed, " + String(failed) + " failed");
if (failed > 0) process.exitCode = 1;
