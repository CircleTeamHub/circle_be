import { PrismaClient } from '../src/generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/nestjs_dev_fresh?schema=public';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const NICKNAME = process.argv[2];
const LEVEL = Number(process.argv[3]);

async function main() {
  const users = await prisma.user.findMany({
    where: { nickname: NICKNAME },
    select: { id: true, nickname: true, phoneNumber: true, vipLevel: true },
  });

  if (users.length === 0) {
    console.log(`No user found with nickname "${NICKNAME}"`);
    return;
  }

  console.log('Matched users:', JSON.stringify(users, null, 2));

  if (users.length > 1) {
    console.log(`\n⚠ ${users.length} users share this nickname — not updating. Re-run targeting a specific id.`);
    return;
  }

  const updated = await prisma.user.update({
    where: { id: users[0].id },
    data: { vipLevel: LEVEL },
    select: { id: true, nickname: true, vipLevel: true },
  });
  console.log('\nUpdated:', JSON.stringify(updated, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
