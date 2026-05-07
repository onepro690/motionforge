export interface NarratorSegmentState {
  index: number;
  text: string;
  visualPrompt: string;
  opName: string | null;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  videoUrl: string | null;
  errorMessage: string | null;
}

export interface NarratorJobState {
  kind: "narrator-v1";
  copy: string;
  voice: string;
  gender: "male" | "female";
  narrationAudioUrl: string;
  narrationDurationSeconds: number;
  segments: NarratorSegmentState[];
  finalVideoUrl: string | null;
  finalErrorMessage: string | null;
}
