/**
 * dsh-systemd-restart — client half.
 *
 * One row in Settings -> General that asks this package's own host route to
 * restart dsh web. The host answers 202 only when a supervisor will start the
 * process again; anything else comes back as a refusal, and the row shows that
 * text rather than pretending to work.
 *
 * This file is this package's "./client" bundle, in the factory form every web
 * plugin hands to window.__ModuleLoader__: no imports, the bundler-owned
 * require("react") seed, and a plain Cordis plugin exported as
 * { name, inject, apply }. The row recipe mirrors the shipped General rows
 * (16px padding under a hairline separator, a 36px pill control).
 */

window.__ModuleLoader__.load({
	id: "dsh-systemd-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const STATUS_ROUTE = "/dsh-systemd-restart/api/status";
		const RESTART_ROUTE = "/dsh-systemd-restart/api/restart";
		const SLOT = "settings.general.item";
		const ID = "dsh-systemd-restart";
		const CONFIRM_MS = 5000;
		const POLL_MS = 1500;
		const POLL_LIMIT_MS = 120000;

		const FOCUS_RING = { outline: "2px solid var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,.75))", outlineOffset: "-1px" };

		const S = {
			row: { display: "flex", alignItems: "center", gap: "8px", padding: "16px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))" },
			text: { display: "flex", flexDirection: "column", flex: 1, gap: "4px", minWidth: 0, paddingRight: "48px" },
			label: { color: "var(--dsw-alias-label-primary, inherit)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" },
			hint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			hintError: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, #f85149)" },
			hintOk: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-success-primary, #3fb950)" },
			btn: { display: "inline-flex", alignItems: "center", gap: "12px", flex: "none", boxSizing: "border-box", height: "36px", padding: "0 14px", border: "none", borderRadius: "18px", background: "var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)))", color: "var(--dsw-alias-label-primary, inherit)", font: "inherit", fontSize: "14px", lineHeight: "22px", cursor: "pointer", transition: "background .12s ease, color .12s ease" },
			btnHover: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))" },
			btnDanger: { color: "var(--dsw-alias-state-error-primary, #f85149)" },
			btnDangerHover: { background: "var(--dsw-alias-interactive-bg-hover-danger, rgba(248,81,73,.14))" },
			btnBusy: { opacity: .6, cursor: "default" },
			btnOff: { opacity: .5, cursor: "default" }
		};

		/** "6.2s" / "800ms" */
		function seconds(ms) {
			if (typeof ms !== "number") return "?";
			return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : String(Math.round(ms)) + "ms";
		}

		/** The boot id a status payload reports, or null. */
		function bootIdOf(status) {
			if (status === null || status === undefined || status.boot === undefined || status.boot === null) return null;
			return String(status.boot.id);
		}

		/** Read the host's status, tolerating the window in which it is restarting. */
		async function readStatus() {
			try {
				const response = await fetch(STATUS_ROUTE, { cache: "no-store" });
				if (!response.ok) return null;
				return await response.json();
			} catch (error) {
				return null;
			}
		}

		/** The settings row: what this host would do, and the two-step button. */
		function RestartRow() {
			const phasePair = React.useState("idle");
			const phase = phasePair[0];
			const setPhase = phasePair[1];
			const messagePair = React.useState("");
			const message = messagePair[0];
			const setMessage = messagePair[1];
			const statusPair = React.useState(null);
			const status = statusPair[0];
			const setStatus = statusPair[1];
			const hoverPair = React.useState(false);
			const hovered = hoverPair[0];
			const setHovered = hoverPair[1];
			const focusPair = React.useState(false);
			const focused = focusPair[0];
			const setFocused = focusPair[1];

			React.useEffect(function () {
				let alive = true;
				readStatus().then(function (next) {
					if (alive) setStatus(next);
				});
				return function () {
					alive = false;
				};
			}, []);

			const busy = phase === "restarting" || phase === "waiting";
			const refused = status !== null && status.mode !== undefined && status.mode !== null && status.mode.mode === "off";

			const waitForBoot = async function (before) {
				const until = Date.now() + POLL_LIMIT_MS;
				while (Date.now() < until) {
					await new Promise(function (resolve) { setTimeout(resolve, POLL_MS); });
					const id = bootIdOf(await readStatus());
					if (id !== null && id !== before) {
						window.location.reload();
						return;
					}
				}
				setPhase("error");
				setMessage("等了 " + String(Math.round(POLL_LIMIT_MS / 1000)) + "s 新进程还没起来；看 ~/.dsh/web-stdout.log 与 journalctl --user -u dsh-web");
			};

			const restart = async function () {
				setPhase("restarting");
				setMessage("");
				let response;
				try {
					response = await fetch(RESTART_ROUTE, { method: "POST" });
				} catch (error) {
					setPhase("error");
					setMessage("请求失败：" + String((error && error.message) || error));
					return;
				}
				const body = await response.json().catch(function () { return null; });
				if (!response.ok || body === null || body.ok !== true) {
					setPhase("error");
					setMessage(String((body && body.error) || ("HTTP " + String(response.status))));
					return;
				}
				setPhase("waiting");
				setMessage("已排程重启（" + String(body.mode) + "）：宿主 pid " + String(body.pid) + "；等新进程…");
				await waitForBoot(body.boot === undefined || body.boot === null ? null : String(body.boot.id));
			};

			const onPress = function () {
				if (busy || refused) return;
				if (phase !== "confirm") {
					setPhase("confirm");
					setMessage("");
					setTimeout(function () {
						setPhase(function (current) { return current === "confirm" ? "idle" : current; });
					}, CONFIRM_MS);
					return;
				}
				restart();
			};

			const danger = phase === "confirm";
			const style = Object.assign({}, S.btn,
				danger ? S.btnDanger : null,
				busy ? S.btnBusy : null,
				refused ? S.btnOff : null,
				focused ? FOCUS_RING : null,
				(!busy && !refused && hovered) ? (danger ? S.btnDangerHover : S.btnHover) : null);

			let hint;
			let hintStyle = S.hint;
			if (phase === "restarting" || phase === "waiting") {
				hint = phase === "restarting" ? "正在重启…" : message;
			} else if (message !== "") {
				hint = message;
				hintStyle = phase === "error" ? S.hintError : S.hintOk;
			} else if (refused) {
				hint = String(status.mode.why);
				hintStyle = S.hintError;
			} else if (status !== null && status.mode !== undefined && status.mode !== null) {
				const last = status.last;
				hint = String(status.mode.why) + (last !== null && last !== undefined ? "；上次重启断线 " + seconds(last.downtimeMs) : "；本次开机以来还没重启过");
			} else {
				hint = "重启 dsh web：宿主优雅退出后由 systemd 拉起（本页会断开并自动重连）";
			}

			const label = busy ? "重启中…" : phase === "confirm" ? "确认重启？" : phase === "error" ? "重试" : "重启";

			return React.createElement("div", { style: S.row },
				React.createElement("div", { style: S.text },
					React.createElement("span", { style: S.label }, "重启 dsh web"),
					React.createElement("span", { style: hintStyle }, hint)),
				React.createElement("button", {
					type: "button",
					style: style,
					disabled: busy || refused,
					title: "让宿主优雅退出，由 systemd 的 Restart=always 把它拉起来（仅同源 loopback 可用）",
					onClick: onPress,
					onMouseEnter: function () { setHovered(true); },
					onMouseLeave: function () { setHovered(false); },
					onFocus: function () { setFocused(true); },
					onBlur: function () { setFocused(false); }
				}, label));
		}

		/** Register the row, owned by this plugin's fiber so unloading removes it. */
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(function () {
				return slots.inject(SLOT, function () {
					return slots.register({ name: SLOT, id: ID, order: 90 }, RestartRow);
				});
			});
		}

		module.exports = { name: ID, inject: ["slots"], apply: apply };
		return module.exports;
	}
});
