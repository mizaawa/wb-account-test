# WB Pulse 2.0

基于 **Go + Vue 3** 的 WorkBuddy 账号用量看板。采用活力蓝新主题；支持批量导入凭证、查看账号状态与额度，并在手机上分页浏览大批量结果。

> **使用范围：**用户导入本人有权使用的 WorkBuddy 凭证，再由应用查询这些凭证所属账号的状态与额度。本应用不读取 WorkBuddy 浏览器登录 Cookie，也不是官方登录会话。一次检查的账号数量不作程序设定的硬上限；实际容量取决于浏览器内存与设备处理速度。批量在线检测以 8 个并发请求运行，请留意官方服务限流。

## 功能

- Go HTTP 服务：运行时提供静态页面、健康检查及固定目标的官方接口转发。
- Vue 3 + Vite：响应式仪表板、蓝色活力主题、移动端适配、每页 80 条分页渲染。
- 可拖放／多选／分批添加任意数量的 JSON、JSONL、TXT 文件；支持在浏览器粘贴 JSON / JSONL。
- 无文件大小、文件数量或账号数量的应用级导入上限；根据设备内存与浏览器实际能力处理，不承诺硬件容量无限。
- 导入期间逐步显示文件读取和凭证解析进度、百分比及加载动画；导入重复账号时自动去重。
- 按页面内凭证执行账号资料、个人／企业用量查询，支持刷新过期令牌、失败重试、并发取消和结果筛选。
- 不使用 CORS 绕过或浏览器跨域代理：浏览器仅请求当前站点的 Go API；服务端严格映射 WorkBuddy 固定官方接口，限制请求来源并阻止重定向。
- 凭证在本机内存中解析，不写入文件、数据库、Cookie、LocalStorage 或日志；点击检测后会经由你部署的服务器发往官方接口。**仅在你信任的 HTTPS 部署环境中使用。**
- Docker 多架构部署：`linux/amd64` 与 `linux/arm64`；最终运行于只读、非 root 的 `scratch` 镜像。

## 凭证格式

支持每行一条 JSON 对象（JSONL），一个 JSON 对象，或包含账号对象的 JSON 数组。例如：

```json
{"uid":"your-uid","accessToken":"your-access-token","refreshToken":"your-refresh-token","realm":"cn"}
```

也接受 `access_token` / `refresh_token` 字段及常见 `account`、`profile`、`user`、`auth`、`tokens`、`credentials` 包装格式。`realm` 可为 `cn` 或 `intl`；缺省时采用页面的默认选择。

**不要将真实令牌提交到 Git 仓库、公开日志或不可信服务器。**应用不保存令牌；刷新页面即可清除页面内存中的导入数据。

## 启动和部署

### Docker Compose

```sh
docker compose pull
docker compose up -d
```

默认访问 <http://localhost:8080>，健康检查为 `GET /healthz`。查看状态或停止：

```sh
docker compose ps
docker compose logs -f wb-pulse
docker compose down
```

发布镜像为 `ghcr.io/mizaawa/wb-account-test:2.0.1`。将公网部署放在受控的 HTTPS 反向代理之后，设置访问认证和限流；不要开放成任意访问的公共凭证检测服务。反代必须将页面、构建资源及 `/api/` 转发到同一 Go 服务。使用 `/pulse/` 等子路径时须保留尾部斜杠，并一并转发该子路径。

### CORS 与请求链路

```text
浏览器 ──同源 JSON 请求──> 你部署的 Go 服务 ──HTTPS──> 固定的 WorkBuddy 官方接口
```

浏览器不会直接跨域访问 WorkBuddy 官方域名，因此不需要 WorkBuddy 在浏览器请求上启用 CORS。Go 端 API 只允许列明的账号、用量和令牌刷新接口；不接收用户指定的 URL、主机或重定向地址。来源校验不是用户登录或访问认证，公开部署仍需 HTTPS、访问控制与限流。如果部署服务器不能访问 WorkBuddy，应用会显示上游网络错误；CORS 也无法解决账号过期、官方 API 变更或账号本身不可用。

检查 `GET /api/status` 返回的服务版本，可以诊断页面与 API 反代是否指向同一部署。

## 开发与测试

要求 Go 1.23+、Node.js 20.19+（或 Node.js 22.12+）。

```sh
npm ci
go run ./cmd/server &       # http://127.0.0.1:8080
npm run dev                # Vite 前端，/api 代理到 Go 服务
npm run build              # 构建 Vue，并更新 Go 嵌入的页面资源
go test -race ./...
go vet ./...
node --test tests/*.test.js
npm run test:browser       # Chromium；设置 WB_TEST_BROWSER=webkit 可测 WebKit

mkdir -p test-results
go build -trimpath -o test-results/server-test.exe ./cmd/server
npm run test:browser
```

`web/src/` 为 Vue 前端源码；Vite 构建输出至 `internal/server/static/`，并通过 `go:embed` 打包进 Go 程序。Docker 构建在 Node 前端阶段生成静态资源，再编译只包含 Go 的生产镜像。

## 安全边界

- `/api/` 请求最多 64 KiB、响应最多 2 MiB；服务端最多 64 个同时转发请求；上游请求超时为 18 秒。
- 浏览器批量检测使用 8 并发工作任务；大量账号仍需时间处理，且受设备资源与上游 API 限流影响。
- 同源请求和来源验证是防跨站措施，不是访问控制。多用户、互联网公开部署请在反代添加认证、限流与 HTTPS。
- 自动化测试只使用虚构的 `synthetic-*` 凭证与模拟官方响应；未经授权不应导入或检测他人的账号。

## 更新与回滚

将 `WB_IMAGE` 固定到所需标签后升级；保留上一个标签可随时回滚：

```sh
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:2.0.1 docker compose pull
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:2.0.1 docker compose up -d
# 回滚到仍保留的旧版，例如：
WB_IMAGE=ghcr.io/mizaawa/wb-account-test:1.1.2 docker compose up -d
```

## 本地离线安装包

先执行 `npm ci`，再运行 `node scripts/build-release.cjs`。脚本会先重新构建 Vue，再交叉编译 Windows／Linux amd64／arm64 服务端包，并使用本机 Docker Buildx 构建双架构离线镜像。该操作只在 `test-results/release-v2.0.1/` 生成本地安装包；不会推送代码或发布 GitHub Release。

## GitHub 发布

推送 `v2.0.1` 标签后，GitHub Actions 会重新构建前端、运行 Go／Node／浏览器测试，随后构建多架构 Docker 镜像并创建 GitHub Release。需要具备仓库推送权限及 Actions `contents: write` / `packages: write` 权限。
