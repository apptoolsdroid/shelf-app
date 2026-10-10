// ============================================================================
// The page-turn sound.
//
// Synthesised rather than shipped as an audio file: a paper rustle is
// broadband noise shaped by a filter sweep, which is a few lines of Web Audio
// and costs nothing to download. It also means every turn can be very
// slightly different — real paper never sounds identical twice, and a sample
// played over and over is the fastest way to make a nice touch irritating.
//
// The sound moves with the page: forward, it sweeps from the right ear to the
// left, following the leaf across the screen; back, the other way.
//
// Nothing here ever throws into the app. Audio is a flourish, and a browser
// that won't allow it, or a device with no output, must not break reading.
// ============================================================================

const PREF_KEY = "shelf.sound";

let ctx = null;
let master = null;
let noiseBuffer = null;
let enabled = load();

function load() {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch (_) {
    return true; // private browsing — on by default, same as everyone else
  }
}

export function isEnabled() {
  return enabled;
}

export function setEnabled(on) {
  enabled = !!on;
  try { localStorage.setItem(PREF_KEY, enabled ? "on" : "off"); } catch (_) {}
  return enabled;
}

export function toggle() {
  return setEnabled(!enabled);
}

// One second of noise, generated once and sampled from at a random offset on
// each turn. Pure white noise is too hissy to read as paper, so it's mixed
// with a slow-drifting (brown) component that gives it some body.
function buildNoise(context) {
  const len = Math.floor(context.sampleRate * 1.0);
  const buf = context.createBuffer(1, len, context.sampleRate);
  const data = buf.getChannelData(0);
  let drift = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    drift = (drift + 0.025 * white) / 1.025;
    data[i] = white * 0.7 + drift * 3.2;
  }
  return buf;
}

// Created on the first turn rather than at startup: browsers only allow audio
// to start from a user gesture, and turning a page is one.
function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 1.1;
  master.connect(ctx.destination);
  noiseBuffer = buildNoise(ctx);
  return ctx;
}

// One rustle: a band of noise whose centre frequency sweeps upward, panned
// across the stereo field in the direction the page is travelling.
function grain(now, { delay, dur, peak, from, to, panFrom, panTo }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  // A different slice of the noise each time, so repeated turns don't phase
  // into a recognisable loop.
  const offset = Math.random() * 0.8;

  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.9;
  band.frequency.setValueAtTime(from, now + delay);
  band.frequency.exponentialRampToValueAtTime(to, now + delay + dur);

  // Paper has no bottom end; without this the rustle booms on a tablet
  // speaker and sounds like wind rather than a page.
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 520;

  // And it has no sizzle either. Unrolled, bandpassed noise keeps far too
  // much top and comes out as a hiss or a cymbal; rolling off above this
  // moves the weight of the sound down into where paper actually lives.
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5200;
  lp.Q.value = 0.7;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, now + delay);
  env.gain.exponentialRampToValueAtTime(peak, now + delay + 0.014);
  env.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);

  let tail = env;
  if (ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(panFrom, now + delay);
    pan.pan.linearRampToValueAtTime(panTo, now + delay + dur);
    env.connect(pan);
    tail = pan;
  }

  src.connect(band).connect(hp).connect(lp).connect(env);
  tail.connect(master);
  src.start(now + delay, offset, dur + 0.05);
  src.stop(now + delay + dur + 0.05);
}

/**
 * Play a page turn.
 * @param {number} dir  +1 forward (sound travels right to left),
 *                      -1 back (left to right)
 */
export function playPageTurn(dir) {
  if (!enabled) return;
  try {
    if (!ensureContext()) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const now = ctx.currentTime;
    const forward = dir > 0;
    // The leaf starts on the side it lifts from and ends across the spine,
    // so the sound starts there too.
    const panFrom = forward ? 0.55 : -0.55;
    const panTo = forward ? -0.45 : 0.45;
    // A little variation per turn keeps it from sounding like a sample.
    const wobble = 0.9 + Math.random() * 0.2;

    // The swish of the page sweeping over.
    grain(now, {
      delay: 0, dur: 0.26 * wobble, peak: 0.55,
      from: 900, to: 2700 * wobble, panFrom, panTo,
    });
    // A quieter crinkle just behind it: the page is paper, not a cloth, and
    // this second layer is most of what makes it read that way.
    grain(now, {
      delay: 0.045, dur: 0.17 * wobble, peak: 0.3,
      from: 2100, to: 1250, panFrom: panFrom * 0.6, panTo: panTo * 0.6,
    });
    // The settle as it lands flat.
    grain(now, {
      delay: 0.17, dur: 0.1, peak: 0.16,
      from: 820, to: 580, panFrom: panTo, panTo,
    });
  } catch (_) {
    // No audio on this device, or the browser refused. Reading continues.
  }
}
