import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const id = process.argv[2];
const v = await prisma.ugcGeneratedVideo.findUnique({
  where: { id },
  include: { takes: { orderBy: { takeIndex: "asc" } } },
});
console.log(`status=${v.status}`);
console.log(`final=${v.finalVideoUrl}`);
console.log(`audio=${v.audioUrl}`);
console.log(`duration=${v.durationSeconds}`);
for (const t of v.takes) {
  console.log(`\ntake ${t.takeIndex}: ${t.status}  dur=${t.durationSeconds}`);
  console.log(`  videoUrl: ${t.videoUrl}`);
}
await prisma.$disconnect();
