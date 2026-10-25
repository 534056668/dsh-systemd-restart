# Changelog

## 0.1.0

- First version. A restart row in Settings -> General.
- Mechanism: the host ends itself gracefully (SIGTERM, which the DSH core turns
  into an orderly dispose + exit 0) and the systemd unit's `Restart=always`
  starts it again. No detached helper, so `KillMode=control-group` cannot kill
  the thing that was supposed to bring the replacement up.
- `mode: auto | kill | systemctl | off` (auto reads `Restart=` off the unit).
- Same-origin loopback guard on the restart route.
- Loop guard: refuse more than `maxRestarts` restarts inside `windowMs`.
- Boot bookkeeping: downtime of the last restart is reported back into the row.
- Client polls the boot id and reloads the page by itself once the new process
  is serving.
