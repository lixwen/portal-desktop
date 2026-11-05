# Kit 本地载体验收记录

日期：2026-11-03。范围是隔离临时目录下的实际 macOS Electron、Rust Portal 与 Rust CLI，身份、签名 Root、业务数据均为显式 fixture，Keychain 为 mock。不代表真实 Home 用户登录、DEV Heart、生产发布、Linux Desktop、Windows ACL 或 OS 组件隔离验收。原工作目录未修改，未提交、推送或部署。

3.9 门禁强化与 `host.spawn-proof.v1` 显式协商已在实际冻结二进制通过：无 controller 的新 MCP 投影不可激活/执行。shim 必须持有实际 Portal 进程刚产生的一次性 spawn nonce，经相互认证控制通道验证真实 OS 父 PID、机器计划与代次后才执行。实际 CLI 在受管启动中 SIGKILL 后恢复只启动一次；真实 unknown 之后，独立 shim、伪造 proof、移除 controller、重新连接与旧 stdio 名称均不能增加业务写入。最新已在 Registry Home 域隔离/SDK 修订号改动后重新通过，证据见包含这些检查的 acceptance.json（Portal SHA256 `9e09b537e4aac0581d7233578934a17f90d1c55c2dd2aef09e24ed9e0cfacaed`）。

实现说明见 [兼容与恢复说明](KIT_COMPATIBILITY.md)。安装器在并行 Being Home 工作树的 `kit-installer/`，其 README 说明纯本地权威、逐载体计划、备份和内容服务；完整 Kit/依赖闭包只在安装器解析。

完整变更路径清单见 [KIT_LOCAL_FILES.txt](KIT_LOCAL_FILES.txt)，其中明确包含本工作树保留的先前 legacy 合同修改，不将它们误当作对原始 checkout 的新修改。

## 逐任务结论

| Task | 已验收的本地范围 | 不由本记录认定完成的范围 |
|---|---|---|
| 3.9 | 完整固定闭包、签名/摘要/有界档案、旧 MCP 投影、实际 Portal 可运行、纯本地离线安装/更新/卸载、保留目录与私有变量、不支持能力准确拒绝 | Home 混合委托不是本地兼容子集的实现证明 |
| 3.10 | 每组件步骤/回执，真实发现、失败 v3→旧 v2 在 revision4 补偿，用户修改守卫、不宣称多组件原子性 | 跨 Home 权威、跨服务完整对账仍需另验收 |
| 3.11 | 旧 plugin/app+plugin 分类，原始 manifest/Release/本地导入、SDK/权限/贡献、真实窗口、完整 Kit 向 DesktopHost 分发，不转换 MCP | Home-owned Desktop 交接、正式市场与真实 Heart 链路仍需另验收 |
| 3.12 | 原始 ID/来源/摘要、独立外部引用、布局与启停、私有/Being 分区、备份/恢复、单实例更新冲突、受管旧入口拒绝 | 本记录不声称任意第三方数据 schema 可自动逆迁移 |
| 3.13 | local-apps.json 稳定 ID，明确用户关联、路径失效/重新选择/解除、父 Kit 卸载保留程序和数据、无伪造版本 | 关联不是 OS 安装/签名/登录/内置工具回执 |
| 3.14 | 显式 Skill/资源索引、Profile/依赖导出、摘要/版本/撤销、同名作用域、无 Home/Desktop 的纯 Skill、旧包显式转换、私有未选文件不公开 | 真实主 Heart 内容选择属于 3.16 |
| 3.15 | 实际 readonly stdio kit-content MCP 与旧 manifest，分页、目录/正文/引用、归属/白名单/真实路径/摘要/UTF-8、停用与旧 revision 拒绝，无脚本执行 | 原生协商目录与真实 Heart 消费不由本测试替代 |
| 4.1–4.4 | 本地单写、内容寻址缓存、精确目标/SDK 差异预览后确认，持久请求/租约/步骤，实际 CLI SIGKILL 与 Node 原子写失败恢复，按 MCP/Plugin/App 激活和回退、保留配置/用户数据/其它引用、受保护历史 unlisted 恢复和 GC 引用 | Home 混合委托/共享账号生命周期、网络下载服务的完整中断演练另验收 |
| 4.5 | macOS 实际进程/窗口/SDK/Portal Host 行为与文档 | Linux Desktop 和 Windows managed 原生验收未做；Windows 管理凭据读取在 ACL 实现前拒绝；user_computer 不等于 OS 隔离 |
| 4.7 | 实际基础 MCP name/arguments、HMAC I/P/L、固定 alias、完整 MCP text/isError、真实重复/冲突/unknown、同一物理插件多 Kit grants 与历史写栅栏 | Home Heart 正式链路、增强协商、HostPolicy 下平台内容 Provider 的受管聚合注册另验收；不导出 App 业务工具 |

