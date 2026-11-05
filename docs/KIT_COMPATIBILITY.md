# Kit 与 Desktop 兼容

MCP Kit 继续交 heart-portal；原 `desktop.plugin.json`、本地目录和固定 GitHub Release 插件交 Desktop Plugin Host；普通 App 交 OS 关联流程。`kind=app` 且含字符串或对象 `plugin` 标签的历史条目仍为插件。不把插件转换成 MCP manifest，不将 App 关联导出为业务工具。

## 新受管 Kit 平台矩阵

此矩阵只描述新受管执行器，不是OS enum、通用Electron能力或旧客户端功能声明。

| 本机平台 | MCP A | Desktop Plugin B | App 关联 C |
|---|---|---|---|
| macOS | 实际Host验收 | 实际原SDK/Electron验收，必须重新取得原生确认 | 实际明确选择稳定关联，回执仅Associated |
| Linux | 实际Root/LocalAuthority/CLI验收 | unsupported，尚未验证Linux Electron受管路径 | unsupported，尚未验证Linux Desktop受管关联 |
| Windows/其他 | 当前受管进程/私有ACL门禁unsupported | unsupported | unsupported |

新受管B/C在能力广告、登记、预览、准备、Ready/Associated和受控调用前执行同一Mac门禁；即使Linux有可工作的普通SDK或App路径也不开放新受管安装。Linux Home组合启动跳过B/C并准确说明unsupported，MCP A独立保持。纯内容及独立原生制品字节交付沿各自已有边界，不因B/C门禁被禁止，也不因此新增Windows私有ACL支持。

Local既有受管status/stop/uninstall可达清理，合法已连接Home peer保留原拥有者StopOwned/Observe；记录、未知业务结果、用户数据和外部程序均保留。旧Home Linux B/C重启后若无合法channel，仍如实waiting_device/停止未证实，不能报告Stopped/Removed。没有新增cleanup-only登记或空features伪支持。旧未受管插件/App继续原功能及权限边界，不被本矩阵接管；扩展Linux B/C必须先实际验收再统一更新广告与门禁。

## 插件原位、更新与恢复

Registry 保持原 ID、manifest/最低 SDK、权限与贡献入口、启用状态、页面/窗口布局、图标、侧栏设置。私有存储仍为 `plugins/data/<id>.json`，协作数据仍为 `plugins/agent-data/<id>/<endpoint-sha256>.json`。不移动、合并或上传这些数据；安装确认不增加 SDK 能力。原单实例限制保留。

工具库 → Plugin 提供更新与恢复上一版本。Grove 插件固定使用原 Grove ID；本地插件由用户明确选择同 ID 新版本目录并确认来源。更新预览版本、全部及新增权限、内容摘要、停机窗口和数据条件。先读取/验证新包，再原子替换包记录；更新关闭旧会话/独立窗口，保留停用状态及仍存在的布局入口。不会执行数据迁移，也不保证零停机或后台脚本健康。

上一版本完整包记录保存在 `plugins/backups/<id>.json`。恢复入口核对来源/ID/摘要后恢复包及旧布局/启用状态，保留当前私有与协作数据。新版已经写入的数据不会因恢复二进制而撤销；有格式不兼容时，应先停止插件并从用户自己的数据备份恢复对应分区。未提供自动迁移脚本或未经验证的健康回执。

`plugins/ownership/<id>.json` 持久记录来源、摘要和外部 Kit 引用。卸载默认保留数据及来源记录。不同 Grove ID/来源不能取得旧数据；本地卸载后的重装还须匹配原内容摘要，改变内容应走明确更新流程。历史孤立数据没有来源记录时拒绝交给新包：先恢复原插件包记录并核验来源，不能仅凭同 ID/名称恢复。摘要用于内容一致性，不证明发布者身份。

受信安装器可调用 Registry `referenceInstallation`，输入从实际安装记录与确认计划取得；引用不会安装第二份或启用已停用插件。多个 Kit 引用同一插件时，解除引用保留原安装及全部数据；仍有引用时拒绝直接卸载。`unlinkInstallation` 不删除程序或数据。此内部 API 不暴露给插件 SDK，不能接受模型/插件自报来源或安装归属。

## 受管调用与控制通道

受管插件的旧 `@plugins` 入口和旧发现列表拒绝执行；解除最后引用后保留管理墓碑，不重新开放陈旧旧入口。未受管插件继续走原已认证客户端命令。用户停用或卸载撤销会话、订阅和调用，切换 Being 仍由原 Registry 检查当前 endpoint。

