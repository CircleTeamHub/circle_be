#!/usr/bin/env bash
# 异地备份:把 release-deploy.sh 刚生成的 pg_dump 加密后送到主机之外。
#
# 这个文件**只定义函数**,由 deploy/release-deploy.sh source 进去;直接执行它
# 不会有任何副作用。拆出来的原因:release-deploy.sh 是生产关键路径,任何 bug
# 都会挡住每一次发版 —— 这里的逻辑因此单独成文件,可以被 test 脚本 source
# 进去做真实的「加密 → 上传 → 销毁 → 下载 → 解密 → 还原」往返验证。
#
# ── 解决的问题 ──────────────────────────────────────────────────
# 本地备份目录 ~/circle_be_backups/ 和 pg_data 卷在同一台 VPS 上:磁盘损坏、
# 实例丢失、主机被入侵会把数据和备份一起带走。本文件负责再放一份到别处。
# 本地备份本身仍然是迁移安全网,顺序、命名、7 份保留策略都不受影响。
#
# ── opt-in ──────────────────────────────────────────────────────
# 没配置目标存储桶时整个流程静默跳过,输出与配置前逐字节一致。
#
# ── 配置 ────────────────────────────────────────────────────────
# 环境变量优先;否则从 $HOME/.circle_be_backup.env 读(见
# deploy/backup.env.example,操作步骤见 DEPLOY.md §6「异地备份」)。
#
#   BACKUP_OFFSITE_S3_BUCKET        必填,配了才启用
#   BACKUP_OFFSITE_AGE_RECIPIENTS   必填,age 公钥(age1...),空格分隔可多个
#   AWS_ACCESS_KEY_ID               必填,只写凭证(不能是应用的 MinIO 凭证)
#   AWS_SECRET_ACCESS_KEY           必填
#   BACKUP_OFFSITE_S3_ENDPOINT      选填,R2/MinIO/B2 等非 AWS 端点
#   BACKUP_OFFSITE_S3_PREFIX        选填,默认 circle_be
#   BACKUP_OFFSITE_S3_REGION        选填,默认 auto(AWS S3 要填真实 region)
#   BACKUP_OFFSITE_TIMEOUT_SECONDS  选填,默认 900
#   BACKUP_OFFSITE_ENV_FILE         选填,配置文件路径(测试用)

# 配置文件:放在仓库之外。发版的 rsync --delete 会清掉仓库目录里的陌生文件,
# 而 $HOME 不在同步范围内;顺带也不会进 git、不会进 docker compose 的插值命名空间。
OFFSITE_ENV_FILE_DEFAULT="$HOME/.circle_be_backup.env"

# 取一个配置项:环境变量优先,其次配置文件。
#
# 只做 KEY=VALUE 解析,**不 source** —— 配置文件不该有能力执行代码,更不该
# 有能力覆盖 release-deploy.sh 自己的变量(live / standby / backup_dir 之类,
# 被改写会直接破坏蓝绿切换)。和 release-deploy.sh 里 smoke() 读 .env 取
# API_DOMAIN 是同一套写法。
offsite_cfg() {
  local key="$1" file value
  if [ -n "${!key:-}" ]; then
    printf '%s\n' "${!key}"
    return 0
  fi
  file="${BACKUP_OFFSITE_ENV_FILE:-$OFFSITE_ENV_FILE_DEFAULT}"
  [ -r "$file" ] || return 0
  value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s\n' "$value"
}

