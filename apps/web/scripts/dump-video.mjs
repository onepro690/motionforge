import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const id = process.argv[2];
const v = await prisma.ugcGeneratedVideo.findUnique({
  where: { id },
  include: {
    product: { select: { name: true, thumbnailUrl: true, category: true, detectedVideos: { orderBy: { views: "desc" }, take: 1 } } },
    takes: { orderBy: { takeIndex: "asc" } },
  },
});
console.log(JSON.stringify(v, (k, val) => typeof val === "bigint" ? Number(val) : val, 2));
await prisma.$disconnect();