`NativeKitController` 通过本机 loopback NDJSON JSON-RPC，以独立 `kit-controller` 的 `kit-control-hmac-v1` 相互证明认证（双方随机 nonce、固定归属与期限）；控制 secret 不发送到 listener，每帧使用方向/单调序号/精确字节 MAC，伪造服务与篡改/重放失败关闭；模型 MCP token 与控制 token 必须不同。`ManagedDesktopPlugins` 从实际 Plugin Registry 读取原生操作、字段 schema、规范包记录路径和内容摘要，受信安装器提交共享运行合同的完整注册。固定 alias 只能经过 Rust `kit/native/begin` 准入后调用原协作存储，结果经 `kit/native/complete` 持久确认后才返回。开始/完成保持同一连接；断线、超时、未确认完成或存储异常保持 unknown，不自动重试业务写入。Home 权威使用独立原生登录、固定设备登记及认证 Home 调度通道，不复用本地权威；实际隔离 Home HTTP/MySQL 与 Mac Electron 合体证据不冒充 genuine DEV 或正常 OAuth/keychain。

原生资源身份为 `plugin-<SHA256(canonical JSON {"path":<realpath package record>})>`，原生操作名为 `<plugin-id>.<op>`；调用方只提供固定公共 alias 和业务参数，不能提供绑定/账号/权限/目标。受管 JSON 拒绝重复键和过深输入。实际安装器使用内部注册 API，不能从插件 SDK 或普通设置传入源身份。

启动时可读取用户数据目录 `kit-controller.json`。这只能由受信本机安装器/部署流程配置，必须为当前用户拥有、普通非链接、有界文件；Unix 权限必须准确为 `0600`。当前 Windows 尚无已验证的私有 ACL 读取实现，受管配置拒绝加载；未受管兼容功能保持原有边界。不要提交或上传真实文件。字段如下，令牌只使用占位值：

```json
{
  "port": 12345,
  "controller_token": "<replace-with-private-distinct-controller-token>",
  "owner_id": "<owner-id>",
  "heart_id": "<being-id>",
  "target_id": "<target-id>",
  "authority": "local"
}
```

端口来自已配置相同固定身份的本机 Portal controller listener。main 不开放控制 secret/注册 API 给 renderer。缺少配置时保留未受管基线，受管调用拒绝；文件损坏、权限不符、连接失败不降级到旧受管执行。旧 HTTP `kit-plugins` 命令一律拒绝；正式 `@kit-plugins` 由 Portal 转到下面的相互认证 consumer 通道。`kit-plugin-bindings.json` 只由受信安装器的适配器登记，不是模型配置。

## 完整 Kit 的 Desktop Host

私有 `desktop-controller.json` 与 ledger 配置分开，包含 `format_version:1`、loopback `port`（可为 0）和 `targets`。每个 target 固定 `context:{owner_id,heart_id,target_id,authority:"local"}`、`executor`（`desktop_plugin_host` 或 `os_app`）、`generation`、`policyRevision`、`roots`、`allowedPluginCapabilities`、`readRoots`、`writeRoots`、`networkHosts` 与 `controllerToken`。Plugin target 可配置独立 `consumerToken`，并以 `beingEndpoint` 私有固定完整 Being endpoint；只匹配 slug 不足以选择私有数据分区。所有 token 至少 32 字节，I（安装器→Desktop）、P（Portal→Desktop）、L（Desktop→Portal ledger）必须不同，不允许跨角色重用。文件同样要求当前用户拥有、普通非链接、`0600`，不接受 renderer/SDK/模型传入路径或凭据。

main 另写私有端口描述符 `desktop-control-endpoint.json`，只有 `{format_version:1,port}`。Portal 从自己的固定 target B 与 P secret 验证 server proof；描述符不能提供身份或凭据。Portal target B 的 `consumer.descriptor` 指向此文件。MCP target A、Plugin target B 和 App target C 使用不同目标身份，A/B 仍共用同一本地权威的 Rust 持久 ledger。

安装器 I 的固定方法为 `desktop/host/capabilities`、`preview`、`prepare`、`ready`、`register`、`status`、`stop`、`restore`、`uninstall`，以及 `desktop/apps/associations` 和 `desktop/native/status`。预览只读取已声明并实际校验的原始 `desktop.plugin.json`、HTML 与图标；显示当前 SDK 版本、实际 capability 差异、Root 来源、内容摘要、权限和现有引用。确认 digest 后 prepare 才写归属/备份/禁用的原始包，真正的隔离窗口 SDK ready 信号到达后才产生 Ready receipt。应用进程替换会将已保存 Ready 降回 Prepared；禁止用持久记录伪造在线就绪。

