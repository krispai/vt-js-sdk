# Krisp VT JS SDK

[![npm version](https://img.shields.io/npm/v/@krisp.ai/krisp-vt-sdk)](https://www.npmjs.com/package/@krisp.ai/krisp-vt-sdk)
[![CI](https://github.com/krispai/vt-js-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/krispai/vt-js-sdk/actions/workflows/ci.yml)

Real-time voice translation SDK powered by Krisp AI. Streams PCM16 audio over a raw WebSocket, receives synthesised translated speech back on the same connection, and emits it as a `MediaStream` ready for playback or publishing.

## Features

- Real-time speech translation over a raw WebSocket (PCM16 @ 16 kHz)
- **Click-free playback out of the box** — translated audio is delivered as a ready-to-play `MediaStream`. Just `audio.srcObject = stream`. No extra `AudioContext`, mixer, or jitter-buffer code on your side. ([details](#audio-output--jitter-buffer))
- **Raw PCM access** for advanced consumers (recording, custom mixing, native playback) via the `onRawAudioChunk` hook
- Source and translated transcript events (interim and final)
- Custom vocabulary and translation dictionary for domain-specific accuracy
- Server-side background voice cancellation
- Male and female voice options
- Pluggable hooks for audio, transcripts, errors, and connection events
- Structured error types aligned with the Krisp API error codes

## Requirements

- Node.js 18+ (20+ recommended)
- A modern browser with `WebSocket`, `AudioContext`, and `getUserMedia` support
- `AudioWorklet` support and a secure context (HTTPS or `localhost`) for off-main-thread audio. Without them — or under a CSP that blocks `blob:` — the SDK automatically falls back to `ScriptProcessorNode` for both capture and playback.

---

## Installation

```bash
npm i @krisp.ai/krisp-vt-sdk
```

**`package.json`:**

```json
{
  "dependencies": {
    "@krisp.ai/krisp-vt-sdk": "^1.1.1"
  }
}
```

The package ships ESM with TypeScript declarations and zero runtime dependencies.

---

## Basic Usage

```javascript
import { KrispVTSDK, LogLevel } from '@krisp.ai/krisp-vt-sdk';

const sdk = new KrispVTSDK({
  apiKey: 'your-krisp-api-key',
  logLevel: LogLevel.WARN,
});

sdk.setHooks({
  onProcessedAudio: (stream) => {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play();
  },
  onTranscript: (e) => {
    // Source-language text — see "Server Events" section
    console.log('Transcript:', e.text, e.final);
  },
  onError: (error) => {
    console.error('SDK error:', error.code, error.message);
  },
});

// Connect WebSocket and wait for "ready"
await sdk.start({
  from: 'en-US',
  to: 'es-ES',
  voice: 'female',
});

// Capture microphone and start streaming PCM16 audio
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
await sdk.process(mic);

// Stop and clean up
await sdk.stop();
```

---

## Authentication

The SDK authenticates with a single Krisp API key. Pass it to the constructor and the SDK uses it for both the REST call and the WebSocket — there is nothing else to configure.

```javascript
const sdk = new KrispVTSDK({ apiKey: 'krisp_…' });
```

### Where the key is sent

| Call | Endpoint | How the key travels |
|------|----------|---------------------|
| `getLanguagesList()` | `GET https://api.developers.krisp.ai/v2/sdk/voice-translation/languages` | `Authorization: API-key <key>` request header |
| `start()` | `wss://streaming.krisp.ai/vt` | `?authorization=Api-Key%20<key>` query parameter |

The scheme word is **case-insensitive** on the Krisp side — `API-Key`, `API-key`, `Api-Key` and `api-key` are all accepted. That is why the two calls above spell it differently and both work; use whichever casing you prefer in your own code.

### The key is visible to your users

The API key is embedded in your browser bundle, and it appears verbatim in the WebSocket URL — anyone can read it from the Network panel of their devtools. A long-lived API key shipped to a browser is a long-lived credential you have handed to your users.

If that is not acceptable for your deployment, mint short-lived session tokens on your own server and hand those to the browser instead.

---

## Audio Output & Jitter Buffer

The SDK exposes translated audio as a `MediaStream` (`onProcessedAudio`) that you can attach directly to an `<audio>` element. **You don't need to wrap it in your own `AudioContext`, add gain nodes, or build a queue** — the SDK does that internally.

### How it works

The output is rendered by a dedicated `AudioContext({ sampleRate: 16000 })` connected to a `MediaStreamAudioDestinationNode`. Incoming PCM16 chunks from the WebSocket are decoded to Float32 and pushed into a sample queue; a render node pulls from that queue at the audio clock rate, which decouples the irregular WebSocket arrival cadence from the smooth render clock.

The render node is an **AudioWorklet**, so playback is pulled on the audio thread rather than the main thread — a long task on the main thread delays a queue refill instead of dropping samples at the audio deadline. Because a worklet must fill its output buffer synchronously, the queue lives inside it. Where `AudioWorklet` is unavailable — an older browser, a non-secure context, or a CSP that blocks `blob:` — the SDK falls back to `ScriptProcessorNode` with the same queue behaviour.

```
WebSocket binary (PCM16)
   ↓
sample queue (FIFO)
   ↓
render node (AudioWorklet, ScriptProcessorNode fallback)
   ↓
MediaStreamAudioDestinationNode  →  MediaStream  →  audio.srcObject
```

The queue applies three guarantees:

| Guarantee | Default | Why it matters |
|-----------|---------|----------------|
| **Pre-buffer** before playback starts | ~250 ms | Absorbs initial network jitter so the first second doesn't click |
| **Rebuffer-with-fade** on underrun | trigger at ~150 ms | When the queue empties (browser GC, big React render, etc.), playback fades out instead of clicking, then fades back in once the buffer refills |
| **Hard cap** on queued samples | ~3 s | If the consumer pauses the audio element, old audio is dropped instead of growing latency unbounded |

### Tuning

For most apps the defaults are correct. If you observe occasional rebuffers under heavy main-thread load, increase `prebufferSamples`. To minimise latency at the cost of robustness, decrease it.

```javascript
const sdk = new KrispVTSDK({
  apiKey,
  audioOutput: {
    prebufferSamples: 6400,   // ~400 ms — more cushion
    rebufferSamples:  3200,   // ~200 ms
    maxQueueSamples:  64000,  // ~4 s
  },
});
```

### Bypassing internal playback

If you want to do playback yourself (e.g. mix translated audio into a Web Audio graph, push into a `MediaSource`, send into a WebRTC peer connection, or write to disk for testing), turn off the internal player and consume `onRawAudioChunk` instead:

```javascript
const sdk = new KrispVTSDK({
  apiKey,
  disableInternalPlayback: true,   // no MediaStream, no onProcessedAudio
});

sdk.setHooks({
  onRawAudioChunk: (buffer, info) => {
    // info: { sampleRate: 16000, format: 'pcm_s16le', channels: 1 }
    const samples = new Int16Array(buffer);
    // ... your playback / recording / mixing pipeline ...
  },
});
```

`onRawAudioChunk` is also fired when internal playback is **enabled**, so you can use it purely for diagnostics or recording while still relying on the SDK's `MediaStream` for playback. The demo app uses this to display a live "X chunks · Y KB · Z s" counter.

---

## API Reference

### Constructor

```typescript
new KrispVTSDK(config: IKrispVTSDKConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `apiKey` | `string` | ✅ | — | Your Krisp API key. See [Authentication](#authentication). |
| `logLevel` | `LogLevel` | ❌ | `NONE` | Logging verbosity |
| `disableInternalPlayback` | `boolean` | ❌ | `false` | If `true`, the SDK will **not** build a playback `MediaStream` (and `onProcessedAudio` won't fire). Combine with `onRawAudioChunk` if you want to do playback yourself. See [Audio Output](#audio-output--jitter-buffer). |
| `audioOutput` | `IAudioOutputConfig` | ❌ | see below | Tunes the internal jitter buffer. See [Audio Output](#audio-output--jitter-buffer). |

#### `audioOutput` — `IAudioOutputConfig`

Override the playback jitter-buffer thresholds. All values are in **samples at 16 kHz** (1000 samples ≈ 62.5 ms). Defaults are conservative and work for typical browser environments.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prebufferSamples` | `number` | `4000` (~250 ms) | Samples that must be queued before playback starts (and after a rebuffer). Floored at 2048 (one render quantum) — smaller values are ignored. |
| `rebufferSamples` | `number` | `2400` (~150 ms) | When the queue runs out, playback fades out and waits for the buffer to refill to `prebufferSamples`. Must be `≤ prebufferSamples`; larger values are silently clamped down to it, not rejected. |
| `maxQueueSamples` | `number` | `48000` (~3 s) | Hard cap on queued samples. Older audio is dropped above this so a paused consumer doesn't accumulate latency unbounded. Floored at `prebufferSamples × 2`. |

---

### `setHooks(hooks: Partial<IHooks>): this`

Register event callbacks. Chainable.

`setHooks()` may be called at any time, including after `start()` — new callbacks take effect immediately, for hooks fired by the WebSocket as well as by playback.

| Hook | Signature | Description |
|------|-----------|-------------|
| `onReady` | `() => void` | WebSocket accepted the ClientHello and is ready to stream |
| `onConnected` | `() => void` | Same event as `onReady` — fired when the connection is fully established |
| `onDisconnected` | `() => void` | WebSocket closed (clean or unexpected) |
| `onProcessedAudio` | `(stream: MediaStream) => void` | Synthesised translated audio stream ready for playback or publishing. Not emitted when `disableInternalPlayback: true`. |
| `onRawAudioChunk` | `(buffer: ArrayBuffer, info: { sampleRate: 16000; format: "pcm_s16le"; channels: 1 }) => void` | Raw translated PCM16 chunk as it arrives. Always emitted. Useful for recording, custom mixing, native playback, or diagnostics. The `buffer` is a fresh copy you may transfer / detach. |
| `onTranscript` | `(event: IVtTextEvent) => void` | Recognised speech in the source language, parsed and typed. Requires `transcript.interim` and/or `transcript.final`. |
| `onTranslate` | `(event: IVtTextEvent) => void` | Translated text in the target language, parsed and typed. Requires `transcript.translate`. |
| `onError` | `(error: IErrorPayload) => void` | SDK or server error |
| `onMessage` ⚠️ | `(payload: unknown) => void` | **Deprecated — use `onTranscript` / `onTranslate`.** Every inbound JSON frame **except** the handshake (`ready`) and error frames, which the SDK handles itself. Includes the ones also delivered to the typed hooks, and fires **before** them. Still works and is still tested; kept for backward compatibility and for frames the SDK does not model yet. Will be removed in a future major version. |

```javascript
sdk.setHooks({
  onReady: () => console.log('Connected and ready'),
  onProcessedAudio: (stream) => {
    audioElement.srcObject = stream;
    audioElement.play();
  },
  onTranscript: (e) => {
    console.log(`[${e.final ? 'FINAL' : 'INTERIM'}] Original: ${e.text}`);
  },
  onTranslate: (e) => console.log('Translated:', e.text),
  onError: (error) => console.error(error.message),
  onDisconnected: () => console.log('Disconnected'),
});
```

---

### `async start(config: IStartConfig): Promise<void>`

Opens the WebSocket connection, sends a ClientHello configuration message, and waits for the server `ready` signal. Times out after 20 seconds.

```typescript
interface IStartConfig {
  from: string;                           // Source language — BCP 47 (e.g. 'en-US')
  to: string;                             // Target language — BCP 47 (e.g. 'fr-FR')
  voice?: 'male' | 'female';              // Voice (default: 'male')
  vocabulary?: string[];                  // Domain-specific words for improved STT accuracy
  dictionary?: Record<string, string>;    // Explicit word-to-word translations
  transcript?: IVtTranscriptSubscribeConfig;  // Which text events to receive
  features?: IVtFeatures;                 // Server-side processing features
  metadata?: object;                      // Optional metadata sent to the server
}
```

#### `transcript` — `IVtTranscriptSubscribeConfig`

Controls which text events the server emits. When omitted, all three are enabled.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `interim` | `boolean` | `true` | In-progress partial text as you speak |
| `final` | `boolean` | `true` | Completed sentence in the source language |
| `translate` | `boolean` | `true` | Completed sentence in the target language |

#### `features` — `IVtFeatures`

Optional server-side processing. Fields not provided are treated as `false`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `background_voice_cancellation` | `boolean` | `false` | Remove background speakers on the server side |

**Example:**

```javascript
await sdk.start({
  from: 'en-US',
  to: 'ru-RU',
  voice: 'male',
  vocabulary: ['Krisp', 'SDK'],
  dictionary: {
    referral: 'referencia',
    copay: 'copago',
  },
  transcript: {
    interim: false,   // skip partial results
    final: true,
    translate: true,
  },
  features: {
    background_voice_cancellation: true,
  },
});
```

#### Vocabulary & Dictionary validation

Each vocabulary or dictionary key/value must satisfy:
- 1–120 characters
- Maximum 3 words
- Maximum 2 special characters (`.!?&-` or digits)
- Only Unicode letters, digits, and `.!?&-` allowed

If any word fails validation, `start()` rejects with a `ValidationErrorClient` error before opening the WebSocket, and also emits it through `onError`. Because `start()` is `async`, `await` it (or attach a `.catch()`) — a bare `try`/`catch` around an un-awaited call will not see the rejection.

---

### `async process(stream: MediaStream): Promise<void>`

Captures audio from `stream` as PCM16 @ 16 kHz and streams it over the open WebSocket. The server sends back synthesised translated audio which is decoded and emitted via `onProcessedAudio` as a `MediaStream`.

Must be called after `start()` resolves.

```javascript
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
await sdk.process(mic);
```

Both audio paths run on an `AudioWorklet`, off the main thread — microphone capture and translated-audio playback. Where `AudioWorklet` is unavailable — an older browser, a non-secure context (`http://` other than localhost), or a Content-Security-Policy that does not allow `blob:` in `script-src` / `worker-src` — the SDK logs a warning and falls back to `ScriptProcessorNode` rather than failing to produce audio.

Capture opens its `AudioContext` at 16 kHz and lets the browser do the rate conversion on the way in — the SDK does no resampling of its own. If a browser refuses a 16 kHz context, `process()` rejects and emits `InternalErrorClient` rather than streaming audio the server would read back at the wrong speed. Every current browser honours the request.

**Calling `process()` twice** swaps the input stream. The previous capture graph is released and the session, including the WebSocket, stays open.

---

### `sendAudio(pcm: ArrayBuffer | Int16Array | Float32Array): void`

Push raw PCM you captured or routed yourself, instead of handing the SDK a `MediaStream`.

Use this when the audio does not come from a `MediaStream` the SDK can tap — a WebRTC track you already process, a decoded file, a native bridge, or your own `AudioWorklet`.

Audio must be **mono at 16 kHz**:

| Input | Meaning |
|-------|---------|
| `ArrayBuffer` | PCM16 little-endian. Byte length must be even. |
| `Int16Array` | PCM16. Views with a non-zero `byteOffset` are handled correctly. |
| `Float32Array` | Normalised samples in `[-1, 1]`. |

If your audio is at another sample rate, hand the SDK a `MediaStream` through `process()` instead and it will convert for you.

```javascript
await sdk.start({ from: 'en-US', to: 'es-ES' });

// 20 ms of 16 kHz mono PCM16, from wherever you get audio
sdk.sendAudio(myPcm16Chunk);
```

The first call after `start()` resolves moves the session to `PROCESSING` and, unless `disableInternalPlayback` is set, emits the translated output stream via `onProcessedAudio`.

A session uses either `process()` or `sendAudio()`, never both; whichever is used second is rejected through `onError` and the session is left running.

`sendAudio()` **never throws** — it is expected to be called from inside an audio callback. State and input problems are reported once per session through `onError` and the offending chunk is dropped.

---

### `async stop(): Promise<{ success: boolean }>`

Stops audio capture, closes the WebSocket, and releases all audio resources.

```javascript
await sdk.stop();
```

---

### `getState(): ISDKStates`

Returns the current SDK state.

```
'INITIAL' → 'READY' → 'CONNECTED' → 'PROCESSING' → 'STOPPED'
                                  ↘ 'ERROR'
```

```javascript
console.log(sdk.getState()); // 'CONNECTED'
```

---

### `async getLanguagesList(): Promise<VtLanguageInfo[]>`

Fetches the list of supported languages from the Krisp REST API. Can be called before `start()`.

```typescript
interface VtLanguageInfo {
  code: string;  // BCP 47 code, e.g. "en-US"
  name: string;  // Display name, e.g. "English (United States)"
}
```

```javascript
const languages = await sdk.getLanguagesList();
languages.forEach(lang => {
  const opt = document.createElement('option');
  opt.value = lang.code;
  opt.textContent = lang.name;
  select.appendChild(opt);
});
```

---

### `setLogLevel(level: LogLevel): this`

Change logging verbosity at runtime. Chainable.

| Level | Value | Output |
|-------|-------|--------|
| `LogLevel.NONE` | 0 | No output |
| `LogLevel.ERROR` | 1 | Errors only |
| `LogLevel.WARN` | 2 | Warnings and errors |
| `LogLevel.INFO` | 3 | Informational messages |
| `LogLevel.DEBUG` | 4 | Full debug output including ClientHello |

---

## Server Events

The server sends JSON text frames over the same WebSocket used for audio. The SDK parses the `transcript` and `translate` frames into typed `onTranscript` / `onTranslate` events — these are the hooks to build on. The handshake (`{ "type": "ready" }`) and error frames the SDK consumes itself, surfacing them through `onReady` and `onError`.

The raw JSON below is what the frames look like on the wire. Every frame except the handshake and error frames is also forwarded verbatim to the deprecated `onMessage` hook, which remains available for frames the SDK does not model yet.

### Transcript (source language ASR)

Emitted when `transcript.final` or `transcript.interim` is enabled.

```json
{
  "transcript": {
    "text": "Hello, how are you?",
    "final": true,
    "start": "2026-03-25T19:24:45.370+00:00",
    "duration": 436,
    "utterance_id": "abc123"
  }
}
```

| Field | Description |
|-------|-------------|
| `text` | Recognised speech in the source language |
| `final` | `false` for interim (in-progress), `true` for completed utterance |
| `start` | ISO 8601 timestamp of the chunk start |
| `duration` | Chunk duration in milliseconds |
| `utterance_id` | Links this event to the corresponding `translate` event |

```typescript
interface IVtTextEvent {
  text: string;
  final: boolean;                 // tolerates the legacy `is_final` spelling
  utteranceId?: string;
  language?: string;              // not sent by the server yet — reserved
  start?: string;                 // ISO 8601
  durationMs?: number;            // wire `duration`, in milliseconds
}
```

This frame drives the `onTranscript` hook.

### Translation (target language)

Emitted when `transcript.translate` is enabled. Only fires for final utterances.

```json
{
  "translate": {
    "text": "Hola, ¿cómo estás?",
    "final": true,
    "utterance_id": "abc123"
  }
}
```

| Field | Description |
|-------|-------------|
| `text` | Translated text in the target language |
| `final` | Always `true` for translation events |
| `utterance_id` | Matches the `utterance_id` of the corresponding `transcript` event |

This frame drives the `onTranslate` hook.

### Handling both events

```javascript
sdk.setHooks({
  onTranscript: (e) => {
    console.log(`[${e.final ? 'FINAL' : 'INTERIM'}] Original: ${e.text}`, e.utteranceId);
  },
  onTranslate: (e) => {
    console.log('Translated:', e.text, e.utteranceId);
  },
});
```

Fields missing from a frame arrive as `undefined` rather than throwing, and a frame whose text is blank produces no event at all — though it still reaches the deprecated `onMessage`.

---

## Error Handling

```javascript
import { VtErrorType } from '@krisp.ai/krisp-vt-sdk';

sdk.setHooks({
  onError: (error) => {
    switch (error.code) {
      case VtErrorType.InvalidAuthToken:
        console.error('Invalid or expired API key');
        break;
      case VtErrorType.NetworkError:
        console.error('Network error — check connectivity or rate limit');
        break;
      case VtErrorType.ValidationErrorServer:
        console.error('Server rejected the request (bad config)');
        break;
      case VtErrorType.InternalErrorServer:
        console.error('Server error');
        break;
      case VtErrorType.SessionNotStarted:
        console.error('Call start() before process()');
        break;
      case VtErrorType.InvalidInputData:
        console.error('No audio track in the provided MediaStream');
        break;
      case VtErrorType.ValidationErrorClient:
        console.error('Invalid vocabulary or dictionary entry');
        break;
    }
  },
});
```

### `VtErrorType` Reference

| Error | Value | Cause |
|-------|-------|-------|
| `Success` | 0 | No error |
| `ValidationErrorServer` | 1 | Server rejected request (HTTP 400) |
| `ValidationErrorClient` | 2 | Client-side validation failed |
| `InvalidAuthToken` | 3 | Missing, invalid, or expired API key (HTTP 401/402). An expired session token is reported identically to an invalid one. |
| `InternalErrorServer` | 4 | Server error (HTTP 500) |
| `InternalErrorClient` | 5 | Unexpected client-side error |
| `NetworkError` | 6 | Network failure or rate limit (HTTP 429) |
| `SessionNotStarted` | 7 | `process()` called before `start()` |
| `InvalidSessionConfigurations` | 8 | Invalid session config |
| `InvalidInputData` | 9 | No audio track in stream |

---

## Use Cases

### 1. Preview Mode — hear your own translated voice

```javascript
const sdk = new KrispVTSDK({ apiKey });

sdk.setHooks({
  onProcessedAudio: (stream) => {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play();
  },
});

await sdk.start({ from: 'en-US', to: 'ja-JP' });
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
await sdk.process(mic);
```

---

### 2. Real-time Communication

```javascript
// Your voice → translated → sent to others
const outSDK = new KrispVTSDK({ apiKey });

outSDK.setHooks({
  onProcessedAudio: (stream) => sendToOthers(stream),
});

await outSDK.start({ from: 'en-US', to: 'ko-KR' });
await outSDK.process(await navigator.mediaDevices.getUserMedia({ audio: true }));

// Their voice → translated → played to you
const inSDK = new KrispVTSDK({ apiKey });

inSDK.setHooks({
  onProcessedAudio: (stream) => {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play();
  },
});

await inSDK.start({ from: 'ko-KR', to: 'en-US' });
await inSDK.process(theirAudioStream);
```

---

### 3. Audio Mixing — blend original and translated

This is a **legitimate** use of an extra `AudioContext`: you genuinely need a Web Audio graph to combine two streams with adjustable gain. (You do **not** need to wrap the SDK's stream in an `AudioContext` just to play it — see [Audio Output](#audio-output--jitter-buffer).)

```javascript
function createMixedAudio(originalStream, translatedStream, origPct = 30, transPct = 70) {
  const ctx = new AudioContext({ sampleRate: 16000 });

  const origGain = ctx.createGain();
  const transGain = ctx.createGain();
  origGain.gain.value = origPct / 100;
  transGain.gain.value = transPct / 100;

  ctx.createMediaStreamSource(originalStream).connect(origGain);
  ctx.createMediaStreamSource(translatedStream).connect(transGain);

  const dest = ctx.createMediaStreamDestination();
  origGain.connect(dest);
  transGain.connect(dest);

  return dest.stream;
}

sdk.setHooks({
  onProcessedAudio: (translatedStream) => {
    const mixed = createMixedAudio(micStream, translatedStream);
    const audio = new Audio();
    audio.srcObject = mixed;
    audio.play();
  },
});
```

---

### 4. Displaying Transcripts

`utteranceId` links a transcript to its translation, so keying rows on it keeps the two languages of one turn on the same line. Interim results overwrite the row; the translation fills in the second column when it arrives.

```javascript
const rows = new Map();

function upsert(utteranceId, patch) {
  // Events before the first utterance_id share one row — see the note below
  const key = utteranceId ?? 'pending';
  const row = { original: '', translated: '', final: false, ...rows.get(key), ...patch };
  rows.set(key, row);
  renderRow(key, row);
}

sdk.setHooks({
  onTranscript: (e) => upsert(e.utteranceId, { original: e.text, final: e.final }),
  onTranslate: (e) => upsert(e.utteranceId, { translated: e.text }),
});

// Enable all transcript events (default when transcript is omitted)
await sdk.start({
  from: 'en-US',
  to: 'es-ES',
  transcript: { interim: true, final: true, translate: true },
});
```

---

### 5. Raw PCM access — recording, custom playback, or diagnostics

`onRawAudioChunk` always fires for every translated audio frame, regardless of whether internal playback is enabled. Below: record the full translated audio to a downloadable WAV file while the SDK still drives playback to the speakers.

```javascript
const pcmChunks = [];
let totalSamples = 0;
const sampleRate = 16000;

sdk.setHooks({
  onProcessedAudio: (stream) => {
    // SDK still handles real-time playback for the user
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play();
  },
  onRawAudioChunk: (buffer, info) => {
    // info: { sampleRate: 16000, format: 'pcm_s16le', channels: 1 }
    const samples = new Int16Array(buffer);
    pcmChunks.push(samples);
    totalSamples += samples.length;
  },
});

// On stop, build a WAV blob
function downloadWav() {
  const pcm = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of pcmChunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  const wav = encodeWav(pcm, sampleRate);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'translated.wav';
  a.click();
  URL.revokeObjectURL(url);
}
```

To bypass internal playback entirely (no `MediaStream`, no `onProcessedAudio`) and own the playback pipeline yourself, set `disableInternalPlayback: true` in the SDK config — see [Audio Output → Bypassing internal playback](#bypassing-internal-playback).

---

## SDK Architecture

```
KrispVTSDK (Main Orchestrator)
├── LoggingService              Structured logging with state tracking
├── ErrorHandlingService        Maps errors to VtErrorType, fires onError hook
├── TranslationAPIService       REST client — languages endpoint only
├── WebSocketTransportService   Raw WebSocket: ClientHello, PCM16 audio, JSON events
├── AudioCaptureService         MediaStream → 16 kHz context → PCM16 chunks
│                               (renders on an AudioWorklet, ScriptProcessorNode fallback)
└── AudioOutputService          PCM16 chunks → jitter-buffered queue → MediaStream
                                (renders on an AudioWorklet, ScriptProcessorNode fallback,
                                 pre-buffer + rebuffer-with-fade,
                                 see "Audio Output & Jitter Buffer" above)
```

**Source files:**

| File | Purpose |
|------|---------|
| `src/types.ts` | All TypeScript interfaces and enums |
| `src/constants.ts` | API endpoints, timeout, vocabulary constraints, message templates |
| `src/KrispVTSDK.ts` | Main orchestrator |
| `src/websocket-transport.ts` | WebSocket transport, ClientHello builder, message router |
| `src/translation-api.ts` | REST languages endpoint |
| `src/audio-capture.ts` | Microphone capture and PCM16 conversion |
| `src/audio-output.ts` | PCM16 playback via Web Audio API |
| `src/pcm.ts` | Float32 → PCM16 conversion, shared by every audio input path |
| `src/message-parsing.ts` | Defensive parsing of `transcript` / `translate` frames |
| `src/capture-worklet-source.ts` | Capture AudioWorklet processor, inlined and loaded from a blob URL |
| `src/playback-worklet-source.ts` | Playback AudioWorklet processor holding the jitter buffer, inlined and loaded from a blob URL |
| `src/logging.ts` | Logging service |
| `src/error-handling.ts` | Error management |
| `src/index.ts` | Public API exports |

---

## Connection Flow

```
SDK.start()
  │
  ├─ Open WebSocket: wss://streaming.krisp.ai/vt?authorization=Api-Key <key>
  ├─ Send ClientHello JSON: { config: { audio, source_language, target_language, voice, transcript, vocabulary, translation_dictionary, features, metadata } }
  ├─ Wait for server { "type": "ready" } ──────────────────────────── 20s timeout
  └─ Resolve → fires onReady + onConnected

SDK.process(stream)
  │
  ├─ Tap MediaStream with AudioWorklet (falls back to ScriptProcessorNode)
  ├─ Convert Float32 → PCM16 (context is already at 16 kHz)
  └─ Send binary ArrayBuffer chunks over WebSocket

SDK.sendAudio(pcm)
  │
  └─ Convert to PCM16 @ 16 kHz if needed, send over WebSocket (no capture graph)

WebSocket ← server
  ├─ Binary frames   → onRawAudioChunk (always)
  │                  → AudioOutputService jitter buffer (AudioWorklet) → MediaStream → onProcessedAudio
  │                                                       (skipped when disableInternalPlayback: true)
  ├─ { "transcript": { text, final, … } }  → onTranscript
  ├─ { "translate":  { text, final, … } }  → onTranslate
  │      └─ both also reach onMessage first (deprecated), as does any
  │         other non-handshake frame the SDK does not model
  └─ { "error": { code, reason, description } } → onError

SDK.stop()
  ├─ Stop audio capture
  ├─ Close WebSocket
  └─ Release AudioContext
```

---

## Timeout Configuration

The WebSocket connect timeout is fixed at **20 seconds** (`WS_CONNECT_TIMEOUT_MS`). If the server does not send the `ready` signal within that window, `start()` rejects with a timeout error.

---

## Development

### Build the SDK

```bash
npm install
npm run build
# Output: dist/index.js  +  dist/*.d.ts
```

### Test

```bash
npm test              # run the suite once
npm run test:coverage # same, plus a coverage report
npm run typecheck     # tsc --noEmit, no build output
```

Tests live in `tests/` and run on [Vitest](https://vitest.dev) in a plain Node environment —
no jsdom. Web Audio and WebSocket are stubbed per-test via `vi.stubGlobal`.

Coverage is a ratchet. `vitest.config.ts` sets `thresholds.autoUpdate`, so the numbers rewrite
themselves to whatever each run achieves — coverage can rise freely, and any drop fails the
run. Nobody has to pick a figure, and the gate cannot go stale. If a run raises the
thresholds, commit the change alongside your tests.

CI runs `npm run test:coverage` rather than `npm test` for this reason: thresholds are only
checked when the coverage reporter runs.

The suite covers the audio pipeline, WebSocket message routing and the public API surface.
`translation-api.ts`, `logging.ts` and `error-handling.ts` are not yet covered; the
thresholds are set below the current figure rather than excluding those files, so the number
stays honest.

### Run the Demo

```bash
# At the repo root — build the SDK first (demo links to it via file:..)
npm install
npm run build

# Then run the demo
cd demo
npm install
npm run dev
# Open http://localhost:5173
```

The demo includes:
- **Preview Mode** — test translation by speaking and hearing yourself translated back
- Volume controls to blend original and translated audio at custom ratios
- Live transcript panel (original + translated, inline in the preview card)
- Transcript subscription controls (interim / final / translated)
- Background voice cancellation toggle
- **Live raw-audio counter** — fed by `IHooks.onRawAudioChunk`, demonstrates that advanced consumers can tap the raw PCM16 stream while the SDK still drives playback

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and our [Code of Conduct](CODE_OF_CONDUCT.md). For security-sensitive reports, see [SECURITY.md](SECURITY.md).

---

## License

Use of this SDK is governed by the [Krisp API Terms of Service](https://krisp.ai/api-terms-of-service/). Copyright 2026 Krisp Technologies, Inc.

---

## Support

- GitHub Issues: [https://github.com/krispai/vt-js-sdk/issues](https://github.com/krispai/vt-js-sdk/issues)
- Security: see [SECURITY.md](SECURITY.md)
