import type { KrispVTSDK } from "@krispai/krisp-vt-sdk";

export const state = {
  krispSDK: null as KrispVTSDK | null,
  microphoneStream: null as MediaStream | null,
  previewAudioElement: null as HTMLAudioElement | null,
  isPreviewModeActive: false,

  audioContext: null as AudioContext | null,
  originalGainNode: null as GainNode | null,
  translatedGainNode: null as GainNode | null,
  mixerDestination: null as MediaStreamAudioDestinationNode | null,
};
