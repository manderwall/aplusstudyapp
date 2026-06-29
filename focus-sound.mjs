// focus-sound.mjs — built-in white / pink / brown noise generator via Web Audio.
// No downloads, no tracking. Self-contained: setSound(type) is the only entry
// point; pass 'off' | 'white' | 'pink' | 'brown'.

let _audioCtx = null;
let _audioSrc = null;
let _audioGain = null;

function generateNoiseBuffer(ctx, type) {
  const size = 2 * ctx.sampleRate;  // 2 seconds, looped
  const buf = ctx.createBuffer(1, size, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (type === 'white') {
    for (let i = 0; i < size; i++) d[i] = Math.random() * 2 - 1;
  } else if (type === 'pink') {
    // Voss-McCartney approximation — cheap, good enough
    let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
    for (let i = 0; i < size; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < size; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

export function setSound(type) {
  if (_audioSrc) { try { _audioSrc.stop(); } catch {} _audioSrc = null; }
  if (type === 'off') return;
  if (!_audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    _audioCtx = new Ctor();
  }
  _audioCtx.resume();
  if (!_audioGain) {
    _audioGain = _audioCtx.createGain();
    _audioGain.gain.value = 0.15;
    _audioGain.connect(_audioCtx.destination);
  }
  const src = _audioCtx.createBufferSource();
  src.buffer = generateNoiseBuffer(_audioCtx, type);
  src.loop = true;
  src.connect(_audioGain);
  src.start();
  _audioSrc = src;
}
