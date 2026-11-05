# Home 原生宿主阶段验收

2026-11-03，隔离 Desktop worktree；原始 dirty checkout 未修改。实现和配置边界见 [KIT_HOME_NATIVE_HOST.md](KIT_HOME_NATIVE_HOST.md)。不修改 OpenSpec 任务复选框，不把本记录计为真实 Home DB/Heart 或生产发布。

本轮已验证的可观察行为：

- Home 身份模块：父代理维护的 `home-client.test.ts` 8 项既有真实 HTTP/回调测试已通过；本轮未修改 client/shared Home auth 文件。
- `kit-home-host.test.ts` 4 项：软件不支持时在确认/执行前拒绝、取消不关联/登记/启动、服务器分配目标和私有 access 文件、凭据不进 argv/env、失效终止、配置切换拒绝。
- `kit-home-channel.test.ts` 7 项真实回环 socket：固定 URL 前缀与 native bearer、无 Origin/Cookie、完整作用域、错误 owner/target/Heart/unsafe fence、序号重放、失效关闭、不跟随重定向和外泄 bearer。
- `kit-home-producer.test.ts` 7 项：原始 SDK 和实际 schema/effect、一次 Home call ID 对应一次实际 SDK 写入、结果丢失和替换后消费记录仍拒重做、取消/错误路径/作用域、App 真实关联及重选失效、旧代次/过期精确历史清理；仅视图插件仍须真实 SDK Ready 且严格发布零工具。
- `kit-legacy-contract.test.ts` 11 项与 `kit-desktop-host.test.ts` 10 项：已有来源/数据/SDK 兼容、永久 Home 管理域、禁止 Local/其他 Home 接管、真实 Ready session UUID/Registry 修订号、installer 自报 Home 权威拒绝。相关 Local managed adapter 4 项也通过。

本次最终独立运行 `npx vitest run tests/kit-home-producer.test.ts tests/kit-home-channel.test.ts tests/kit-home-host.test.ts` 共 18 项通过，`npx tsc --noEmit` 通过。

实际原生夹具命令（无 Rust 构建）：

```sh
node tests/kit-home-native-electron.mjs
```

该夹具通过真实 Electron main/preload/sandbox/独立 SDK 窗口，以及真实回环 WebSocket，验证取消前不装入 Registry、实际 SDK Ready UUID/修订号、原始 SDK 业务写入/重复结果、旧 main HTTP `@plugins` 拒绝、断窗即拒绝业务、原始 App 稳定关联/移除/保留程序。结果和截图在 `output/playwright/kit-home-native/acceptance.json`、`sdk.png`。Home 传输服务与用户身份是明确 fixture，没有 Home DB 调用账本或真实 Heart；这些 false 标记保留在 JSON。

纯本机完整三载体回归也在本轮 Registry 改动后通过：

```sh
KIT_INSTALLER_ROOT=/absolute/kit-installer \
KIT_PORTAL_BINARY=/absolute/frozen/heart-portal \
node tests/kit-full-carriers-electron.mjs
```

使用冻结 Portal `9e09b537e4aac0581d7233578934a17f90d1c55c2dd2aef09e24ed9e0cfacaed`，含真实单次父进程 spawn proof、SIGKILL/recover-once、unknown 后旧 stdio/shim/重连拒绝、SDK Ready、失败版本补偿新修订/别名、停用/启用/卸载保留数据与程序。证据仍归 [本地验收记录](KIT_LOCAL_ACCEPTANCE.md)，不算 Home authority 业务。

待跨服务验收：Home-capable Portal 冻结二进制与真实 Home 注册/lease/fence；Home B/C materializer 和 App 选择在 consent digest 前冻结；Home DB 唯一账本、断线未知写入栅栏与真实 Heart 工具调用；发行打包和 Windows/Linux 原生权限。没有这些证据时不认定 Home-owned 全任务完成。


## 真实 Home DB 与 Mac SDK/App 合体（2026-11-03）

新 `being-home-rs/tests/kit_desktop_actual.rs` 以真实Home HTTPS/MySQL、生产HomeClient/NativeHomeDesktopHosts和真实Electron SDK/App producer合体，29.33秒通过。普通Home计划/确认与预先冻结App选择、两个服务分配target、真实SDK Ready及App Associated、独立Being grant、一次SDK写入/同RPC原结果重放、实际Portal旧入口拒绝、v2 capability增加确认、v3部分Ready后App取消、实际StopOwned及fresh revision4恢复v2、disable/uninstall数据与用户程序保留均有断言。SDK records及原数据文件映射以运行时SHA比较，临时profile清理后不重建具体数据hash。

同时明确执行实际Home→Portal A目标8.03秒通过。两显式目标合计2/2、0ignored，使用冻结facts-capable Portal SHA `f6e69a25364146632aabb35f9b246975d448d8cb8f35ec89a92493c57455868f`；正常TLS通道6通过，默认忽略的actual A另显式执行。日志 `/private/tmp/kit-home-mysql-1793713205688877000.log` 与 `/private/tmp/kit-home-mysql-1793713010004804000.log`。本轮相关Node producer10+hostfacts4为14/14，tsc通过。

IdP introspection、私有cipher及mock keychain、Heart WSS、Grove签名HTTP仍为fixture：不是正常OAuth/keychain或genuine DEV；C只证明用户选中程序的稳定Associated，不称OS安装/版本/程序运行。测试没有fake coordinator/Ready/permit。Home是唯一业务账本，Portal在该BC测试中只承担实际legacy deny gate。

显式入口从Home仓库运行，必须提供独立MySQL测试数据库与管理员预先固定的Portal路径/SHA：

```sh
KIT_ACTUAL_DESKTOP_ROOT=/absolute/isolated/portal-desktop \
KIT_ACTUAL_MAC_PORTAL=/absolute/frozen/heart-portal \
KIT_ACTUAL_MAC_PORTAL_SHA256=<independently-verified-sha256> \
cargo test --locked --offline --manifest-path being-home-rs/Cargo.toml \
  --test kit_desktop_actual -- --ignored --nocapture --test-threads=1
```

默认ignored不算通过，不能在没有Mac/实际SDK/固定binary时伪称CI成功。结构化证据位于Home仓库 `output/kit-home-desktop-actual-20261103.json`。已知确认取消可fresh补偿；通用Native Prepare unknown经StopOwned后如何生成新身份继续恢复仍是本P1待闭合项，不清除旧unknown或把旧退役计划重新激活。
