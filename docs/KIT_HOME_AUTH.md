# Kit 的 Home 原生身份边界

纯本地 Kit 可以没有 Home。Home 管理的安装需要单独登录 Home；Heart 地址只证明对应 Heart 的访问，不能替代 Home 用户登录、账号权限或执行委托。

`desktop/main/home/client.ts` 参考原始工作区已有、尚未提交的 Home 客户端独立移植到 Kit worktree，并在此实现安全加固；原始工作区文件保持不变。主进程从登记的 `/native/client-config/being-desktop` 发现协议，使用系统浏览器、S256 PKCE、随机 state 和固定回环回调 `http://127.0.0.1:47831/oauth/callback` 完成真实 Home 授权。回调拒绝错误 Host、Origin、路径、重复或不匹配 state。原生 token/refresh/revoke 请求使用独立 Node HTTP 上下文，不携带浏览器 Cookie。

会话只由主进程和系统 SafeStorage 处理。版本 2 的加密内容同时绑定精确 Home base URL 与 client ID；未绑定来源的旧凭据要求重新登录。文件必须私有、由当前 OS 用户持有且不是符号链接；写入同步文件及目录，发布前重新检查登录代次。取消与签发竞态会撤销未保存凭据。Windows 私有 ACL 尚未验收时，Home 会话显式关闭，不影响原有纯本地功能。

`withAccessToken` 仅供主进程内部的受信 Home 通道使用，不注册为 renderer IPC；`onSessionInvalidated` 用于在退出、取消或切换身份时关闭持有旧身份的通道。Renderer 只接收 `HomeState` 等公开 DTO。响应及 OAuth 错误有界，不转发原始描述、URL 或凭据。电脑观看只允许当前 Home 的精确 `/desktop/connect` 路径及单一一次性 ticket。

`tests/home-client.test.ts` 的 8 项验证使用真实 HTTP/回环 socket 和明确的 SafeStorage fixture，覆盖 PKCE、回调拒绝、加密来源绑定、私有文件/符号链接、路径与凭据保护、取消竞态撤销、错误清理和电脑 ticket 路径。它不证明 OS 密钥库、真实 Home OAuth 或 Home-owned Kit 执行已验收；这些分别记录真实环境证据。
