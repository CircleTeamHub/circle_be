# Database Review Release TODO

这份清单记录数据库 review 和通知游标分页已经完成后，正式上线前需要补做的验证。完成每项后把命令、环境、时间和关键结果补在对应的「证据」位置。

## 上线前检查

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