# 记录结果并发出信号。
#   offsite_report <备份目录> ok|failed <详情>
#
# 失败时**不中断发版**,但必须吵。理由见 ship_backup_offsite 的注释。
offsite_report() {
  local dir="$1" state="$2" detail="$3" stamp
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # 留一份状态,让「上一次异地备份成功是什么时候」这个问题事后可查。
  printf '%s %s %s\n' "$state" "$stamp" "$detail" >"$dir/.offsite-status" 2>/dev/null || true

  if [ "$state" = ok ]; then
    echo "==> Off-host backup uploaded: $detail"
    return 0
  fi

  {
    echo ""
    echo "################################################################"
    echo "## OFF-HOST BACKUP UPLOAD FAILED"
    echo "##   $detail"
    echo "##"
    echo "## The local pre-migration dump SUCCEEDED and is intact in"
    echo "##   $dir"
    echo "## so the migration rollback path is unaffected and this deploy"
    echo "## continues. But this host currently has NO off-site copy of"
    echo "## the database: losing the VPS now loses the data."
    echo "## Fix before the next release — DEPLOY.md §6「异地备份」."
    echo "################################################################"
    echo ""
  } >&2

  # GitHub Actions 会把 stdout 里的 workflow command 变成 run 摘要页上的红色
  # annotation —— 一行代价,把「淹没在绿色日志里的一句话」变成点进去就能看见
  # 的告警,同时不会让 job 变红(job 状态只看退出码)。不在 Actions 里跑时它
  # 只是多打印一行,无副作用。
  echo "::error title=Off-host backup upload failed (deploy continued)::$detail"
  return 0
}

