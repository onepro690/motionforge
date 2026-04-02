import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import type { MotionJobData } from "./types";

export * from "./types";

export function createRedisConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

export function createMotionQueue(
  connection: ConnectionOptions
): Queue<MotionJobData> {
  return new Queue<MotionJobData>("motion-generation", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
}

export { Queue, Worker };
export type { ConnectionOptions };
