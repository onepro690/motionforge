/**
 * Next.js instrumentation hook — called once when the server starts.
 * Starts the BullMQ worker inline so no separate terminal is needed.
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only run locally (not on Vercel) — serverless functions hibernate
  // and can't maintain a persistent BullMQ worker connection.
  // webpackIgnore prevents Next.js from tracing inline-worker deps into
  // the serverless bundle (avoids exceeding the 250 MB function size limit).
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    const { startInlineWorker } = await import(
      /* webpackIgnore: true */ "./lib/inline-worker"
    );
    startInlineWorker();
  }
}