# 把一份本地备份加密后上传。
#   ship_backup_offsite <本地 .sql.gz 路径>
#
# ── 失败策略:继续发版,但吵 ────────────────────────────────────
# 走到这一步时本地 pg_dump 已经成功 —— 这次发版真正需要的安全网(迁移改坏
# 数据后能回滚)已经就位。异地副本防的是另一件事:整台 VPS 没了。那件事和
# 「这次发版」不相关,拦下发版并不会让它变得更安全,只会把一次紧急修复推迟到
# 云存储恢复之后。反过来,静默烂掉的风险用「吵」来解决:醒目 banner +
# Actions annotation + .offsite-status 状态文件。
#
# 配置错误(密钥没填、age 没装)同样只警告不中断:统一的心智模型比多一种能
# 挡住发版的失败方式更值钱。第一次配完就会在日志里看到,不会拖到几个月后。
ship_backup_offsite() {
  local src="$1"
  local dir bucket recipients access_key secret_key endpoint prefix region
  local timeout_secs enc_dir enc_file object_key recipient tool
  local -a recipient_list=() age_args=() aws_args=() runner=()

  dir="$(dirname "$src")"

  bucket="$(offsite_cfg BACKUP_OFFSITE_S3_BUCKET)"
  # 没配目标 → 完全跳过。这是既有部署的默认路径,必须零输出零副作用。
  [ -n "$bucket" ] || return 0

  recipients="$(offsite_cfg BACKUP_OFFSITE_AGE_RECIPIENTS)"
  access_key="$(offsite_cfg AWS_ACCESS_KEY_ID)"
  secret_key="$(offsite_cfg AWS_SECRET_ACCESS_KEY)"
  endpoint="$(offsite_cfg BACKUP_OFFSITE_S3_ENDPOINT)"
  prefix="$(offsite_cfg BACKUP_OFFSITE_S3_PREFIX)"
  region="$(offsite_cfg BACKUP_OFFSITE_S3_REGION)"
  timeout_secs="$(offsite_cfg BACKUP_OFFSITE_TIMEOUT_SECONDS)"
  # 容忍 "backups/" / "/backups" 这类很自然的写法,别让 key 里出现 // 空段。
  while [ "${prefix#/}" != "$prefix" ]; do prefix="${prefix#/}"; done
  while [ "${prefix%/}" != "$prefix" ]; do prefix="${prefix%/}"; done
  prefix="${prefix:-circle_be}"
  region="${region:-auto}"
  timeout_secs="${timeout_secs:-900}"

  if [ -z "$recipients" ]; then
    offsite_report "$dir" failed \
      "BACKUP_OFFSITE_AGE_RECIPIENTS is unset; refusing to upload an unencrypted database dump"
    return 1
  fi
  if [ -z "$access_key" ] || [ -z "$secret_key" ]; then
    offsite_report "$dir" failed \
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are unset for the backup destination"
    return 1
  fi
  for tool in age aws; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      offsite_report "$dir" failed "$tool is not installed on this host"
      return 1
    fi
  done

  # 只接受 age 公钥。误把私钥填进来是最危险的操作失误 —— 那等于把解密能力
  # 放回了这台随时可能被入侵的主机上,异地副本的意义当场归零。
  read -r -a recipient_list <<<"$recipients"
  for recipient in "${recipient_list[@]}"; do
    case "$recipient" in
      AGE-SECRET-KEY-*)
        offsite_report "$dir" failed \
          "BACKUP_OFFSITE_AGE_RECIPIENTS contains an age PRIVATE key; this host must only ever hold public keys"
        return 1
        ;;
      age1*) age_args+=(-r "$recipient") ;;
      *)
        offsite_report "$dir" failed "not a valid age recipient (expected age1...): $recipient"
        return 1
        ;;
    esac
  done

  # 先完整加密成文件再上传,不做 age | aws 流式管道:管道里 age 中途失败时
  # aws 只会看到 EOF,把已经收到的部分当成完整对象上传成功 —— 桶里会静静躺着
  # 一份截断的备份。多花一份磁盘换「上传的要么是完整的,要么根本没上传」。
  # 落在备份目录同一个文件系统上:/tmp 在小机器上常是 tmpfs,几 GB 的 dump
  # 写进去就是吃内存。目录名以 . 开头,不会被 circle-*.sql.gz 的保留策略扫到。
  if ! enc_dir="$(mktemp -d "$dir/.offsite.XXXXXX")"; then
    offsite_report "$dir" failed "could not create a staging directory under $dir"
    return 1
  fi
  enc_file="$enc_dir/$(basename "$src").age"

  if ! age "${age_args[@]}" -o "$enc_file" "$src"; then
    rm -rf "$enc_dir"
    offsite_report "$dir" failed "age encryption failed"
    return 1
  fi

  object_key="$prefix/$(basename "$enc_file")"
  aws_args=(s3 cp "$enc_file" "s3://$bucket/$object_key" --only-show-errors --region "$region")
  if [ -n "$endpoint" ]; then
    aws_args+=(--endpoint-url "$endpoint")
  fi
  # 上传卡住不能把发版一起拖住 —— 「不阻断发版」的前提是它真的不会阻断。
  if command -v timeout >/dev/null 2>&1; then
    runner=(timeout "$timeout_secs")
  fi

  echo "==> Shipping encrypted backup to s3://$bucket/$object_key"
  # 凭证只进这个子 shell 的环境,不落到脚本全局 —— 后面还要跑 docker compose,
  # 备份凭证没有任何理由出现在应用容器或 compose 的环境里。也不走 argv,
  # 和脚本处理 GHCR_TOKEN 的做法一致。
  if ! (
    export AWS_ACCESS_KEY_ID="$access_key"
    export AWS_SECRET_ACCESS_KEY="$secret_key"
    # 云上元数据服务探测在自建 VPS 上只会白等一轮超时。
    export AWS_EC2_METADATA_DISABLED=true
    if [ -n "$endpoint" ]; then
      # AWS CLI v2.23+ 默认给请求加 CRC32 trailer,R2 / 老版本 MinIO 会直接
      # 拒绝。非 AWS 端点退回「协议要求时才算 checksum」。
      export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
    fi
    "${runner[@]}" aws "${aws_args[@]}"
  ); then
    rm -rf "$enc_dir"
    offsite_report "$dir" failed "upload to s3://$bucket/$object_key failed"
    return 1
  fi

  rm -rf "$enc_dir"
  offsite_report "$dir" ok "s3://$bucket/$object_key"
}
