# Home 原生宿主接入

本地市场和纯本机 authority 不需要 Home。设置中的独立 Home 登录使用原生 PKCE；启用 Home 本机宿主会验证真实 Home 用户、已有 Being 空间及完整现有 Heart 关联，并保持另一个 Home authority 实例。Home 登录与原有 Heart 链接不能互相替代。

管理员先在客户端私有用户目录配置 `kit-home-host.json`（当前 Unix 为 owned regular 0600 文件；Windows ACL 未验收时拒绝）。它只由本机操作者提供，不能来自市场链接、包或 renderer：

```json
{
  "format_version": 1,
  "policy_revision": 1,
  "runtimes": {
    "python3": { "file": "/absolute/operator/python3", "sha256": "<independently-observed-runtime-sha256>" }
  },
  "allowed_plugin_capabilities": ["storage", "agent.read", "agent.write"]
}
```

`policy_revision` 标记本机操作者权限上限的配置版本，不是 Home 安装授权 epoch。Home 签发的每个计划独立绑定其当前授权 epoch；调用仍必须与该计划完全一致。

开发构建可额外指定独立固定 SHA 的 `development_portal: {file, sha256}`；发行构建必须使用受检 runtime bundle 中的配套 Portal。可选 `ca_file` 只接受受保护的管理员 CA 文件，不关闭 TLS 验证。二进制的软件支持查询与实际运行配置查询分开：`--kit-runtime-capabilities` 不代表本机配置或 Ready；`--kit-configured-host-facts` 核对真实 Root、运行时绝对路径和可执行事实。旧 Portal 缺少 Home channel、spawn proof 或 Home legacy reservation 功能时，主机启用拒绝。

主进程自动以同一真实设备身份分别登记 MCP、Desktop 插件与 App 执行器，由 Home 分配目标和代次；用户无需填写目标 ID 或手工登记 publisher/controller。MCP 启动独立 Portal、私有 HOME 和 `home-components` 根。Home 访问凭据只通过私有 0600 原子文件交给其 connector，不含 refresh token；插件、社区子进程的 argv/env 和 renderer 都不接收 Home token。退出、取消登录、切换 Home/Heart 或权限设置会关闭通道和进程。当前入口要求用户已有 FullAccess/Kit 开启策略，不自动提高策略。

同一真实设备的三个执行器共享由主进程持久设备 UUID 和 Home owner 派生的物理调用范围。它是账本的不透明范围标识，不是文件路径；原生插件逐次核对该确切范围，缺失、其他 owner 或其他设备均拒绝。

插件/App 主进程通过固定 Home URL 的出站认证 WebSocket 接收严格的 HomeHost 协议。完整 owner/profile/Heart origin+slug/target/generation/fence 必须匹配；禁止重定向、Origin/Cookie、乱序、重复序号与不安全的 JavaScript u64 数字。业务命令不因连接重建而重发。Home 是唯一调用账本和未知写入隔离权威；这不是 Local ledger 的另一入口。

插件保留原始 manifest/HTML 和实际 SDK。启用前原生窗口显示真实 SDK 要求、增加和全部 capabilities、权限与来源范围，用户确认后才开启实际 SDK 窗口。Ready 绑定真实 SDK 会话 UUID 与持久 Registry 修订号，OS process generation 为 null。SDK JSON 业务结果只在明确边界适配一次 MCP Text envelope。App 只接受真实、用户已选择的稳定关联；Root 中可选 association ID 只是额外约束。Associated 不证明版本、OS 安装或工具就绪，也不删除用户程序。

受控准备与停止和就绪轮询使用同一个串行队列，避免把宿主自行关闭窗口的过渡态当成外部丢失。断窗、Registry 变化、App 路径移除/重新关联会使观测失效并关闭 Home 执行器通道，不能靠心跳保留旧 Ready。Home call ID 在私有持久状态中先消费再执行，结果丢失不能重做同一次写入。未知写入跨安装/目标的业务恢复由 Home 处理；此本机消费记录不替代 Home 账本。

Home 管理域永久写入 Registry ownership tombstone，默认禁止同一物理插件在 Local 或其他 Home authority 间隐式共享。旧 `@plugins` 在主进程拒绝；主 Portal 在任何 HTTP legacy 转发前读取私有 `home-native-reservations.json` 的 deny-only ID 清单。生成的前台/后台配置声明此顶层路径，先成功重启受管 Portal 再启用 Home 插件。清单包含退役/停用 ID，退出 Home 不删除；声明后缺失/不安全/损坏则拒绝 legacy 调用。该文件不发布工具、不授予 Home 权限，也不接受模型提供的 ID。

当前证据分开记录：原生身份模块有真实 HTTP/回调测试；本机 Home host lifecycle、WebSocket 和 SDK/App producer 使用隔离单元边界验证。它们不等于真实 Home DB/Heart 的端到端验收。Home B/C materializer、预先绑定 App 用户选择、Home-capable Portal 冻结二进制和真实 Home→Heart 调用仍须跨服务验收，不能用纯本机已通过的回归代替。


### 设备展示名称协商与重新打开确认

主进程仅从已配置Home的固定native/client-config读取可选features。只有明确声明kit.host-device-display-name.v1后，登记请求才加入本机os.hostname观察到的名称（去首尾空白、128 UTF-8字节内、无控制字符）；旧Home无feature时省略字段并继续使用target ID。名称不改变device/owner/target、能力或generation。丢响应的pending请求保持原样，若新字段的支持消失则拒绝继续发送，不改同request的body。

Home后台恢复只创建新准备操作，不代表自动执行插件页面。实际SDK宿主每次fresh Prepare均先弹原生确认，不缓存批准；窗口不存在、取消或45秒超时均不启用。已有可信stopped记录时显示“重新打开”，说明页面会再次执行初始化；上次结果不确定应先核实外部结果，本确认不会清除先前不确定的业务结果。Prepare的read_only是控制步骤分类，不证明community初始化无外部副作用。拒绝新确认后不打开新SDK窗口、不产生Ready或业务调用，历史unknown及数据保留。


### 受管B/C平台准入

本轮B/C只在实际验收的macOS启用。Linux保留独立Home MCP A；B/C不广告、不登记新目标，Stage/FileChunk/Prepare/Dispatch均在副作用前准确拒绝。组合启动把B/C unsupported作为状态显示，不触发停止A的失败分支。Windows私有ACL尚不支持，未因该门禁新增支持。

已有合法连接仍可处理原拥有者Stop/StopOwned/Observe，Local历史控制可查状态/停用/卸载并保留用户数据。旧Home Linux B/C重启而无合法channel时仍等待设备/停止未证实，不伪造Stopped/Removed，也不创建空feature的cleanup登记冒充可用执行器。普通未受管插件/App不受新受管门禁接管。
