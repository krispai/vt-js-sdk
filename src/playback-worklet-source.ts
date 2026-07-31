/** Name the playback processor registers itself under. */
export const PLAYBACK_WORKLET_PROCESSOR = "krisp-vt-playback";

/**
 * Source of the playback AudioWorkletProcessor, loaded at runtime from a blob URL.
 *
 * The jitter buffer lives here rather than on the main thread because `process()`
 * runs on the audio thread and must fill its output buffer synchronously, so it
 * cannot pull from a main-thread queue.
 *
 * MAINTENANCE RULES — this is a template literal in a TypeScript file:
 *   - No backticks and no `${` anywhere inside it.
 *   - Plain ES2017 JavaScript. It is never type-checked and never transpiled.
 *   - Must not name any of the SDK's endpoint-override config fields; this string
 *     is emitted verbatim into dist/index.js, which the publish pipeline greps.
 *
 * Protocol, main thread -> processor:
 *   { samples: Float32Array }  enqueue a block (transfer the buffer)
 *   { type: "reset" }          drop everything and re-arm the pre-buffer
 *   { type: "stop" }           end the processor
 */
export const PLAYBACK_WORKLET_SOURCE = `
class KrispVtPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var o = (options && options.processorOptions) || {};
    this._prebuffer = o.prebufferSamples > 0 ? o.prebufferSamples : 4000;
    this._rebuffer = o.rebufferSamples > 0 ? o.rebufferSamples : 0;
    this._maxQueue = o.maxQueueSamples > 0 ? o.maxQueueSamples : 48000;
    this._fade = o.fadeSamples > 0 ? o.fadeSamples : 64;
    this._stopped = false;
    this._reset();

    var self = this;
    this.port.onmessage = function (e) {
      var d = e.data;
      if (!d) return;
      if (d.type === "stop") { self._stopped = true; return; }
      if (d.type === "reset") { self._reset(); return; }
      if (d.samples) { self._enqueue(d.samples); }
    };
  }

  _reset() {
    this._queue = [];
    this._readOffset = 0;
    this._queued = 0;
    this._started = false;
    this._rebuffering = false;
    this._fadeInPending = false;
  }

  _enqueue(samples) {
    this._queue.push(samples);
    this._queued += samples.length;

    // Cap the queue. Without this a paused consumer would let latency grow
    // without bound and then dump seconds of stale audio on resume.
    while (this._queued > this._maxQueue && this._queue.length > 0) {
      var head = this._queue[0];
      var headRemaining = head.length - this._readOffset;
      if (headRemaining <= this._queued - this._maxQueue) {
        this._queued -= headRemaining;
        this._queue.shift();
        this._readOffset = 0;
      } else {
        var toDrop = this._queued - this._maxQueue;
        this._readOffset += toDrop;
        this._queued -= toDrop;
        break;
      }
    }
  }

  _renderInto(out) {
    var need = out.length;

    if (!this._started) {
      if (this._queued >= this._prebuffer) {
        this._started = true;
        this._fadeInPending = true;
      } else {
        out.fill(0);
        return;
      }
    } else if (this._rebuffering) {
      if (this._queued >= this._prebuffer) {
        this._rebuffering = false;
        this._fadeInPending = true;
      } else {
        out.fill(0);
        return;
      }
    }

    var written = 0;
    while (written < need && this._queue.length > 0) {
      var head = this._queue[0];
      var available = head.length - this._readOffset;
      var take = Math.min(available, need - written);
      out.set(head.subarray(this._readOffset, this._readOffset + take), written);
      this._readOffset += take;
      this._queued -= take;
      written += take;
      if (this._readOffset >= head.length) {
        this._queue.shift();
        this._readOffset = 0;
      }
    }

    if (written < need) {
      // Underrun: fade the partial tail out so it does not click, zero the rest,
      // and re-arm the pre-buffer.
      if (written > 0) {
        var fadeLen = Math.min(this._fade, written);
        for (var i = 0; i < fadeLen; i++) {
          var idx = written - fadeLen + i;
          out[idx] = out[idx] * (1 - (i + 1) / fadeLen);
        }
      }
      for (var j = written; j < need; j++) out[j] = 0;
      this._rebuffering = true;
      return;
    }

    if (this._fadeInPending) {
      var fl = Math.min(this._fade, out.length);
      for (var k = 0; k < fl; k++) out[k] = out[k] * ((k + 1) / fl);
      this._fadeInPending = false;
    }
  }

  process(_inputs, outputs) {
    if (this._stopped) return false;
    var out = outputs[0] && outputs[0][0];
    if (!out) return true;
    this._renderInto(out);
    return true;
  }
}

registerProcessor("krisp-vt-playback", KrispVtPlaybackProcessor);
`;
