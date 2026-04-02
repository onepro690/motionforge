import { createMotionQueue, createRedisConnection } from "@motion/queue";

let _queue: ReturnType<typeof createMotionQueue> | null = null;

export function getMotionQueue() {
  if (!_queue) {
    const connection = createRedisConnection();
    _queue = createMotionQueue(connection);
  }
  return _queue;
}
