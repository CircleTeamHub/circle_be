# circle_be

一个基于 NestJS 11、Prisma 7 和 PostgreSQL 的后端项目，当前主要包含用户认证、JWT 鉴权、Refresh Token 轮换、用户管理、Swagger 文档和 Prisma Studio 数据查看能力。

## 项目概览

- 技术栈：NestJS 11 + Prisma 7 + PostgreSQL 16
- 包管理器：pnpm
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
- pnpm 10+
- Docker / Docker Compose

## 环境变量

可以参考 [.env.example](/Users/yiboding/projects/circle_be/.env.example)。

开发环境常用的是：

- [.env](/Users/yiboding/projects/circle_be/.env)
- [.env.development](/Users/yiboding/projects/circle_be/.env.development)
- [.env.test](/Users/yiboding/projects/circle_be/.env.test)

关键变量：

- `DATABASE_URL`
- `SECRET`
- `APP_PORT`
- `LOG_ON`
- `LOG_LEVEL`
- `TIMESTAMP`

## 本地启动

1. 安装依赖

```bash
pnpm install
```

2. 启动 PostgreSQL

```bash
docker compose down -v
docker compose up -d
```

3. 同步开发库表结构

```bash
NODE_ENV=development pnpm exec prisma db push
```

4. 启动项目

```bash
pnpm start
```

启动后默认地址：

- API：`http://localhost:3000`
- Swagger：`http://localhost:3000/docs`

## 查看数据库

启动 Prisma Studio：

```bash
NODE_ENV=development pnpm run prisma:studio
```

默认打开：

- Prisma Studio：`http://localhost:5555`

## Docker 数据库说明

[docker-compose.yml](/Users/yiboding/projects/circle_be/docker-compose.yml) 会启动一个 PostgreSQL 16 容器。

默认连接参数：

- Host：`localhost`
- Port：`5432`
- User：`postgres`
- Password：`postgres`

初始化脚本 [01-create-databases.sql](/Users/yiboding/projects/circle_be/docker/postgres/init/01-create-databases.sql) 会创建：

- `nestjs_dev`
- `nestjs_test`

## 常用命令

```bash
pnpm start
pnpm start:dev
pnpm build
pnpm lint
pnpm test
pnpm test:e2e
pnpm exec prisma generate
pnpm exec prisma db push
pnpm run prisma:studio
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
- 如果你修改了 [schema.prisma](/Users/yiboding/projects/circle_be/prisma/schema.prisma)，请重新执行：

```bash
pnpm exec prisma generate
```
