'use strict';

// Lazily-initialised Web Audio square-wave blips. Muting silences everything.

const Sound = (() => {
  let ctx = null;
  let muted = false;

  function context() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function blip(freq, at = 0, dur = 0.06, gain = 0.05) {
    if (muted) return;
    const ac = context();
    if (!ac) return;

    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const vol = ac.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, t);
    vol.gain.setValueAtTime(gain, t);
    vol.gain.setValueAtTime(gain, t + dur * 0.7);
    vol.gain.linearRampToValueAtTime(0.0001, t + dur);

    osc.connect(vol).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  return {
    setMuted(v) { muted = !!v; },
    isMuted() { return muted; },

    /** One key strike while the paper prints. */
    print() { blip(600 + Math.random() * 200, 0, 0.035, 0.04); },

    check() { blip(880); blip(1100, 0.07); },

    uncheck() { blip(440, 0, 0.08); },

    complete() {
      [880, 1100, 1320, 1760].forEach((f, i) => blip(f, i * 0.11, 0.1, 0.06));
    },
  };
})();
