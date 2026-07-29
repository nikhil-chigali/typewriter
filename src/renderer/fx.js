'use strict';

// Pixel sparkles and pixel confetti. Pure DOM squares, no canvas.

const Fx = (() => {
  const layer = () => document.getElementById('fx');
  const CONFETTI = ['#C1443C', '#F5EDE0', '#FF8080', '#FFD700'];

  /** animationend never arrives if the window is occluded, so also sweep on a timer. */
  function reap(el, after) {
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), after);
  }

  /** Six sparkles bursting out of an element's centre. */
  function sparkle(el) {
    const host = layer();
    if (!host || !el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI * 2 * i) / 6 + Math.random() * 0.4;
      const dist = 12 + Math.random() * 10;
      const s = document.createElement('div');
      s.className = 'sparkle';
      s.style.left = `${Math.round(cx)}px`;
      s.style.top = `${Math.round(cy)}px`;
      s.style.setProperty('--dx', `${Math.round(Math.cos(angle) * dist)}px`);
      s.style.setProperty('--dy', `${Math.round(Math.sin(angle) * dist)}px`);
      host.appendChild(s);
      reap(s, 1500);
    }
  }

  /** Forty falling squares. */
  function confetti(count = 40) {
    const host = layer();
    if (!host) return;
    const h = window.innerHeight;

    for (let i = 0; i < count; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = `${Math.round(Math.random() * (window.innerWidth - 6))}px`;
      c.style.background = CONFETTI[i % CONFETTI.length];
      c.style.setProperty('--dy', `${h + 20}px`);
      c.style.setProperty('--dur', `${(1.1 + Math.random() * 1.1).toFixed(2)}s`);
      c.style.animationDelay = `${(Math.random() * 0.5).toFixed(2)}s`;
      host.appendChild(c);
      reap(c, 5000);
    }
  }

  return { sparkle, confetti };
})();
