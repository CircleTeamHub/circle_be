import { PrismaClient } from '../src/generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { parseArgs, usage } from './set-vip-args.cjs';

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(`DATABASE_URL is required. ${usage()}`);
  }
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    const users = args.id
      ? await prisma.user.findMany({
          where: { id: args.id },
          select: {
            id: true,
            nickname: true,
            phoneNumber: true,
            vipLevel: true,
          },
        })
      : await prisma.user.findMany({
          where: { nickname: args.nickname },
          select: {
            id: true,
            nickname: true,
            phoneNumber: true,
            vipLevel: true,
          },
        });

    if (users.length === 0) {
      console.log(
        `No user found ${args.id ? `with id "${args.id}"` : `with nickname "${args.nickname}"`}`,
      );
      return;
    }
    if (users.length > 1) {
      console.log(
        `⚠ ${users.length} users share this nickname — not updating.`,
      );
      return;
    }
    const updated = await prisma.user.update({
      where: { id: users[0].id },
      data: { vipLevel: args.level },
      select: { id: true, nickname: true, vipLevel: true },
    });
    console.log('Updated:', JSON.stringify(updated, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
