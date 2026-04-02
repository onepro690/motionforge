import "dotenv/config";
import { Worker } from "bullmq";
import { createRedisConnection, MOTION_QUEUE_NAME } from "@motion/queue";
import { processMotionJob } from "./processors/motion-job.processor";

const connection = createRedisConnection();

console.log("Motion Transfer Worker starting...");
console.log(
  `Connecting to Redis: ${process.env.REDIS_URL ?? "redis://localhost:6379"}`
);
console.log(`AI Provider: ${process.env.AI_PROVIDER ?? "mock"}`);

const worker = new Worker(MOTION_QUEUE_NAME, processMotionJob, {
  connection,
  concurrency: 2,
  limiter: {
    max: 5,
    duration: 60000,
  },
});

worker.on("active", (job) => {
  console.log(`Job ${job.id} (${job.data.jobId}) started`);
});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} (${job.data.jobId}) completed`);
});

worker.on("failed", (job, error) => {
  console.error(
    `Job ${job?.id} (${job?.data.jobId}) failed:`,
    error.message
  );
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

// Graceful shutdown
const shutdown = async () => {
  console.log("\nWorker shutting down...");
  await worker.close();
  await connection.quit();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("Worker ready, listening for jobs...");
