# Database Review Release TODO

这份清单记录数据库 review 和通知游标分页已经完成后，正式上线前需要补做的验证。完成每项后把命令、环境、时间和关键结果补在对应的「证据」位置。

## 上线前检查

- [ ] **帖子完整 trigram 索引迁移及中断恢复**

  `20261007010000_cover_all_admin_post_search` 先并发建立完整 GIN，后续
  `20261007010100_drop_redundant_partial_post_search` 才删除旧 partial GIN。
  新建语句故意不使用 `IF NOT EXISTS`：同名索引可能是中断构建留下的 invalid
  索引，必须阻止部署继续删除仍可用的旧索引。正常已完成的 Prisma 迁移不会重跑。

  如果部署失败，先停止该次发布，用实际发布数据库运行 `npx prisma migrate status`。
  确认下面的构建进度查询没有返回仍在运行的任务，再核验索引状态与定义
  （下面以 `public` schema 为例；其他 schema 必须替换）：

  ```sql
  SELECT pid, phase FROM pg_stat_progress_create_index
  WHERE relid = 'public."CirclePost"'::regclass;

  SELECT n.nspname, c.relname, i.indisvalid, i.indisready,
         pg_get_indexdef(i.indexrelid) AS definition,
         pg_get_expr(i.indpred, i.indrelid) AS predicate
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('CirclePost_content_admin_trgm_idx', 'CirclePost_content_trgm_idx');
  ```

  - 完整索引 `indisvalid=false` 或 `indisready=false`：确认旧 partial 索引仍有效，
    在事务外单独执行 `DROP INDEX CONCURRENTLY public."CirclePost_content_admin_trgm_idx";`。
    然后执行 `npx prisma migrate resolve --rolled-back 20261007010000_cover_all_admin_post_search`
    和 `npx prisma migrate deploy`，重新建立完整索引后再移除旧索引。
  - 完整索引已有效，但 Prisma 未记录该次构建完成：重试仍会因同名索引失败，这是预期。
    必须人工确认 `indisvalid=true`、`indisready=true`、目标表为 `CirclePost`、完整
    `GIN (content gin_trgm_ops)` 且 `predicate` 为 NULL。确认该失败迁移的全部语句
    已完成后，执行 `npx prisma migrate resolve --applied 20261007010000_cover_all_admin_post_search`
    和 `npx prisma migrate deploy`。不要把 invalid 或定义不符的索引标记为 applied。
  - 完整索引不存在：确认没有仍在运行的构建，再对该失败迁移执行上述 `--rolled-back`
    和 deploy。恢复后复查索引有效性、默认无 status 搜索的 `EXPLAIN`、migration status
    和 schema drift，并保留日志。

  **证据：**

  ```text
  发布数据库/schema：
  迁移与索引状态：
  中断原因与恢复命令：
  查询计划/drift 结果：
  时间：
  ```

- [ ] **真实账号鉴权接口冒烟**

  使用真实登录态验证通知接口的完整流程：

  - 互动通知首屏和第二页游标请求：`/notification/list?cursorMode=true`
  - 系统通知首屏和第二页游标请求：`/notification/profile/list?cursorMode=true`
  - 刷新后游标重置且没有重复项
  - `moments` / `circle` 域切换后数据不串域
  - 单条已读和全部已读后的未读数、列表状态一致

  **证据：**

  ```text
  环境：
  账号/客户端版本：
  时间：
  结果：
  ```

- [ ] **隔离数据库并发压测**

  在独立数据库执行性能脚本，并补充并发请求场景。至少记录 p95/p99、数据库连接数、CPU、锁等待和错误率；串行基准脚本为：

  ```bash
  PERF_DB_REVIEW=1 PERF_DB_REVIEW_ROWS=20000 npm run perf:db-review
  ```

  **证据：**

  ```text
  数据库/数据规模：
  并发模型：
  p95/p99：
  连接数/CPU/锁等待：
  错误率：
  时间：
  ```

- [ ] **上线后观察查询计划和索引使用率**

  发布后使用 `pg_stat_statements`、慢查询日志和索引统计确认：

  - 通知 keyset、圈子成员同步、推送 fanout、会话列表仍使用预期计划
  - 慢查询 p95/p99 没有回退
  - 新增索引有命中且没有明显写入开销或长期未使用
  - 必要时执行 `ANALYZE`，并记录调整前后的计划

  **证据：**

  ```text
  发布版本：
  观察窗口：
  查询/索引结果：
  异常与处理：
  ```

- [ ] **推送 checkpoint 并创建 PR**

  分别推送后端和前端 checkpoint 并创建 PR。前端现有 notes/login 等独立改动保持单独提交，不要混入数据库 review PR。

  - 后端 checkpoint：`c5eae4b perf: finish database review hot paths`
  - 前端 checkpoint：`8ea118f4 feat: consume cursor pagination for notifications`

  **证据：**

  ```text
  后端 PR：
  前端 PR：
  远端 commit SHA：
  review/checks：
  ```

- [ ] **把 migration status 和性能脚本纳入发布门禁**

  在 CI 或发布前检查中执行并保存结果：

  ```bash
  NODE_ENV=development npx prisma migrate status
  PERF_DB_REVIEW=1 npm run perf:db-review
  ```

  生产发布使用实际的迁移环境和只读/隔离性能数据库；不要把性能脚本指向生产数据库。

  **证据：**

  ```text
  CI/发布流程：
  检查运行链接或日志：
  失败处理：
  ```
