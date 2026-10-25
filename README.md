# dsh-systemd-restart

DeepSeek Harness（dsh）插件：在**设置 → 通用**里加一行「重启 dsh web」按钮。

它和常见的重启用插件最大的区别是**重启机制**：不派分离进程（detached helper，独立子进程），
而是让宿主自己优雅退出，交给 systemd 的 `Restart=always` 把它拉起来。

## 为什么需要它

一个进程无法替换自己，所以「重启」天然是两件事：结束旧的、启动新的。常见做法是派一个
detached helper 去做第二件事 —— 但 helper 和宿主在**同一个 cgroup** 里。systemd 默认的
`KillMode=control-group` 会在服务停止时清掉该 cgroup 内的所有进程，helper 跟着陪葬，
于是「重启」变成「把服务杀了、没人拉起来」。`dsh-simple-restart` 与 `dshmarket` 因此
选择在检测到 systemd 监管时**直接拒绝**（本机实测：按钮返回 403）。

本插件走 systemd 本来就期望的那条路：

    [按钮] → 围栏校验 → 先回 202 → 写 boot 标记 → 宿主给自己发 SIGTERM
           → dsh 核心优雅收尾（dispose 插件树 / 会话落盘 / 关 HTTP / exit 0）
           → systemd 按 Restart=always 用原 ExecStart 拉起
           → 新进程读 boot 标记，算出停机时长写回那一行

零权限（不调 systemctl 就不需要 polkit / DBus 授权）、零端口竞态（没有第二个进程抢 3080）。

## 安装

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add /home/ml88wwqq/workspace/dsh-systemd-restart
```

装完**刷新一次页面**：宿主半会随 `patchReload: live` 立即生效，客户端那一行在页面加载时组装。

## 使用

设置 → **通用 / General** → *重启 dsh web*：

- 第一次点击武装按钮（`确认重启？`，5 秒后自动取消），第二次点击执行；
- 提示行先说清这台机器**会怎么重启**（例如「unit dsh-web.service 的 Restart=always：进程退出即被拉起，不需要任何权限」），以及上次重启的停机时长；
- 页面断开后在后台轮询 boot id，新进程一开始服务就自动刷新；120 秒还没起来就停下并给出日志位置。

## 配置

行级 config（在 profile 的 `cordis.patch.yml` 里用 `- id: systemd-restart` + `config:` 覆盖；
注意它是**整体替换**，不是逐键合并）：

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `mode` | `auto` / `kill` / `systemctl` / `off` | `auto` | 重启方式。`auto` 读 unit 的 `Restart=` 决定 |
| `delayMs` | number | `1500` | 回执发出后等多久再退出，给浏览器留出收到 202 的时间 |
| `unit` | string | `''` | 显式指定 systemd unit；留空则从 `/proc/self/cgroup` 探测 |
| `stateFile` | string | `''` | 状态文件路径；留空则用 `$DSH_HOME/storages/dsh-systemd-restart/state.json` |
| `maxRestarts` | number | `3` | 窗口内允许的重启次数，超出直接拒绝 |
| `windowMs` | number | `600000` | 上面那个窗口（毫秒） |

`auto` 的判定：unit 的 `Restart=always` → `kill`；否则若本机有 `systemd-run` 且是用户级 unit
→ `systemctl`（在**独立 cgroup** 的瞬时单元里跑 `systemctl --user restart`，所以不会被连坐）；
两者都不成立 → `off`，并在按钮那一行写清原因，而不是假装能用。

## HTTP 接口

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/dsh-systemd-restart/api/status` | GET | 只读：boot id、pid、探测到的 unit 与 `Restart=`、将要采用的方式及理由、上次重启记录、循环守卫计数 |
| `/dsh-systemd-restart/api/restart` | POST | 重启。先过围栏再动任何东西 |

围栏（重启路由）：非 POST → 405；socket 对端不是 loopback → 403；带任何转发头
（`forwarded` / `x-forwarded-for` / `x-real-ip`）→ 403；缺 `Origin` 或 `Origin` 的 host
≠ `Host` → 403；`mode` 判定为 `off` → 403；已有重启排程 → 409；超出循环守卫 → 429。
通过后返回 202 并附上 `boot.id`（客户端据此判断「新进程起来了没有」）。

## 限制

- **只支持 systemd**。手敲 `dsh web` 起的进程没有任何东西会在它退出后拉起它 → 拒绝重启
  （这正是本插件存在的理由：不做「杀了回不来」的事）。
- **系统级 unit（`/etc/systemd/system/...`）不行**：重启它需要 root/polkit，脚本会拒绝。
- **重启会掐断正在跑的回合**（本插件的取舍：点了就重启，不等待会话空闲）。
- 端口与 unit 的探测是 Linux 特有的；其他平台一律判为 `off`。

## 自检

```bash
npm test          # 42 项离线断言：决策逻辑、两个路由的围栏与拒绝、循环守卫、boot 记账、客户端 bundle 形状
```

测试**从不真的重启**任何东西：唯一会触发退出的那条路径（合法 POST + 非 off 模式）被刻意排除。

装到真实环境后按 dsh 插件 SOP 的「闸⑤」验收：

```bash
OFF=$(wc -c < ~/.dsh/web-stdout.log)     # 该文件是追加式的，先记偏移
systemctl --user restart dsh-web
sleep 20
tail -c +$((OFF+1)) ~/.dsh/web-stdout.log | grep -nE "did not activate|failed to import"
curl -s http://127.0.0.1:3080/dsh-systemd-restart/api/status   # 需带登录凭据，未登录会 401
```

## 许可与出处

MIT。

- 设置行的排版（16px 内边距 + 发丝分隔线 + 36px 胶囊按钮）与同源 loopback 围栏的写法，
  参考了 `dsh-simple-restart`（MIT）——它把「按钮该长什么样、围栏该怎么写」试对了，
  只是重启机制（detached helper）在 `KillMode=control-group` 的 unit 上走不通；
- 「让进程退出、由服务管理器拉起」这条机制在生态里被反复验证过：
  `@goodandready/dsh-smart-restart`（默认 `restartMode: kill`）、`dsh-restart-handoff`、
  `@gehennawu/dsh-service`。