上述表格不修改 OpenSpec checkbox。协调者按混合任务的完整范围决定是否勾选，不能将本地验收当作 Home/真实 Heart 成功。

## 可复现命令与证据

从 Desktop 工作树执行：

```sh
npm test -- tests/kit-*.test.ts tests/plugins.test.ts tests/plugin-sdk.test.ts tests/plugin-agent.test.ts tests/tools-library.test.ts tests/client-commands.test.ts
npm run typecheck
node tests/kit-desktop-electron.mjs
KIT_PORTAL_BINARY=/absolute/managed/heart-portal node tests/kit-native-runtime.mjs
KIT_INSTALLER_ROOT=/absolute/kit-installer KIT_PORTAL_BINARY=/absolute/managed/heart-portal node tests/kit-full-carriers-electron.mjs
```

- Desktop 广域检查：18 个文件、109 个测试通过；TypeScript 通过。
- `kit-desktop-electron.mjs`：真实 main/preload/独立窗口/opaque iframe 沙箱，原始导入、停用、实际 UI 更新/恢复、私有数据、已认证旧 HTTP @plugins 和错误 Being/受管入口拒绝。截图：`output/playwright/kit-desktop/library.png`。
- `kit-native-runtime.mjs`：真实 Registry→HMAC→Rust ledger→原始 AgentStore；同 RPC replay/参数冲突/错误/Schema，无业务重试；一个实际原始包上两 Kit 独立 grants，删除第一引用保持物理所有者/其它引用，跨 Kit unknown 继续阻写。无第二源路径或数据副本。
- `kit-full-carriers-electron.mjs`：完整离线 Skill+MCP A+原始 Plugin B+明确 App C，实际 CLI 预览/确认、真实 Portal tools/list 与 SDK Ready，普通 Portal MCP alias 写入、P/L replay、@kit-plugins、旧 @plugins 缺失/未知/大小写 op 拒绝、v1→v2→失败 v3→旧 v2 在 revision4 补偿、旧 alias 拒绝、停用/更高版本启用/卸载、数据与程序保持。
- 冻结的实际 CLI/Portal 二进制摘要和分项结果由 full-carrier 测试写入 `output/playwright/kit-full-carriers/acceptance.json`，窗口截图为同目录 `window.png`。二进制复制到独立临时目录后计算摘要并执行，避免并行构建改变证据对象。

从 Being Home 工作树执行：

```sh
cargo test --locked --manifest-path kit-installer/Cargo.toml
cargo clippy --locked --manifest-path kit-installer/Cargo.toml --all-targets -- -D clippy::correctness -D clippy::suspicious
cargo clippy --locked --manifest-path kit-core/Cargo.toml --all-targets -- -D clippy::correctness -D clippy::suspicious
KIT_PORTAL_BINARY=/absolute/managed/heart-portal cargo test --locked --manifest-path kit-installer/Cargo.toml --test portal -- --ignored --nocapture
```

安装器默认测试包括实际 stdio 内容读取、完整闭包、私有环境/凭据不进公共计划、旧 Skill 选择性转换、缓存归属/篡改/其它安装、真实 CLI 重启后的无门禁拒绝、成功历史/cache 精确资格恢复；可选不兼容组件不执行且必需能力仍拒绝。`desktop_fixture` 的签发生成器与 `portal` 的实际二进制测试有明确 ignored 条件，分别由上述 full-carrier 和 explicit Portal 命令单独运行，不能把默认 skipped 算通过。

