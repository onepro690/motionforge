import { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  const passwordHash = await hashPassword("12345678");

  const user = await prisma.user.upsert({
    where: { email: "progerio690@gmail.com" },
    update: {},
    create: {
      id: "test-user-001",
      name: "Progerio Test",
      email: "progerio690@gmail.com",
      emailVerified: true,
      accounts: {
        create: {
          id: "test-account-001",
          accountId: "test-user-001",
          providerId: "credential",
          password: passwordHash,
        },
      },
    },
  });

  console.log(`Test user created: ${user.email}`);
  console.log("  Email: progerio690@gmail.com");
  console.log("  Password: 12345678");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
