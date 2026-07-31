/** Name the processor registers itself under inside the AudioWorkletGlobalScope. */
export const CAPTURE_WORKLET_PROCESSOR = "krisp-vt-capture";

export const CAPTURE_WORKLET_SOURCE = `
class KrispVtCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var opts = (options && options.processorOptions) || {};
    this._target = opts.framesPerPost > 0 ? opts.framesPerPost : 1024;
    this._buf = new Float32Array(this._target);
    this._n = 0;
    this._stopped = false;
    var self = this;
    this.port.onmessage = function (e) {
      if (e.data && e.data.type === "stop") {
        self._stopped = true;
      }
    };
  }

  process(inputs) {
    if (this._stopped) return false;
    var chan = inputs[0] && inputs[0][0];
    // A muted or freshly disconnected track yields an empty input in some UAs.
    if (!chan || chan.length === 0) return true;

    var i = 0;
    while (i < chan.length) {
      var take = Math.min(chan.length - i, this._target - this._n);
      this._buf.set(chan.subarray(i, i + take), this._n);
      this._n += take;
      i += take;
      if (this._n === this._target) {
        var out = this._buf;
        this._buf = new Float32Array(this._target);
        this._n = 0;
        this.port.postMessage({ samples: out }, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("krisp-vt-capture", KrispVtCaptureProcessor);
`;
