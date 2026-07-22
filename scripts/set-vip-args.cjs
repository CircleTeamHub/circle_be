'use strict';
// set-vip 的纯参数解析逻辑（#99）。抽成零依赖 CJS：
// - set-vip.mjs（ESM CLI）可静态 import；
// - jest（rootDir=src）用 src/scripts/set-vip-args.spec.ts 相对路径 require，
//   不用动 runner 配置 —— 此前 scripts/__tests__ 写了也永远不会被跑到。

function usage() {
  return 'Usage: DATABASE_URL=... node scripts/set-vip.mjs (--id <user-id> | --nickname <nickname>) <level 0..5>';
}

function parseArgs(argv) {
  let id;
  let nickname;
  let level;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--id') id = argv[++i];
    else if (arg === '--nickname') nickname = argv[++i];
    else if (level === undefined) level = arg;
    else throw new Error(usage());
  }
  if ((id && nickname) || (!id && !nickname)) throw new Error(usage());
  const parsedLevel = Number(level);
  if (!Number.isInteger(parsedLevel) || parsedLevel < 0 || parsedLevel > 5) {
    throw new Error('level must be an integer between 0 and 5');
  }
  return { id, nickname, level: parsedLevel };
}

module.exports = { parseArgs, usage };