最终检查：安装器默认 24 个测试通过，2 个有明确外部条件的测试默认 ignored；实际 Portal 单独测试 1 个通过，full-carrier 签发生成器亦已单独运行。Core all-target correctness/suspicious clippy 通过；安装器同项 clippy 与 rustfmt 通过，仅有 `plan`/`apply_step` 两个非阻断的 too_many_arguments 和一个测试 type_complexity 风格警告。MCP 的实际 CLI SIGKILL 恢复属于 full-carrier 测试；默认 CLI 回归验证重启后的旧 enabled metadata/伪造环境仍不能开放无 controller 业务，不再把无门禁投影当成功安装。

SDK Ready 表示实际当前主进程收到原始包隔离 SDK 通道就绪，不代表第三方业务授权或真实 Heart 消费。普通 UI 的停用/重启用增加 durable management epoch；相同字节也不能复活旧 alias。安装器内部停止不清除用户禁用，新的显式启用才允许重新计划。目录祖先保护、file+parent fsync、相互 HMAC 和 Rust unknown fence 是不同保证，均不声称用户 FullAccess shell 或 OS 管理员受组件隔离。

## 自助市场入口补充验收

实现与独立配置说明见 [KIT_SELF_SERVICE.md](KIT_SELF_SERVICE.md)。2.9/3.7 的本机市场交接部分已落地：固定市场 ID/初始 Root、仅 UUID 的链接选择、有界真实 HTTP 精确闭包校验、实际 Profile/SDK/权限预览、渲染器确认按钮加原生确认、真实 CLI/Host 生命周期。不是用户手工准备 bundle 或分发 controller token。

证据 `output/playwright/kit-market/acceptance.json` 和 `preview.png`/`market.png`，Portal 使用冻结的能力查询版 SHA256 `9e09b537e4aac0581d7233578934a17f90d1c55c2dd2aef09e24ed9e0cfacaed`。实际 HTTP fixture → Electron → CLI → Portal/SDK/App 路径验证取消不安装、确认前无新组件代码/投影、原生显式 App 选择、普通 MCP 调用经 P/L 到原 SDK、受管 stdio 调用、同安装更新/旧别名退休、停用/新复核启用/卸载，以及原有非受管库保持原目录且在 HostPolicy 下继续可调用。

`KIT_EXISTING_PLUGIN_REFERENCE=1` 的独立同入口验收保存在 `output/playwright/kit-market-reference/`，验证用户通过原生 ID+真实 Registry 摘要明确引用已有原插件，拒绝用不同发布内容改变该物理源，停用/重新启用/卸载仍保留原来源、字节与数据。未创建第二条伪物理源或复制用户数据。App 路径消失或关联变化后 Host 状态失效，不继续报告 Associated，也不声称 OS 安装或版本。

安装器新增 7 个真实 HTTP 市场测试和 2 个初始 Root authority/轮换测试：重定向、凭据 URL、额外 Root、外市场/非法 UUID、篡改锁和归档拒绝；较新 Blocked 状态持久化并停用已拥有安装；已拥有 Unlisted 只续签 metadata/status、不下载 lock/package，必须通过确切保护历史与缓存证明恢复。合法 current Root 轮换不改变初始 authority pin，旧 store 缺证明须显式迁移。

已有客户端守护更新回归 34/34 通过。首次在并行 Rust 编译期间按默认 5 秒超时产生测试超时；按串行文件、30 秒有界超时重跑全通过，没有放宽业务断言。新增 Home OAuth 模块的 8 个真实 HTTP/socket 安全测试通过；此处仅证明原生授权实现与独立安全持久化，不代替实际 Home-owned Host channel 或正式 DEV Heart 工具消费。

复现：

```sh
KIT_INSTALLER_ROOT=/absolute/kit-installer KIT_PORTAL_BINARY=/absolute/frozen/heart-portal node tests/kit-market-electron.mjs
KIT_EXISTING_PLUGIN_REFERENCE=1 KIT_INSTALLER_ROOT=/absolute/kit-installer KIT_PORTAL_BINARY=/absolute/frozen/heart-portal node tests/kit-market-electron.mjs
```

打包能力/双二进制摘要校验已对实际冻结 CLI/Portal 验证。完整签名安装包、Windows ACL、Linux Desktop、真实 Home-owned executor channel 与新增完整 Kit 的正式 DEV Heart 消费仍分别验收；本记录未把它们勾为完成。

