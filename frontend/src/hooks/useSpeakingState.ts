import { useEffect, useState } from "react";

/**
 * 根据音频流实时估算“是否正在说话”。
 */
export function useSpeakingState(stream: MediaStream | null, enabled: boolean) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!stream || !enabled) {
      setSpeaking(false);
      return;
    }

    const [audioTrack] = stream.getAudioTracks();
    if (!audioTrack) {
      setSpeaking(false);
      return;
    }

    let frame = 0;
    let cancelled = false;
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    source.connect(analyser);

    const readLevel = () => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const centered = (buffer[index] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / buffer.length);
      setSpeaking(rms > 0.045);
      frame = window.requestAnimationFrame(readLevel);
    };

    void audioContext.resume().catch(() => undefined);
    frame = window.requestAnimationFrame(readLevel);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close().catch(() => undefined);
    };
  }, [stream, enabled]);

  return speaking;
}
