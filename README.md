# circle_be

一个基于 NestJS 11、Prisma 7 和 PostgreSQL 的后端项目，当前主要包含用户认证、JWT 鉴权、Refresh Token 轮换、用户管理、Swagger 文档和 Prisma Studio 数据查看能力。

## 项目概览

- 技术栈：NestJS 11 + Prisma 7 + PostgreSQL 16
- 包管理器：npm（仓库里只有 `package-lock.json`，CI 走 `npm ci`）
- 认证方案：`accessToken + refreshToken`
- 接口文档：Swagger
- 数据查看：Prisma Studio
- 数据库容器：Docker Compose

当前已可用的核心认证链路：

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

## 目录结构

```text
src/
  auth/          认证、JWT、refresh token
  user/          用户管理
  prisma/        Prisma 服务封装
  guards/        Jwt / Admin / Role / CASL 守卫
  interceptors/  统一响应包装、序列化
  filters/       Prisma / HTTP 异常处理
  logs/          日志相关模块
  roles/         角色相关模块
  menus/         菜单相关模块
prisma/
  schema.prisma  Prisma 数据模型
docker/
  postgres/init  PostgreSQL 初始化脚本
test/
  *.e2e-spec.ts  端到端测试
```

## 环境要求

- Node.js 20+
- npm 10+
- Docker / Docker Compose

## 环境变量

可以参考 [.env.example](.env.example)。

开发环境常用的是（均不入库，需本地自行创建）：

- `.env`
- `.env.development`
- `.env.test`

关键变量：

- `DATABASE_URL`
- `SECRET`
- `APP_PORT`
- `LOG_ON`
- `LOG_LEVEL`
- `TIMESTAMP`
- `HTTP_LOG_ON`
- `SLOW_REQUEST_MS`
- `BUSINESS_LOG_ON`
- `EXTERNAL_LOG_ON`
- `RATE_LIMIT_LOG_ON`

日志策略、字段和排查方式见 [docs/logging.md](docs/logging.md)。

## 本地启动

1. 安装依赖

```bash
npm ci
```

> 用 `npm ci` 而不是 `npm install`：在已有的旧 `node_modules` 上 `install` 会留下残缺依赖树
> （典型症状是 `request-ip` 解析不出类型、`nest` 编译报 TS2307），CI 走的也是 `npm ci`。

2. 启动本地依赖容器（PostgreSQL / MinIO / Redis）

```bash
docker compose up -d
```

> 加 `-v` 的 `docker compose down -v` 会连数据卷一起删，只在需要把本地库推倒重来时用。

3. 应用数据库迁移

```bash
NODE_ENV=development npx prisma migrate deploy
```

> 本项目是迁移驱动的（`prisma/migrations/`），不要用 `prisma db push` —— 它会绕开迁移历史
> 直接改表结构，之后 `migrate deploy` 会因为 drift 失败。

4. 启动项目

```bash
npm run start:dev
```

启动后默认地址：

- API：`http://localhost:3000`
- Swagger：`http://localhost:3000/docs`

## 查看数据库

启动 Prisma Studio：

```bash
NODE_ENV=development npm run prisma:studio
```

默认打开：

- Prisma Studio：`http://localhost:5555`

## Docker 本地依赖说明

[docker-compose.yml](docker-compose.yml) 启动三个服务，都只服务本地开发（应用本体跑在宿主机上，
这样才有 `start:dev` 的热重载和断点）：

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| `postgres` | 5432 | PostgreSQL 16，业务库 |
| `minio` | 9000 / 9001 | S3 对象存储，9001 是控制台（`minioadmin` / `minioadmin123`）。bucket 由应用启动时自建，无需手工初始化 |
| `redis` | 6379 | 可选。`.env.development` 里**不配** `REDIS_URL` 时应用会退化成单实例内存态（实时推送和限流不跨进程共享），本地一般够用；要验证跨实例行为才需要配上 |

生产侧的完整编排（含应用、迁移、admin_web、Caddy、蓝绿）在
[docker-compose.prod.yml](docker-compose.prod.yml)，部署流程见 [DEPLOY.md](DEPLOY.md)。

PostgreSQL 默认连接参数：

- Host：`localhost`
- Port：`5432`
- User：`postgres`
- Password：`postgres`

初始化脚本 [01-create-databases.sql](docker/postgres/init/01-create-databases.sql) 会创建：

- `nestjs_dev`
- `nestjs_test`

`.env.development` 里的 `DATABASE_URL` 需要指向其中之一（通常是 `nestjs_dev`）；指向别的库名时
容器初始化脚本不会替你建，`migrate deploy` 会直接连不上。

## 常用命令

```bash
npm start
npm run start:dev
npm run build
npm run lint
npm test
npm run test:e2e
npx prisma generate
npx prisma migrate deploy
npm run prisma:studio
```

## 认证说明

- `accessToken`：短期访问令牌，用于访问受保护接口
- `refreshToken`：长期刷新令牌，用于换取新的 `accessToken`
- Refresh Token 在数据库中以哈希形式存储，并支持轮换和失效处理

## 测试接口

推荐先通过 Swagger 或 Postman 依次测试：

1. `register`
2. `login`
3. `me`
4. `refresh`
5. `logout`

统一成功响应格式为：

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

## 说明

- Prisma Client 通过 `postinstall` 自动生成
- 如果你修改了 [schema.prisma](prisma/schema.prisma)，请重新执行：

```bash
npx prisma generate
```
