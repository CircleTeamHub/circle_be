# 本地启动指南（Windows）

适用于 Windows 11 + PowerShell。本项目是 NestJS 11 + Prisma 7 + PostgreSQL 16，使用 pnpm 管理依赖。

> 官方 README 的命令是 macOS/Linux 写法，部分在 Windows PowerShell 下不能直接用（设置环境变量的语法不同，且 `build` / `start:dev` 脚本依赖 `ln -sfn`、`mkdir -p` 等 Unix 命令）。本文给出 Windows 下可直接执行的版本。

## 环境要求

| 工具 | 版本 | 验证命令 |
|------|------|----------|
| Node.js | 20+（推荐 LTS） | `node --version` |
| pnpm | 10+ | `pnpm --version` |
| Docker Desktop | 已启动 | `docker --version` |

> 没装 pnpm：`npm install -g pnpm`

## 一、安装依赖

```powershell
pnpm install
```

> `postinstall` 会自动执行 `prisma generate` 生成 Prisma Client。

## 二、准备环境变量（README 未提，必做）

仓库里只有 `.env.example`，**没有** `.env.development`。直接启动会因缺少 `DATABASE_URL` / `SECRET` 而报错。需要先创建开发环境配置：

```powershell
Copy-Item .env.example .env.development
```

然后编辑 `.env.development`，至少确认以下三项（配合下方 Docker 的默认账号密码）：

```dotenv
NODE_ENV=development
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nestjs_dev?schema=public"
SECRET="本地随便填一个长随机字符串即可，32位以上更好"
APP_PORT=3000
```

> - 数据库名用 `nestjs_dev`（由 Docker 初始化脚本自动创建，见下）。
> - 生成随机 SECRET：`[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))`

## 三、启动 PostgreSQL（Docker）

```powershell
docker compose up -d postgres
```

- 镜像：`postgres:16-alpine`，端口 `5432`
- 默认账号：`postgres` / `postgres`
- 初始化脚本会自动创建 `nestjs_dev` 和 `nestjs_test` 两个库

> `docker-compose.yml` 里还带了一个 MinIO 服务（对象存储，端口 9000/9001）。仅做认证/用户相关开发时不需要它；如果要用上传功能再 `docker compose up -d`（不带服务名即可全部启动）。

确认容器健康：

```powershell
docker compose ps
```

## 四、同步数据库表结构

PowerShell 设置环境变量的写法与 README（`NODE_ENV=development ...`）不同：

```powershell
$env:NODE_ENV="development"; pnpm exec prisma db push
```

## 五、启动项目

```powershell
pnpm start
```

启动后默认地址：

- API：http://localhost:3000
- Swagger 文档：http://localhost:3000/docs

> **不要用 `pnpm start:dev` / `pnpm build`**（除非在 Git Bash / WSL 里）。它们的 `prestart:dev`、`postbuild` 脚本用了 `ln -sfn`、`mkdir -p`，在原生 PowerShell / cmd 下会失败。`pnpm start` 走 `ts-node`，不受影响。
>
> 如果确实需要热重载，请在 **Git Bash** 或 **WSL** 终端里运行 `pnpm start:dev`。

## 查看数据库（Prisma Studio）

```powershell
$env:NODE_ENV="development"; pnpm run prisma:studio
```

打开：http://localhost:5555

## 常见问题

| 现象 | 原因 / 解决 |
|------|-------------|
| 启动报 `DATABASE_URL` / `SECRET` 缺失 | 没创建 `.env.development`，见「二」 |
| 连接数据库失败 | Docker 容器没起来或没健康，`docker compose ps` 检查；端口 5432 被占用则改 compose 映射 |
| `start:dev` / `build` 报 `ln` / `mkdir` 不是命令 | 用了 Unix 脚本，改用 `pnpm start`，或切到 Git Bash / WSL |
| 改了 `prisma/schema.prisma` 后类型不对 | 重新生成：`pnpm exec prisma generate` |

## 快捷命令速查（PowerShell）

```powershell
pnpm install                                                  # 装依赖
docker compose up -d postgres                                 # 起数据库
$env:NODE_ENV="development"; pnpm exec prisma db push         # 同步表结构
pnpm start                                                    # 启动服务
$env:NODE_ENV="development"; pnpm run prisma:studio           # 数据库可视化
docker compose down                                           # 停掉容器（加 -v 连数据一起删）
```
