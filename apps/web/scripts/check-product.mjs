import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const videoId = process.argv[2];
const v = await prisma.ugcGeneratedVideo.findUnique({
  where: { id: videoId },
  select: { id: true, productId: true, product: { select: { id: true, name: true } } },
});
console.log("video:", v);
await prisma.$disconnect();
