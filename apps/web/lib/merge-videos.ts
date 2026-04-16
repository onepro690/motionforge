/**
 * Merge multiple video files into one using Canvas + MediaRecorder (pure browser APIs).
 * Plays each video sequentially on a canvas and records the output.
 * No external libraries or WASM required.
 */
export async function mergeVideosClient(
  files: File[],
  onProgress: (pct: number, label: string) => void,
  trims?: Array<{ start: number; end: number }>,
  speeds?: number[]  // per-clip speed multiplier (default 1 = normal)
): Promise<Blob> {
  onProgress(5, "Lendo vídeos...");

  const videos = await Promise.all(
    files.map(
      (file) =>
        new Promise<HTMLVideoElement>((resolve, reject) => {
          const v = document.createElement("video");
          v.preload = "metadata";
          v.muted = true;
          v.src = URL.createObjectURL(file);
          v.onloadedmetadata = () => resolve(v);
          v.onerror = () => reject(new Error(`Falha ao ler ${file.name}`));
        })
    )
  );

  const w = videos[0].videoWidth || 1280;
  const h = videos[0].videoHeight || 720;
  // Total output duration accounts for speed (faster = shorter output)
  const totalDuration = videos.reduce((s, v, i) => {
    const ts = trims?.[i]?.start ?? 0;
    const te = trims?.[i]?.end ?? 0;
    const spd = speeds?.[i] ?? 1;
    return s + Math.max(0, (v.duration || 0) - ts - te) / spd;
  }, 0);

  onProgress(10, "Configurando exportação...");

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  // Pick best supported codec — prefer H.264/MP4, fall back to VP9/webm
  const mimeType = MediaRecorder.isTypeSupported("video/mp4;codecs=avc1")
    ? "video/mp4;codecs=avc1"
    : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";

  // High framerate capture — 60fps canvas stream to not lose frames on fast clips
  const stream = canvas.captureStream(60);

  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  videos.forEach((v) => {
    try {
      audioCtx.createMediaElementSource(v).connect(dest);
    } catch {
      // ignore
    }
  });
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  // High bitrate: 40 Mbps video + 320 kbps audio → near-lossless output
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 40_000_000,  // 40 Mbps
    audioBitsPerSecond: 320_000,     // 320 kbps
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise<Blob>((resolve, reject) => {
    let elapsed = 0;
    let currentIdx = 0;

    recorder.onstop = () => {
      audioCtx.close();
      videos.forEach((v) => URL.revokeObjectURL(v.src));
      resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
    };

    recorder.onerror = (e) => reject(new Error(String(e)));

    function drawLoop() {
      const v = videos[currentIdx];
      if (!v || v.paused) return;

      const trimEnd = trims?.[currentIdx]?.end ?? 0;
      const endAt = v.duration - trimEnd;

      // If we've reached the trim end point, manually advance
      if (v.currentTime >= endAt) {
        v.pause();
        const trimStart = trims?.[currentIdx]?.start ?? 0;
        const spd = speeds?.[currentIdx] ?? 1;
        elapsed += Math.max(0, endAt - trimStart) / spd;
        currentIdx++;
        playNext();
        return;
      }

      ctx.drawImage(v, 0, 0, w, h);
      // Progress accounts for speed-adjusted duration
      const trimStart = trims?.[currentIdx]?.start ?? 0;
      const spd = speeds?.[currentIdx] ?? 1;
      const progressInClip = (v.currentTime - trimStart) / spd;
      const pct = Math.min(95, 10 + Math.round(((elapsed + progressInClip) / totalDuration) * 85));
      onProgress(pct, `Processando vídeo ${currentIdx + 1} de ${videos.length}...`);
      requestAnimationFrame(drawLoop);
    }

    function playNext() {
      if (currentIdx >= videos.length) {
        recorder.stop();
        return;
      }
      const v = videos[currentIdx];
      const trimStart = trims?.[currentIdx]?.start ?? 0;
      const spd = speeds?.[currentIdx] ?? 1;
      v.muted = false;
      v.playbackRate = spd;   // ← applies speed during recording
      v.currentTime = trimStart;
      v.onended = () => {
        const ts = trims?.[currentIdx]?.start ?? 0;
        const te = trims?.[currentIdx]?.end ?? 0;
        const s = speeds?.[currentIdx] ?? 1;
        elapsed += Math.max(0, (v.duration || 0) - ts - te) / s;
        currentIdx++;
        playNext();
      };
      v.onerror = () => reject(new Error(`Erro ao reproduzir vídeo ${currentIdx + 1}`));
      v.play().then(drawLoop).catch(reject);
    }

    recorder.start(100);
    playNext();
  });
}