## Home 原生主机增量

新增 [Home 原生主机说明](KIT_HOME_NATIVE_HOST.md)。身份模块8项既有HTTP/PKCE测试通过；最新生命周期4、出站WebSocket7、原始SDK/App producer7共18项通过，legacy兼容与管理域11项也已通过。`npx tsc --noEmit` 通过。完整本地三载体 Electron 回归在这些 Registry 改动后再通过，未把它计为 Home/Heart 验收。Home B/C materializer、App选择冻结、真实 Home/Heart 跨服务执行仍在实施。

Skill 元数据规范补齐后的受影响回归：Core `skill_metadata` + `content_index` 共 8 项通过，安装器 `content_mcp`、`closure`、`import`、`history_recovery` 共 4 项通过。索引名称和描述取自原始 SKILL frontmatter；缺失 metadata 返回明确可修复错误，不改写历史用户字节。实际 stdio 内容读取与停用撤销仍通过。最新 Home 原生 producer/channel/host 合计 18 项和 TypeScript 检查通过，详见 [Home 原生阶段验收](KIT_HOME_NATIVE_ACCEPTANCE.md)。


### Desktop 本地故障收口：下载中断与显式数据恢复（2026-11-03）

补齐前述4.2/4.3本机证据缺口，未修改Home/shared/冻结Portal、未执行Home Cargo或真实用户数据/远程操作，也不改变任务复选框。下载实际发生在fetch阶段，成功验证完整闭包后才发布内容缓存和bundle；本轮没有编造不存在的下载安装journal或Range续传流程。

- 新market回归使用真实动态端口TCP：第一次声明完整Content-Length但只发送半个gzip并断连接，第二次发虚假超限长度，实际客户端分别报market_response_failed和market_response_limit。两次都验证安装/操作状态原样、cache文件逐项SHA不变、临时下载目录清理、没有release descriptor或新激活，另一已拥有版本及其文件不变。随后不改任何signed Release/status/lock/package，用同精确UUID完整重试，重复同request plan/commit只得到一个新归属，另一安装保持；用纯Skill所以没有也不制造managed Ready。market9+lifecycle6共15通过，focused correctness/suspicious clippy通过。
- 新Desktop Host/Registry真实文件回归从已有受管v1记录/原private及Being分区字节建立真实backup，经原stop/preview/prepare到v2后制造用户数据变化。省略restore_data要求review且禁止Ready；wrong Root/source、stale expected digest、backup origin或dataDigest变更都拒绝且不覆盖用户文件；明确restore_data=true才恢复已验证snapshot原文。先在旧实现准确复现JSON重序列化丢原空格/换行，窄修为先JSON.parse验证再用既有durablePrivateText保留原UTF-8字节及file/parent fsync，未执行任何迁移脚本。
- 另一个旧实现红例证明：backup后新建的另一Being分区虽被保留，却会错误清除review。现在恢复已知文件后重算实际dataDigest，新未知分区保留且仍requires_data_review、不能Ready，不删除或冒称完整数据状态已回退。scope/digest/explicit consent guard保持。
- 当前Desktop Host13+legacy11+Home native producer7共31通过，tsc --noEmit通过。legacy App重选case只精确补已有associationRevision=2的断言，没有放宽匹配或修改生产App。相关对象是实际临时文件/Host控制API合同，SDK Ready回调是fixture，不是本轮新的Electron窗口或OS进程验收。既有actual CLI SIGKILL/full-carrier Electron证据仍单列，不能相互冒充。

命令：cargo test --locked --offline --manifest-path kit-installer/Cargo.toml --test market --test lifecycle（CARGO_BUILD_JOBS=1）；Desktop执行vitest run tests/kit-desktop-host.test.ts tests/kit-legacy-contract.test.ts tests/kit-home-producer.test.ts --maxWorkers=1及tsc --noEmit。结构化证据见private validation evidence (not committed)。这些新增证据关闭了此前列出的本机下载中断、restore_data分支缺口；Home混合三执行器、真实DEV和任意数据schema逆迁移仍不由此推定完成。
