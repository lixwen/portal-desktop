# 本机市场安装入口

此入口实施 `introduce-being-kit-platform` 的本机自助安装部分。普通用户从已配置市场选择精确发布 UUID，查看真实 Profile、权限、Desktop SDK 和能力差异，再点击确认。主进程还会显示独立的原生确认框；取消不会安装。安装、更新、停用、重新启用和卸载调用同一实际 `kit-installer`，经真实 Portal Host / Desktop SDK / 显式 App 关联执行。完整 Kit 不会转换为 MCP 或交给旧 Portal 下载器。

## 独立信任配置

本机管理员在客户端 user-data 目录放置自己拥有、权限为 `0600` 的 `kit-product.json`；所有父目录也必须受当前用户或 root 保护。Windows 尚未验证私有 ACL，受管入口拒绝运行。此文件属于本机配置，不来自下载链接、包、浏览器、模型或市场 HTTP 响应。

```json
{
  "format_version": 1,
  "markets": [{
    "id": "private-market",
    "label": "独立配置的市场",
    "base_url": "https://market.example.invalid/",
    "root": { "payload": {}, "signatures": [] },
    "root_digest": "<独立验证的 Root payload SHA256>"
  }]
}
```

`root` 必须替换为管理员通过独立渠道验证的真实 Core SignedMetadata Root；示例不是可用 Root。Root 与签名发布者由管理员配置一次，普通用户不准备 bundle、不手工注册发布者，也不分发控制 token。Root 不能从市场链接或市场服务器首次信任。已有市场配置不可重新定向；换 Root/市场必须独立配置新市场并明确处理已有资源，不接管其他来源的数据。

同一 authority 的合法轮换通过独立配置的有序 `root_updates` 数组或管理员 `rotate-root` CLI 完成，要求旧/新阈值签名和连续 revision。初始 authority pin 保存在受保护初始化证明中，轮换 current Root 只改变验签版本，不改变已有资源的来源所有权。缺少初始化证明的旧 store 必须显式迁移；不能从当前市场的新 Root 推断旧 authority。

开发环境允许在此私有文件内增加 `development_runtime`，其中 `installer`、`installer_sha256`、`portal`、`portal_sha256` 指定受审查的绝对路径和真实文件摘要；正式安装包忽略此字段，使用安装包内的运行时清单。DEV HTTP 仅允许显式设置 `allow_http_loopback: true` 的数字 loopback 地址；不接受 `localhost` DNS、凭据、query、fragment、重定向或代理环境变量。

客户端自动创建私有 `kit-local-authority.json`、每市场的 Root-pinned store、A/B/C target、独立 I/J/P/L key、Node Host 配置和 Portal profile。Heart 标识与完整 endpoint/origin 来自用户当前已有的 Being 连接；不把 Heart token 当作 Home 登录或资源所有权。未连接 Heart 时纯 Skill 仍可在本机安装；本机代码执行必须存在实际可信 Host。首次绑定 Heart 后使用原身份，换 Heart 时拒绝自动重新定向，保留原账本、unknown 和用户数据。已有手工 Host 配置须明确处理，不静默覆盖。

自助入口沿用客户端当前权限模式。Kit 确认不会升级 read-only / supervised / auto-review。当前 Portal MCP Host 仅支持已有 FullAccess 策略，其他模式在预览中阻止确认；用户可自行选择已有客户端安全策略。当前用户仍可以在受管路径以外手动运行自己的程序，这不是 OS 隔离保证。

## 用户操作和链接

市场可提供 `portal-kit://install?market=private-market&release=<精确 UUID>`。系统打开客户端的工具库并填入选择，仍需用户点击预览和确认。只接受这两个参数；Root、URL、路径、凭据、账号、Profile、安装器配置及确认字段均不能从链接带入。未知市场不会自动增加信任。

预览只下载并检查字节、签名、状态、锁文件和完整依赖闭包，不启动社区组件。多 Profile 必须从真实声明中选择。票据绑定主进程配置、当前 Being/profile、有效期和确切计划摘要；渲染器不能自报已确认或替换摘要。原生确认后 Rust 重新验证完整计划，实际 Ready 由真实 tools/list 或原 SDK 握手产生。

