# Krisp VT JS SDK

[![npm version](https://img.shields.io/npm/v/@krispai/krisp-vt-sdk.svg)](https://www.npmjs.com/package/@krispai/krisp-vt-sdk)
[![CI](https://github.com/krispai/vt-js-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/krispai/vt-js-sdk/actions/workflows/ci.yml)

Real-time voice translation SDK powered by Krisp AI. Streams PCM16 audio over a raw WebSocket, receives synthesised translated speech back on the same connection, and emits it as a `MediaStream` ready for playback or publishing.

## Features

- Real-time speech translation over a raw WebSocket (PCM16 @ 16 kHz)
- Source and translated transcript events (interim and final)
- Custom vocabulary and translation dictionary for domain-specific accuracy
- Server-side background voice cancellation
- Male and female voice options
- Pluggable hooks for audio, transcripts, errors, and connection events
- Structured error types aligned with the Krisp API error codes

## Requirements

- Node.js 18+ (20+ recommended)
- A modern browser with `WebSocket`, `AudioContext`, and `getUserMedia` support

---

## Installation

```bash
npm install @krispai/krisp-vt-sdk
```

**`package.json`:**

```json
{
  "dependencies": {
    "@krispai/krisp-vt-sdk": "^1.0.0"
  }
}
```

The package ships ESM with TypeScript declarations and zero runtime dependencies.

---

## Basic Usage

```javascript
import { KrispVTSDK, LogLevel } from '@krispai/krisp-vt-sdk';

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
  onMessage: (msg) => {
    // Server transcript / translation events — see "Server Events" section
    console.log('Server event:', msg);
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

## API Reference

### Constructor

```typescript
new KrispVTSDK(config: IKrispVTSDKConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `apiKey` | `string` | ✅ | — | Your Krisp API key |
| `logLevel` | `LogLevel` | ❌ | `NONE` | Logging verbosity |
| `baseUrl` | `string` | ❌ | `https://api.developers.krisp.ai` | Override REST API base URL |
| `wsBaseUrl` | `string` | ❌ | `wss://streaming.krisp.ai` | Override WebSocket base URL |

---

### `setHooks(hooks: Partial<IHooks>): this`

Register event callbacks. Chainable.

| Hook | Signature | Description |
|------|-----------|-------------|
| `onReady` | `() => void` | WebSocket accepted the ClientHello and is ready to stream |
| `onConnected` | `() => void` | Same event as `onReady` — fired when the connection is fully established |
| `onDisconnected` | `() => void` | WebSocket closed (clean or unexpected) |
| `onProcessedAudio` | `(stream: MediaStream) => void` | Synthesised translated audio stream ready for playback or publishing |
| `onMessage` | `(payload: unknown) => void` | Raw server JSON event (transcript, translation, or other) |
| `onError` | `(error: IErrorPayload) => void` | SDK or server error |

```javascript
sdk.setHooks({
  onReady: () => console.log('Connected and ready'),
  onProcessedAudio: (stream) => {
    audioElement.srcObject = stream;
    audioElement.play();
  },
  onMessage: (msg) => {
    const m = msg as any;
    if (m.transcript) console.log('Original:', m.transcript.text);
    if (m.translate) console.log('Translated:', m.translate.text);
  },
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

`start()` throws a `ValidationErrorClient` error synchronously before connecting if any word fails validation.

---

### `async process(stream: MediaStream): Promise<void>`

Captures audio from `stream`, resamples it to PCM16 @ 16 kHz, and streams it over the open WebSocket. The server sends back synthesised translated audio which is decoded and emitted via `onProcessedAudio` as a `MediaStream`.

Must be called after `start()` resolves.

```javascript
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
await sdk.process(mic);
```

---

### `async stop(): Promise<{ success: boolean }>`

Stops audio capture, closes the WebSocket, and releases all audio resources.

```javascript
await sdk.stop();
```

---

### `getState(): ISDKStates`

Returns the current SDK state.

```text
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

The server sends JSON text frames over the same WebSocket used for audio. These are forwarded verbatim to the `onMessage` hook.

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

### Handling both events

```javascript
sdk.setHooks({
  onMessage: (payload) => {
    const msg = payload as any;

    if (msg.transcript) {
      const { text, final, utterance_id } = msg.transcript;
      console.log(`[${final ? 'FINAL' : 'INTERIM'}] Original: ${text}`);
    }

    if (msg.translate) {
      const { text, utterance_id } = msg.translate;
      console.log(`Translated: ${text}`);
    }
  },
});
```

---

## Error Handling

```javascript
import { VtErrorType } from '@krispai/krisp-vt-sdk';

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
| `InvalidAuthToken` | 3 | Missing, invalid, or expired API key (HTTP 401/402) |
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
    // Play back or publish the mixed stream
    const audio = new Audio();
    audio.srcObject = mixed;
    audio.play();
  },
});
```

---

### 4. Displaying Transcripts

```javascript
sdk.setHooks({
  onMessage: (payload) => {
    const msg = payload as any;

    if (msg.transcript?.text) {
      showInUI('original', msg.transcript.text, msg.transcript.final);
    }
    if (msg.translate?.text) {
      showInUI('translated', msg.translate.text, msg.translate.final);
    }
  },
});

// Enable all transcript events (default when transcript is omitted)
await sdk.start({
  from: 'en-US',
  to: 'es-ES',
  transcript: { interim: true, final: true, translate: true },
});
```

---

## Supported Languages

Use `getLanguagesList()` to retrieve the current live list from the API.

Common codes:

| Code | Language |
|------|----------|
| `en-US` | English (US) |
| `es-ES` | Spanish (Spain) |
| `fr-FR` | French |
| `de-DE` | German |
| `it-IT` | Italian |
| `pt-PT` | Portuguese |
| `ru-RU` | Russian |
| `ja-JP` | Japanese |
| `ko-KR` | Korean |
| `zh-CN` | Chinese (Simplified) |
| `ar-SA` | Arabic |
| `hi-IN` | Hindi |

---

## SDK Architecture

```text
KrispVTSDK (Main Orchestrator)
├── LoggingService              Structured logging with state tracking
├── ErrorHandlingService        Maps errors to VtErrorType, fires onError hook
├── TranslationAPIService       REST client — languages endpoint only
├── WebSocketTransportService   Raw WebSocket: ClientHello, PCM16 audio, JSON events
├── AudioCaptureService         MediaStream → resample to 16 kHz → PCM16 chunks
└── AudioOutputService          PCM16 chunks → Web Audio → MediaStream (onProcessedAudio)
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
| `src/logging.ts` | Logging service |
| `src/error-handling.ts` | Error management |
| `src/index.ts` | Public API exports |

---

## Connection Flow

```text
SDK.start()
  │
  ├─ Open WebSocket: wss://streaming.krisp.ai/vt?authorization=Api-Key <key>
  ├─ Send ClientHello JSON: { config: { audio, source_language, target_language, voice, transcript, vocabulary, translation_dictionary, features } }
  ├─ Wait for server { "type": "ready" } ──────────────────────────── 20s timeout
  └─ Resolve → fires onReady + onConnected

SDK.process(stream)
  │
  ├─ Tap MediaStream with ScriptProcessorNode
  ├─ Resample to 16 kHz, convert Float32 → PCM16
  └─ Send binary ArrayBuffer chunks over WebSocket

WebSocket ← server
  ├─ Binary frames   → AudioOutputService.addPCM16Chunk() → onProcessedAudio
  ├─ { "transcript": { text, final, … } }  → onMessage
  ├─ { "translate":  { text, final, … } }  → onMessage
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

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and our [Code of Conduct](CODE_OF_CONDUCT.md). For security-sensitive reports, see [SECURITY.md](SECURITY.md).

---

## License

License TBD. Copyright 2026 Krisp Technologies, Inc.

---

## Support

- GitHub Issues: [https://github.com/krispai/vt-js-sdk/issues](https://github.com/krispai/vt-js-sdk/issues)
- Security: see [SECURITY.md](SECURITY.md)
