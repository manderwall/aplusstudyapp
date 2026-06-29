// read-aloud.mjs — Web Speech API "Listen" feature. Speaks the question,
// lettered options, and (once revealed) the correct answer + explanation.
// Toggles off on a second click, cancels on card change, hides itself when
// speechSynthesis isn't available.
//
// Depends on core (state) + lib (shuffleOptionsForCard) + wake-lock, plus two
// app callbacks — filteredQuestions() and getQuestion() — injected via
// initReadAloud() so this module never imports app.js (no circular dependency).

import { state } from './core.mjs';
import { shuffleOptionsForCard } from './lib.mjs';
import { acquireWakeLock } from './wake-lock.mjs';

// App-provided lookups, wired by initReadAloud() at startup.
let _filteredQuestions = () => [];
let _getQuestion = (q) => q;
export function initReadAloud({ filteredQuestions, getQuestion }) {
  if (filteredQuestions) _filteredQuestions = filteredQuestions;
  if (getQuestion) _getQuestion = getQuestion;
}

const speech = {
  supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
  speakingForQ: null,   // question id currently being read, or null
  voice: null,           // cached preferred voice
};

function speechSupported() {
  return speech.supported && window.speechSynthesis;
}

// Pick the best available English voice. Quality varies a lot by OS.
// Preference order:
//   1. Apple's "Samantha" / "Alex" / "Daniel" — high-quality neural voices
//   2. Google's "Google US/UK English" voices on Android Chrome
//   3. Microsoft's "Aria" / "Jenny" / "Guy" neural voices on Edge/Windows
//   4. Any en-US / en-GB local voice
//   5. Anything English
const PREFERRED_VOICES = [
  // Apple
  /samantha/i, /^alex$/i, /^daniel$/i, /^karen$/i, /^moira$/i, /^tessa$/i,
  // Google (Android)
  /google.*us.*english/i, /google.*uk.*english.*female/i, /google.*english/i,
  // Microsoft Neural (Windows / Edge)
  /microsoft\s+(aria|jenny|sonia|guy|davis|jane)\b.*natural/i,
  /microsoft\s+(aria|jenny|sonia|guy|davis|jane)\b/i,
];
function pickBestVoice() {
  if (!speechSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Try each preference in order
  for (const pat of PREFERRED_VOICES) {
    const v = voices.find(v => pat.test(v.name) && v.lang.toLowerCase().startsWith('en'));
    if (v) return v;
  }
  // Local en-US over remote, then en-GB local, then any English
  const localEnUS = voices.find(v => v.lang === 'en-US' && v.localService);
  if (localEnUS) return localEnUS;
  const localEnGB = voices.find(v => v.lang === 'en-GB' && v.localService);
  if (localEnGB) return localEnGB;
  const anyEn = voices.find(v => v.lang.toLowerCase().startsWith('en'));
  return anyEn || voices[0];
}
// Voices load asynchronously on most browsers; refresh the cache when they arrive.
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { speech.voice = pickBestVoice(); };
}

function syncListenButton(speaking) {
  const btn = document.getElementById('listen-btn');
  if (!btn) return;
  btn.textContent = speaking ? '⏹' : '🔈';
  btn.setAttribute('aria-pressed', speaking ? 'true' : 'false');
  btn.title = speaking ? 'Stop reading' : 'Listen — read the card aloud';
}

export function stopSpeaking() {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  speech.speakingForQ = null;
  syncListenButton(false);
}

function currentSpeakableCard() {
  // Returns the question object the user is currently looking at, if any.
  if (state.mode === 'study') {
    const qs = _filteredQuestions();
    const baseQ = qs[state.currentIndex];
    return baseQ ? { q: _getQuestion(baseQ), revealed: state.revealed } : null;
  }
  if (state.mode === 'quiz' && state.quizSession && !state.quizSession.done) {
    const baseQ = state.quizSession.questions[state.quizSession.current];
    if (!baseQ) return null;
    const q = _getQuestion(baseQ);
    const answered = state.quizSession.answers[q.id];
    return { q, revealed: !!answered };
  }
  return null;
}

function speakCard(q, { revealed } = {}) {
  if (!speechSupported()) return;
  // Toggle off if tapping while speaking the same card
  if (speech.speakingForQ === q.id) { stopSpeaking(); return; }
  stopSpeaking();
  if (!speech.voice) speech.voice = pickBestVoice();

  const LETTERS = 'ABCDEFGHIJ';
  const options = shuffleOptionsForCard(q.options || [], q.id);
  const parts = [q.question];
  if (options.length) {
    parts.push(
      options.map((o, i) => `Option ${LETTERS[i] || i + 1}: ${o}`).join('. ')
    );
  }
  if (revealed) {
    if (q.correct_short) parts.push(`Correct answer: ${q.correct_short}.`);
    if (Array.isArray(q.correct_picks) && q.correct_picks.length) {
      parts.push(`Correct answers: ${q.correct_picks.join(', ')}.`);
    }
    if (q.explanation) {
      parts.push(q.explanation.replace(/^OBJ \d+\.\d+:\s*/i, '').trim());
    }
  }
  const text = parts.join('. ');
  const utter = new SpeechSynthesisUtterance(text);
  if (speech.voice) {
    utter.voice = speech.voice;
    utter.lang = speech.voice.lang;
  }
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.onend = () => {
    if (speech.speakingForQ === q.id) stopSpeaking();
  };
  utter.onerror = () => stopSpeaking();
  speech.speakingForQ = q.id;
  window.speechSynthesis.speak(utter);
  syncListenButton(true);
  acquireWakeLock();
}

// Wire up the persistent top-bar Listen button (works in study + quiz modes,
// stays available in focus mode since it's in the header, not the card).
export function installListenButton() {
  const btn = document.getElementById('listen-btn');
  if (!btn) return;
  if (!speechSupported()) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.addEventListener('click', () => {
    const cur = currentSpeakableCard();
    if (!cur) return;
    speakCard(cur.q, { revealed: cur.revealed });
  });
}