P 只允许 `desktop/plugins/catalog {}` 与 `desktop/plugins/call {call:{name,arguments},trusted_call:{session_id,rpc_id},scene_id:null|string}`。session/RPC 来自 Portal 已认证的真实调用上下文，不能来自模型字段。catalog 和调用都要求当前完整 endpoint 与私有固定值相同、来源摘要未变、计划有效且收到本进程 Ready。模型只能选择固定 alias 和业务参数；实际 Registry 对 SDK 原生操作产生 schema，describe/list/get 为读，create/update/configure 为写。

一个真实原始插件可有多个显式 Kit usage grant；原始物理归属不随第一个父 Kit 卸载而转移。使用者解除引用只撤销自己的 alias/grant，保留其余使用者、原始包和私有数据。其它引用仍固定旧摘要时拒绝单实例升级；不复制第二个路径或私有分区规避冲突。失败升级先停止/撤销新版本，再以同 Root 的原始备份和更高计划 revision 恢复；旧 alias 永不复活，未知写栅栏继续有效。若初始化改变了私有数据，恢复保留数据并报告需单独审阅，不能把二进制回滚等同数据迁移回滚。

App Host 只引用用户明确选择的现有稳定关联，返回 Associated；Root 的可选 `existing_association_id` 只能进一步约束选择，缺省时也不按名称猜测。它不按名称猜测、不自动安装或删除 OS 程序，也不伪造版本、签名或内置工具。

## Host 登记与本地 App

`DesktopHostFacts` 在私有 `kit-host-identity.json` 保存随机设备 UUID；进程更换产生新的 incarnation UUID。它从实际 Electron/Node 进程取得 OS/arch，Desktop Plugin 与 OS App 分别登记，声明仅有 `user_computer` 信任，不声称 MCP、隔离或未测就绪。实际注册使用已认证 Home 原生用户会话注入的传输，不能使用 Heart token、Cookie、renderer 自报身份或模型字段。协议为 `POST /v1/me/kit-hosts/registrations`，发送 request/device/incarnation/revision 和能力描述；Home 返回 target/revision/generation/有期限 lease。设备 ID 在网络请求前持久化；过期、目标替换或旧代次回执拒绝，不延长旧回执。这里不自动创建 Home 会话。

`local-apps.json` 保持稳定 ID/名称/私有路径，不按名称重绑。路径消失显示 missing；重新选择由用户确认覆盖同 ID 关联。Kit 引用放在独立 sidecar；卸载父 Kit/解除引用/取消关联仅改记录，不执行 OS 卸载或删除外部程序和数据。`associated` 不表示已验证系统安装、版本、内部扩展、登录或工具可用。原生制品平台兼容必须由完整安装计划独立验证。

## 验证边界

- `npm test -- tests/kit-*.test.ts tests/plugins.test.ts tests/plugin-sdk.test.ts tests/plugin-agent.test.ts tests/tools-library.test.ts tests/client-commands.test.ts`：隔离临时数据下的合同/恢复/控制连接测试。
- `npm run typecheck`：TypeScript。
- `node tests/kit-desktop-electron.mjs`：真实 Electron main/preload/协议、独立窗口及沙箱、停用、更新/恢复、私有数据；实际本机 HTTP `@plugins` 认证/错误 Being/受管旧入口拒绝。只创建临时 profile，macOS 使用测试 keychain，截图保存 `output/playwright/kit-desktop/library.png`。

该 Electron 回归已在当前 macOS 本机通过。它不代表真实 Heart 工具消费、Home 派发、Windows/Linux 二进制、系统权限或第三方业务授权验收；控制连接模拟测试不替代真实 Rust 持久准入集成。未完成的完整安装协调、正式来源/绑定委托、真实 DEV Heart 和跨平台验收须由所属阶段继续验证，不能凭引用记录或 UI 成功将整包标为 ready。

管理墓碑、插件包/备份、协作数据、受管绑定、App 引用和设备登记状态均使用同一私有持久写入：临时文件 `wx/0600` → 文件同步 → 原子重命名 → 父目录同步；新建目录同时同步其父目录。同步失败向上传递，不发布受管注册或确认业务成功。当前实测为 macOS；Windows 文件系统若不能同步目录，相关持久管理操作会失败关闭，不能宣称与 macOS 相同的断电保证，发布前须完成原生实现/验收。

Home 首次登记响应丢失时，持久 pending 记录保存原 request_id、device_id、incarnation、能力及预期 revision；同一认证归属重试原请求，不因网络失败生成第二设备或替换 incarnation。成功回执持久保存后才移除 pending；若它属于已结束进程，随后以本进程新 incarnation 和正确 expected revision 登记，取得当前代次后才返回。不把 Heart token 当 Home 授权。