原 App 只允许用户明确选定已经存在的本机程序关联。Root 中 `existing_association_id` 是可选的进一步约束；提供时必须精确匹配。无此约束时仍需本机文件选择，不能猜名称、路径或版本。关联不代表已验证 OS 安装或版本，也不会复制、删除或卸载 OS 程序。

同稳定 ID 的现有原插件不会自动接管。安装器通过 I 通道读取实际 Registry 摘要，由原生确认框让用户明确选择引用，再由 Host 校验 Root 包中的原始字节与该摘要一致。引用不复制物理源或用户数据、不改变原所有权；其他引用固定不同内容时更新拒绝。该检查与 schema/effect 物理观测均由主进程/Registry 产生，渲染器和 SDK 不能提交来源断言。

同市场同 Kit 的新发布使用同一个拥有的 installation，重新预览后更新。重新启用也复核实际 SDK、权限和资源，并绑定新的确认摘要。停用/卸载保留用户数据、未知结果围栏和其他 Kit 的引用；新修订不能复活退休别名。遇到未知写入、用户覆盖或未确认停止时保留恢复状态，不自动重试业务或声称恢复 Ready。

## CLI 和打包

低层 CLI 仍支持独立离线安装，市场入口新增：

```sh
kit-installer --state /absolute/private/state configure-market /absolute/private/market.json
kit-installer --state /absolute/private/state fetch --market private-market --release <UUID>
kit-installer --state /absolute/private/state plan-release --market private-market --release <UUID> --profile basic --installation <owned-id> --trust-user-computer
```

CLI 的市场配置包含 `format_version`、`market_id`、固定 `base_url`、独立 `root_digest` 与可选开发 loopback 开关。Root 须先通过 `init` 独立初始化，不能随 fetch 导入。下载每个精确锁定的 release，校验 Core 签名/状态、SHA、大小、归档和完整闭包后进入受保护缓存。新安装及网络下载拒绝 Unlisted/Blocked。已拥有缓存的历史恢复使用独立受保护历史证明，不赋予新的网络下载权。较新 Blocked 状态先持久化，然后停用所有包含该发布的已拥有安装；停止/撤销未确认则报告 `release_blocked_revocation_pending`，保留恢复记录。恢复允许状态不会自动重新启用。

`refresh-owned --market <id> <installation>` 仅从固定市场更新已拥有安装的签名 metadata/status，不获取 lock/package 或 App 文件；允许仍安全的 Unlisted 版本续签，要求发布、完整字节摘要和锁身份与受保护成功历史精确一致。旧成功计划不被重写，续签描述单独持久化；重新启用生成新修订并再次确认。该路径不为新安装或其他 owner/installation 赋予恢复资格。

打包须提供经过审查的 `KIT_INSTALLER_SOURCE` 和 Portal source，执行 `node scripts/build-kit-installer.mjs`、既有 Portal build 和 desktop prepare。安装包包含真实 CLI 与 Portal，`runtime-bundle.json` schema 2 记录两者 SHA、平台/架构、协议和软件能力；macOS 同时签名两个可执行文件。缺少 `host.spawn-proof.v1`、受管 admission 或固定市场能力时打包和配置阶段拒绝，不能启动社区代码。软件能力查询不表示设备已经配置、在线或 Ready。

## 验证边界

`tests/kit-market-electron.mjs` 使用隔离真实 HTTP 市场、独立签名 Root、实际 Electron/CLI/Portal 和原 SDK；原生文件选择与确认框由测试驱动，确认按钮仍通过真实渲染器点击。该 fixture 使用明确的测试 Heart 身份，不是实际 DEV Heart/Home/OAuth 验收，也不是生产发布。

Home 账号、委托与正式 Being 内容投影不由本机入口伪造。跨平台 ACL/OS 安装、自动升级与生产发布仍按各自验收范围执行。
