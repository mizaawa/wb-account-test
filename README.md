# WB Pulse · WorkBuddy 账号测活

活力蓝、圆角、流体动效的纯前端 WorkBuddy 批量测活网站。Go 只负责内嵌静态页面与健康检查，**没有账号 API、数据库、日志或凭证代理**。

## 功能

- JSONL 逐行粘贴、JSON 数组、多文件选择、桌面拖放导入。
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
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:1.0.0 docker compose up -d
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

**重要限制：**所有请求确实由浏览器直接发送，因此官方接口必须允许页面来源跨域。未登录探测时部分上游预检没有返回允许跨域的响应，浏览器可能报 CORS；本项目不会通过后端转发来绕过这个限制。页面会把这类情况明确显示为“网络连接失败或浏览器跨域拦截（CORS）”。这不影响 Docker 部署和页面本身运行，但实际测活需要上游 CORS 支持；本次本地验证使用模拟官方响应，未读取上游目录中的任何真实凭证。生产部署建议使用 HTTPS 和访问控制，不要把测活页面直接暴露到公网。

## 本地开发

要求 Go 1.23+ 和 Node.js 18+（前端无 npm 运行依赖）。

```sh
go run ./cmd/server
go test -race ./...
go vet ./...
node --test tests/*.test.js
docker build -t wb-pulse:local .
WB_IMAGE=wb-pulse:local docker compose up -d
```

纯静态源码位于 `internal/server/static/`，使用原生 JavaScript，无构建步骤。`go:embed` 将资源编译进二进制。

## GitHub 自动发布

推送 `main` 或 Pull Request 会运行 CI：Go 格式检查、`go test -race`、`go vet`、JavaScript 测试、构建和 Compose 配置校验。

推送版本标签即可自动发布：

```sh
git tag v1.0.0
git push origin v1.0.0
```

也可以在 Actions 页面手动运行 **Release** 并输入 `v1.0.0`。工作流在全部测试通过后构建并推送：

- `ghcr.io/<owner>/<repo>:1.0.0`
- `ghcr.io/<owner>/<repo>:1.0`
- `ghcr.io/<owner>/<repo>:latest`

然后创建 GitHub Release，附带 `docker-compose.yaml` 和 `README.md`。工作流只使用内置 `GITHUB_TOKEN`；首次发布后如拉取提示 denied，请在 GitHub **Packages → Package settings** 将包设为 Public，或配置 GHCR 登录。
