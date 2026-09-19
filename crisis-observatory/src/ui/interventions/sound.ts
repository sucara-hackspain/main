import { useCallback, useState } from "react";

const MUTED = "alerta:avisos-silenciados";
let context: AudioContext | null = null;

/** Two short falling tones, like a pager. Browsers allow it once the operator has used the page. */
function page() {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") context.resume().catch(() => {});
    const start = context.currentTime;
    [880, 660].forEach((hz, i) => {
      const tone = context!.createOscillator(),
        gain = context!.createGain(),
        at = start + i * 0.17;
      tone.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      tone.connect(gain).connect(context!.destination);
      tone.start(at);
      tone.stop(at + 0.16);
    });
  } catch {
    // No audio output: the visual alert still shows.
  }
}

export function useAlertSound() {
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTED) === "1";
    } catch {
      return false;
    }
  });
  function toggle() {
    setMuted(!muted);
    try {
      if (muted) localStorage.removeItem(MUTED);
      else localStorage.setItem(MUTED, "1");
    } catch {
      // Blocked storage: the choice lasts until the page reloads.
    }
  }
  const chime = useCallback(() => {
    if (!muted) page();
  }, [muted]);
  return { muted, toggle, chime };
}
