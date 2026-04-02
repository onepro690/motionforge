export * from "./types";
export * from "./local.storage";
export * from "./s3.storage";

import { LocalStorageProvider } from "./local.storage";
import { S3StorageProvider } from "./s3.storage";
import type { StorageProvider } from "./types";

export function createStorageProvider(): StorageProvider {
  const type = process.env.STORAGE_TYPE ?? "local";

  if (type === "s3") {
    return new S3StorageProvider({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      region: process.env.AWS_REGION ?? "us-east-1",
      bucket: process.env.AWS_BUCKET_NAME!,
      endpoint: process.env.AWS_ENDPOINT_URL,
      publicUrl: process.env.STORAGE_PUBLIC_URL,
    });
  }

  return new LocalStorageProvider(
    process.env.STORAGE_LOCAL_PATH ?? "./uploads",
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  );
}
