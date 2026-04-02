export interface MotionJobData {
  jobId: string;
  userId: string;
  inputVideoUrl: string;
  inputImageUrl: string;
  provider: string;
  config: {
    aspectRatio: string;
    resolution: string;
    maxDuration: number;
    motionStrength: number;
    identityStrength: number;
    facePreserveStrength: number;
    backgroundMode: string;
  };
}

export const MOTION_QUEUE_NAME = "motion-generation";
