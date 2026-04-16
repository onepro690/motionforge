export interface MotionJobData {
  jobId: string;
  userId: string;
  inputVideoUrl?: string;
  inputImageUrl: string;
  provider: string;
  promptText?: string;       // set for text-to-video jobs
  generatedPrompt?: string;  // expanded prompt from AI
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
