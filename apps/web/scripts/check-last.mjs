import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const videos = await prisma.ugcGeneratedVideo.findMany({
  orderBy: { createdAt: "desc" },
  take: 5,
  include: { takes: { orderBy: { takeIndex: "asc" } } },
});
for (const v of videos) {
  console.log(`\n=== ${v.id}  status=${v.status}  created=${v.createdAt.toISOString()}`);
  if (v.errorMessage) console.log(`  ERROR: ${v.errorMessage.slice(0, 400)}`);
  console.log(`  finalVideoUrl: ${v.finalVideoUrl ?? "(null)"}`);
  for (const t of v.takes) {
    console.log(`  take ${t.takeIndex}: ${t.status}  retries=${t.retryCount}  err=${(t.errorMessage ?? "").slice(0, 200)}`);
  }
}
await prisma.$disconnect();
