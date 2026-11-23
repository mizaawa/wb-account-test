# WB Pulse · WorkBuddy 账号测活

活力蓝、圆角、流体动效的 WorkBuddy 批量测活网站。浏览器本地解析凭证文件，Go 提供静态页面、健康检查和**固定官方接口的同源转发**，解决官方接口未开放浏览器跨域访问时的检测失败。

> **v1.1.0 隐私变化：**导入文件仍然只在浏览器解析；点击检测后，所需凭证会临时经过你部署的服务器，再发往官方接口。应用不记录、不持久化凭证，不接入第三方代理。请只使用可信部署、配置 HTTPS 和访问控制。

## 功能

- JSONL 逐行粘贴、JSON 数组、多文件选择、桌面拖放导入。
- 文件读取进度、当前文件名、成功/失败反馈、重复凭证去重；文件列表默认折叠。
- 手机卡片式结果、16px 输入控件、无横向溢出；保留浏览器手势缩放。
- 默认 8 个浏览器并发任务，实时表格、进度、耗时及成功／失败统计。
- 获取手机号或邮箱、已用额度、总额度和使用百分比。
- 全部／成功／失败胶囊筛选，单账号重试、随时停止。
- 国内版和国际版；个人套餐、企业额度、`ck_`／`pt_` API Key。
- 按上游规则在过期时刷新令牌，令牌只存在内存中，不写回文件。
- 禁用浏览器存储和第三方追踪；刷新页面即可清除全部数据。
- Go 无第三方依赖，`scratch` 最小镜像，非 root、只读根文件系统运行。
- GitHub Actions 测试并发布 AMD64／ARM64 镜像和 Release。

## Docker Compose 部署

```sh
docker compose pull
docker compose up -d
```

访问 <http://localhost:8080>，健康检查为 `GET /healthz`。默认端口是 `8080:8080`，可按需修改 `ports`。

```sh
docker compose ps
docker compose logs -f wb-pulse
docker compose down
```

镜像地址默认为 `ghcr.io/mizaawa/wb-account-test:latest`。可用环境变量覆盖，例如固定发布版本：

```sh
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:1.1.0 docker compose up -d
```

支持 `linux/amd64`、`linux/arm64`，无需持久卷或后端环境变量。如果仓库由 fork 托管，请将 Compose 默认镜像地址改成自己的 GitHub 用户名／仓库名。

## 凭证格式

每行一个完整 JSON 对象，或导入一个 JSON 数组。**不要把真实凭证提交到仓库或发送给他人。**

```json
{"uid":"your-uid","accessToken":"your-access-token","refreshToken":"your-refresh-token","realm":"cn"}
```

也支持 `access_token`／`refresh_token` 字段。`realm` 为 `cn` 或 `intl`；缺省时使用页面选择的版本。支持上游 `enterpriseId`、`domain`、`nickname` 字段。API Key 使用 `accessToken` 传入，不能刷新令牌。

支持自动适配常见导出结构，包括顶层账号数组，以及 `{ "account": {...}, "auth": { "accessToken": "...", "refreshToken": "..." } }` 包装格式。令牌容器可使用 `auth`、`tokens`、`tokenData` 或 `credentials`，账号资料可从 `account`、`profile`、`user`、`userInfo` 合并。`.json`、`.jsonl` 和 `.txt` 文件均可多选或拖放导入，内容必须是 JSON 对象、JSON 数组或 JSONL。

### 上游接口链路与 CORS

实现参考 `workbuddy2api-hub-main/wb_accounts.py`：

1. `GET {web}/console/account` 获取账号资料。
2. 个人账号优先 `POST /billing/meter/get-user-resource-summary`，必要时回退至 `/v2/billing/meter/get-user-resource`。
3. 企业账号使用 `/billing/meter/get-enterprise-user-usage`；API Key 使用 `/v2` 前缀。
4. 过期时请求 `/v2/plugin/auth/token/refresh`，同账号并行请求共用一次刷新。

国内版 Web 域名为 `www.workbuddy.cn`，计费域名为 `www.codebuddy.cn`；国际版均为 `www.workbuddy.ai`。

### 同源转发与部署安全

前端仅调用本站的相对路径 `api/{cn|intl}/{action}`，Go 将这些动作映射到上述固定官方接口。没有通用 URL 代理，不接受调用者提供目标主机、路径或查询参数，也不跟随重定向。请求仅转发白名单鉴权头；不向上游转发浏览器 Cookie，不把上游 Set-Cookie 返回浏览器。

- 浏览器同源请求不依赖官方 CORS 响应；部署服务器仍需能通过 HTTPS 访问官方域名。
- 服务不开放跨域访问，校验站点来源和专用请求头；最多 64 个在途请求，请求体上限 64 KiB，响应上限 2 MiB，上游超时 18 秒。
- 文件单个最大 2 MiB，每批最多 100 个 / 20 MiB，累计最多 2000 个账号；导入期间禁用冲突操作。
- 响应设置 `Cache-Control: no-store`；没有数据库、文件写入或凭证日志。反向代理也不应记录 Authorization、请求体和响应体。
- 反向代理须保留原始 Host；支持 HTTPS 在反向代理终止。部署子路径时需把该前缀的页面和 `api/` 一并转发，使用带结尾斜杠的访问地址。
- 公开部署请在反向代理配置访问控制与限流；同源限制不是登录认证，不应把本服务当公共代理。
- 网络超时、上游 HTTP 错误和凭证失效分开显示，不把所有失败笼统归为 CORS。

本地自动化验证只使用合成凭证与模拟响应，不读取截图中的令牌或任何真实账号文件。真实账号有效性仍取决于官方服务及部署网络。

### 升级与回滚

```sh
# 升级（固定此次版本）
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:1.1.0 docker compose pull
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:1.1.0 docker compose up -d
# 回滚到上个版本；会恢复旧的浏览器直连/CORS 限制
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:1.0.2 docker compose up -d
```

## 本地开发

要求 Go 1.23+ 和 Node.js 20+（前端无 npm 运行依赖）。

```sh
go run ./cmd/server
go test -race ./...
go vet ./...
npm ci
node --test tests/*.test.js
npx playwright install chromium
# Windows 将输出路径改为 test-results/server-test.exe
go build -o test-results/server-test ./cmd/server
npm run test:browser
docker build -t wb-pulse:local .
WB_IMAGE=wb-pulse:local docker compose up -d
```

前端源码位于 `internal/server/static/`，使用原生 JavaScript，无构建步骤。`go:embed` 将资源编译进二进制。

## GitHub 自动发布

推送 `main` 或 Pull Request 会运行 CI：Go 格式检查、`go test -race`、`go vet`、JavaScript 测试、Chromium 手机/桌面交互回归、构建和 Compose 配置校验。

推送版本标签即可自动发布：

```sh
git tag v1.1.0
git push origin v1.1.0
```

也可以在 Actions 页面手动运行 **Release** 并输入 `v1.1.0`。工作流在全部测试通过后构建并推送：

- `ghcr.io/<owner>/<repo>:1.1.0`
- `ghcr.io/<owner>/<repo>:1.1`
- `ghcr.io/<owner>/<repo>:latest`

然后创建 GitHub Release，附带 `docker-compose.yaml`、`README.md` 和 `CHANGELOG.md`。工作流只使用内置 `GITHUB_TOKEN`；首次发布后如拉取提示 denied，请在 GitHub **Packages → Package settings** 将包设为 Public，或配置 GHCR 登录。
