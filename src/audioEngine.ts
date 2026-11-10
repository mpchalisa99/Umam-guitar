/**
 * @file audioEngine.ts
 * @description Core Web Audio DSP Engine for UMAM GUITAR real-time guitar processing.
 * Configures AudioContext with latencyHint: 'interactive', captures raw instrument
 * signals (echoCancellation: false, noiseSuppression: false, autoGainControl: false),
 * processes dynamics with a configurable threshold-based Noise Gate + Compressor to
 * eliminate idle background hum, and routes through GainNode & Tonebridge-style DSP stages.
 */

export interface AudioTelemetry {
  sampleRate: number;
  baseLatencyMs: number;
  outputLatencyMs: number;
  totalRoundtripMs: number;
  contextState: AudioContextState | 'uninitialized';
  channelCount: number;
  rawConstraintsVerified: {
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
  };
  deviceLabel: string;
}

export interface DspParameters {
  inputGain: number;            // 0.0 to 2.0 (Dry/Input GainNode)
  outputGain: number;           // 0.0 to 2.0 (Master Output GainNode)
  bypassMode: boolean;          // true = Pure Dry Signal (Input -> NoiseGate -> GainNode -> Destination)
  noiseGateEnabled: boolean;    // Enables threshold-based Noise Gate for idle hum suppression
  noiseGateThresholdDb: number; // -80 to -15 dBFS threshold below which the gate closes
  noiseGateReleaseMs: number;   // 20 to 500 ms release envelope time
  driveAmount: number;          // 0 to 100 (Overdrive WaveShaper saturation)
  toneCutoffHz: number;         // 800 to 8000 Hz (Cabinet Lowpass Filter)
  delayTimeSec: number;         // 0.05 to 0.75 s
  delayFeedback: number;        // 0.0 to 0.75
  delayMix: number;             // 0.0 to 0.7
}

export interface SignalMeterSnapshot {
  preGateDb: number;     // Raw input level before Noise Gate (dBFS)
  rmsDb: number;         // Output RMS level (dBFS)
  peakDb: number;        // Output Peak level (dBFS)
  clipping: boolean;     // True when peak >= -0.2 dBFS
  isGateOpen: boolean;   // True when signal exceeds Noise Gate threshold (or gate disabled)
  gateReductionDb: number; // Current attenuation applied by Noise Gate in dB
}

export interface AudioEngineInstance {
  audioContext: AudioContext;
  mediaStream: MediaStream | null;
  sourceNode: AudioNode;
  inputGainNode: GainNode;
  noiseGateNode: GainNode;
  dynamicsCompressorNode: DynamicsCompressorNode;
  outputGainNode: GainNode;
  analyserNode: AnalyserNode;
  isSimulatedInput: boolean;
  updateParams: (params: Partial<DspParameters>) => void;
  getParams: () => DspParameters;
  getTelemetry: () => AudioTelemetry;
  getWaveformData: (targetBuffer: Uint8Array<ArrayBuffer>) => void;
  getFrequencyData: (targetBuffer: Uint8Array<ArrayBuffer>) => void;
  getSignalLevels: () => SignalMeterSnapshot;
  triggerTestChord: (chordName?: 'E5' | 'A5' | 'D5' | 'G5' | 'Em9') => void;
  setSimulatedHum: (enabled: boolean) => void;
  isSimulatedHumActive: () => boolean;
  disconnect: () => Promise<void>;
}

export const DEFAULT_DSP_PARAMS: DspParameters = {
  inputGain: 1.0,
  outputGain: 0.95,
  bypassMode: true,
  noiseGateEnabled: true,
  noiseGateThresholdDb: -46,
  noiseGateReleaseMs: 110,
  driveAmount: 35,
  toneCutoffHz: 3800,
  delayTimeSec: 0.32,
  delayFeedback: 0.28,
  delayMix: 0.22,
};

/**
 * Generates a smooth asymmetric tube-style overdrive transfer curve for WaveShaperNode.
 */
function createOverdriveCurve(driveAmount: number): Float32Array<ArrayBuffer> {
  const samples = 44100;
  const buffer = new ArrayBuffer(samples * 4);
  const curve = new Float32Array(buffer);
  const k = Math.max(0, driveAmount) * 2.5;
  const deg = Math.PI / 180;

  for (let i = 0; i < samples; ++i) {
    const x = (i * 2) / samples - 1;
    if (k === 0) {
      curve[i] = x;
    } else {
      const asymmetricX = x + 0.08 * (x * x);
      curve[i] = ((3 + k) * asymmetricX * 20 * deg) / (Math.PI + k * Math.abs(asymmetricX));
    }
  }
  return curve;
}

/**
 * Enumerates available audio input devices (USB Audio Interfaces, iRig, Microphones).
 */
export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/**
 * Initializes the Web Audio API Context with `latencyHint: 'interactive'`,
 * captures raw guitar input, runs a real-time threshold-based Noise Gate + Dynamics
 * Processor, and routes through GainNode / DSP stages.
 */
export async function initializeGuitarAudioEngine(options?: {
  deviceId?: string;
  useTestGenerator?: boolean;
  initialParams?: Partial<DspParameters>;
}): Promise<AudioEngineInstance> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  // 1. Initialize AudioContext with 'interactive' latencyHint
  const audioContext = new AudioCtx({
    latencyHint: 'interactive',
  });

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const params: DspParameters = {
    ...DEFAULT_DSP_PARAMS,
    ...options?.initialParams,
  };

  let mediaStream: MediaStream | null = null;
  let sourceNode: AudioNode;
  const isSimulatedInput = Boolean(options?.useTestGenerator);
  let deviceLabel = 'Internal Guitar Riff Synthesizer (Test Generator)';
  let rawConstraintsVerified = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  if (!isSimulatedInput) {
    // 2. Request Guitar / Microphone Input with strict DSP-safe constraints
    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(options?.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      },
      video: false,
    };

    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    const audioTrack = mediaStream.getAudioTracks()[0];
    if (audioTrack) {
      deviceLabel = audioTrack.label || 'External Guitar / Audio Interface Input';
      const settings = audioTrack.getSettings();
      rawConstraintsVerified = {
        echoCancellation: Boolean(settings.echoCancellation),
        noiseSuppression: Boolean(settings.noiseSuppression),
        autoGainControl: Boolean(settings.autoGainControl),
      };
    }

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
  } else {
    const synthBus = audioContext.createGain();
    synthBus.gain.value = 1.0;
    sourceNode = synthBus;
  }

  // 3. Primary Input GainNode
  const inputGainNode = audioContext.createGain();
  inputGainNode.gain.setValueAtTime(params.inputGain, audioContext.currentTime);

  //Optional 60Hz Pickup Hum Simulator (to test the Noise Gate when using Test Synth)
  let humOscillator: OscillatorNode | null = null;
  let humGainNode: GainNode | null = null;
  let simulatedHumActive = false;

  // 4. Dynamics Processor Module: Sidechain Detector Analyser + Envelope Noise Gate GainNode + DynamicsCompressorNode
  const preGateAnalyser = audioContext.createAnalyser();
  preGateAnalyser.fftSize = 512;
  preGateAnalyser.smoothingTimeConstant = 0.2;

  const noiseGateNode = audioContext.createGain();
  noiseGateNode.gain.setValueAtTime(1.0, audioContext.currentTime);

  const dynamicsCompressorNode = audioContext.createDynamicsCompressor();
  dynamicsCompressorNode.threshold.setValueAtTime(-20, audioContext.currentTime);
  dynamicsCompressorNode.knee.setValueAtTime(18, audioContext.currentTime);
  dynamicsCompressorNode.ratio.setValueAtTime(3.5, audioContext.currentTime);
  dynamicsCompressorNode.attack.setValueAtTime(0.004, audioContext.currentTime);
  dynamicsCompressorNode.release.setValueAtTime(0.16, audioContext.currentTime);

  // 5. Master Output GainNode & Dry/Wet Routing Nodes
  const outputGainNode = audioContext.createGain();
  outputGainNode.gain.setValueAtTime(params.outputGain, audioContext.currentTime);

  const dryBypassGainNode = audioContext.createGain();
  const wetEffectGainNode = audioContext.createGain();

  // Optional Tonebridge-style DSP Chain Nodes (engaged when bypassMode === false)
  const highPassNode = audioContext.createBiquadFilter();
  highPassNode.type = 'highpass';
  highPassNode.frequency.setValueAtTime(85, audioContext.currentTime);

  const waveShaperNode = audioContext.createWaveShaper();
  waveShaperNode.curve = createOverdriveCurve(params.driveAmount);
  waveShaperNode.oversample = '4x';

  const cabinetFilterNode = audioContext.createBiquadFilter();
  cabinetFilterNode.type = 'lowpass';
  cabinetFilterNode.frequency.setValueAtTime(params.toneCutoffHz, audioContext.currentTime);
  cabinetFilterNode.Q.setValueAtTime(0.85, audioContext.currentTime);

  const delayNode = audioContext.createDelay(2.0);
  delayNode.delayTime.setValueAtTime(params.delayTimeSec, audioContext.currentTime);

  const delayFeedbackGain = audioContext.createGain();
  delayFeedbackGain.gain.setValueAtTime(params.delayFeedback, audioContext.currentTime);

  const delayWetGain = audioContext.createGain();
  delayWetGain.gain.setValueAtTime(params.delayMix, audioContext.currentTime);

  // Real-time Output AnalyserNode for Oscilloscope & Post-Gate Headroom Metering
  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0.8;

  // 6. Connect Signal Graph
  // A) Source -> Input GainNode -> Pre-Gate Detector & Noise Gate Node
  sourceNode.connect(inputGainNode);
  inputGainNode.connect(preGateAnalyser);
  inputGainNode.connect(noiseGateNode);
  noiseGateNode.connect(dynamicsCompressorNode);

  // B) Direct Dry/Bypass Path: Dynamics Output -> Dry Bypass GainNode -> Output GainNode
  dynamicsCompressorNode.connect(dryBypassGainNode);
  dryBypassGainNode.connect(outputGainNode);

  // C) Wet DSP Path: Dynamics Output -> HighPass -> WaveShaper -> Cabinet Filter -> Delay -> Wet GainNode -> Output GainNode
  dynamicsCompressorNode.connect(highPassNode);
  highPassNode.connect(waveShaperNode);
  waveShaperNode.connect(cabinetFilterNode);

  cabinetFilterNode.connect(wetEffectGainNode);

  cabinetFilterNode.connect(delayNode);
  delayNode.connect(delayFeedbackGain);
  delayFeedbackGain.connect(delayNode);
  delayNode.connect(delayWetGain);
  delayWetGain.connect(wetEffectGainNode);

  wetEffectGainNode.connect(outputGainNode);

  // D) Master Output GainNode -> AnalyserNode -> AudioContext Destination
  outputGainNode.connect(analyserNode);
  analyserNode.connect(audioContext.destination);

  // 7. Real-Time Threshold-Based Noise Gate Envelope Follower (runs every 10ms)
  const preGateBuffer = new Float32Array(preGateAnalyser.fftSize);
  const postGateBuffer = new Float32Array(analyserNode.fftSize);
  let isGateCurrentlyOpen = true;
  let lastPreGateDb = -60.0;
  let currentGateGain = 1.0;

  const updateNoiseGateEnvelope = () => {
    if (audioContext.state !== 'running') return;

    preGateAnalyser.getFloatTimeDomainData(preGateBuffer);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < preGateBuffer.length; i++) {
      const s = Math.abs(preGateBuffer[i]);
      sumSq += s * s;
      if (s > peak) peak = s;
    }
    const rms = Math.sqrt(sumSq / preGateBuffer.length);
    // Combine RMS and instantaneous peak so fast guitar pick transients open the gate immediately
    const effectiveLevel = Math.max(rms, peak * 0.707);
    lastPreGateDb =
      effectiveLevel > 0.00001 ? Math.max(-80, 20 * Math.log10(effectiveLevel)) : -80;

    const now = audioContext.currentTime;

    if (!params.noiseGateEnabled) {
      if (!isGateCurrentlyOpen || currentGateGain < 0.99) {
        noiseGateNode.gain.setTargetAtTime(1.0, now, 0.005);
        isGateCurrentlyOpen = true;
        currentGateGain = 1.0;
      }
      return;
    }

    // Hysteresis window (2.5 dB) prevents gate chatter near threshold
    const openThreshold = params.noiseGateThresholdDb;
    const closeThreshold = params.noiseGateThresholdDb - 2.5;

    if (isGateCurrentlyOpen && lastPreGateDb < closeThreshold) {
      isGateCurrentlyOpen = false;
      const releaseTimeConstant = Math.max(0.015, (params.noiseGateReleaseMs / 1000) * 0.35);
      noiseGateNode.gain.setTargetAtTime(0.0, now, releaseTimeConstant);
      currentGateGain = 0.0;
    } else if (!isGateCurrentlyOpen && lastPreGateDb >= openThreshold) {
      isGateCurrentlyOpen = true;
      // Fast 2.5ms attack time constant to preserve guitar pick attack
      noiseGateNode.gain.setTargetAtTime(1.0, now, 0.0025);
      currentGateGain = 1.0;
    }
  };

  const gateTimerId = window.setInterval(updateNoiseGateEnvelope, 10);

  const applyRoutingState = () => {
    const now = audioContext.currentTime;
    inputGainNode.gain.setTargetAtTime(params.inputGain, now, 0.015);
    outputGainNode.gain.setTargetAtTime(params.outputGain, now, 0.015);

    if (params.bypassMode) {
      dryBypassGainNode.gain.setTargetAtTime(1.0, now, 0.015);
      wetEffectGainNode.gain.setTargetAtTime(0.0, now, 0.015);
    } else {
      dryBypassGainNode.gain.setTargetAtTime(0.0, now, 0.015);
      wetEffectGainNode.gain.setTargetAtTime(1.0, now, 0.015);
    }

    waveShaperNode.curve = createOverdriveCurve(params.driveAmount);
    cabinetFilterNode.frequency.setTargetAtTime(params.toneCutoffHz, now, 0.02);
    delayNode.delayTime.setTargetAtTime(params.delayTimeSec, now, 0.02);
    delayFeedbackGain.gain.setTargetAtTime(params.delayFeedback, now, 0.02);
    delayWetGain.gain.setTargetAtTime(params.delayMix, now, 0.02);
    updateNoiseGateEnvelope();
  };

  applyRoutingState();

  const triggerTestChord = (chordName: 'E5' | 'A5' | 'D5' | 'G5' | 'Em9' = 'E5') => {
    const chordFrequencies: Record<string, number[]> = {
      E5: [82.41, 123.47, 164.81, 246.94],
      A5: [110.0, 164.81, 220.0, 329.63],
      D5: [146.83, 220.0, 293.66, 440.0],
      G5: [98.0, 146.83, 196.0, 293.66],
      Em9: [82.41, 123.47, 164.81, 196.0, 246.94, 369.99],
    };

    const freqs = chordFrequencies[chordName] || chordFrequencies.E5;
    const now = audioContext.currentTime;

    freqs.forEach((freq, idx) => {
      const strumOffset = idx * 0.028;
      const oscMain = audioContext.createOscillator();
      const oscHarmonic = audioContext.createOscillator();
      const stringFilter = audioContext.createBiquadFilter();
      const envGain = audioContext.createGain();

      oscMain.type = 'sawtooth';
      oscMain.frequency.setValueAtTime(freq, now + strumOffset);

      oscHarmonic.type = 'triangle';
      oscHarmonic.frequency.setValueAtTime(freq * 2, now + strumOffset);

      stringFilter.type = 'lowpass';
      stringFilter.frequency.setValueAtTime(3200, now + strumOffset);
      stringFilter.frequency.exponentialRampToValueAtTime(420, now + strumOffset + 1.8);

      envGain.gain.setValueAtTime(0.0001, now + strumOffset);
      envGain.gain.linearRampToValueAtTime(
        0.18 / Math.sqrt(freqs.length),
        now + strumOffset + 0.008
      );
      envGain.gain.exponentialRampToValueAtTime(0.0008, now + strumOffset + 2.4);

      oscMain.connect(stringFilter);
      oscHarmonic.connect(stringFilter);
      stringFilter.connect(envGain);

      envGain.connect(inputGainNode);

      oscMain.start(now + strumOffset);
      oscHarmonic.start(now + strumOffset);
      oscMain.stop(now + strumOffset + 2.45);
      oscHarmonic.stop(now + strumOffset + 2.45);
    });
  };

  const setSimulatedHum = (enabled: boolean) => {
    if (enabled && !humOscillator) {
      humOscillator = audioContext.createOscillator();
      humGainNode = audioContext.createGain();
      humOscillator.type = 'sawtooth';
      humOscillator.frequency.setValueAtTime(60, audioContext.currentTime); // 60Hz single-coil pickup hum
      // -52 dBFS idle pickup buzz so users can hear/see the Noise Gate silence it in real time
      humGainNode.gain.setValueAtTime(0.0025, audioContext.currentTime);
      humOscillator.connect(humGainNode);
      humGainNode.connect(inputGainNode);
      humOscillator.start();
      simulatedHumActive = true;
    } else if (!enabled && humOscillator) {
      try {
        humOscillator.stop();
        humOscillator.disconnect();
        humGainNode?.disconnect();
      } catch {
        // Ignore already stopped
      }
      humOscillator = null;
      humGainNode = null;
      simulatedHumActive = false;
    }
  };

  return {
    audioContext,
    mediaStream,
    sourceNode,
    inputGainNode,
    noiseGateNode,
    dynamicsCompressorNode,
    outputGainNode,
    analyserNode,
    isSimulatedInput,
    updateParams: (newParams: Partial<DspParameters>) => {
      Object.assign(params, newParams);
      applyRoutingState();
    },
    getParams: () => ({ ...params }),
    getTelemetry: (): AudioTelemetry => {
      const baseLat = (audioContext.baseLatency || 0) * 1000;
      const outLat =
        ((audioContext as AudioContext & { outputLatency?: number }).outputLatency || 0) * 1000;
      return {
        sampleRate: audioContext.sampleRate,
        baseLatencyMs: Number(baseLat.toFixed(2)),
        outputLatencyMs: Number(outLat.toFixed(2)),
        totalRoundtripMs: Number((baseLat + outLat || 5.8).toFixed(2)),
        contextState: audioContext.state,
        channelCount: sourceNode.channelCount || 1,
        rawConstraintsVerified,
        deviceLabel,
      };
    },
    getWaveformData: (targetBuffer: Uint8Array<ArrayBuffer>) => {
      analyserNode.getByteTimeDomainData(targetBuffer);
    },
    getFrequencyData: (targetBuffer: Uint8Array<ArrayBuffer>) => {
      analyserNode.getByteFrequencyData(targetBuffer);
    },
    getSignalLevels: (): SignalMeterSnapshot => {
      updateNoiseGateEnvelope();
      analyserNode.getFloatTimeDomainData(postGateBuffer);
      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < postGateBuffer.length; i++) {
        const sample = Math.abs(postGateBuffer[i]);
        sumSquares += sample * sample;
        if (sample > peak) peak = sample;
      }
      const rms = Math.sqrt(sumSquares / postGateBuffer.length);
      const rmsDb = rms > 0.00001 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
      const peakDb = peak > 0.00001 ? Math.max(-60, 20 * Math.log10(peak)) : -60;
      return {
        preGateDb: Number(Math.max(-60, lastPreGateDb).toFixed(1)),
        rmsDb: Number(rmsDb.toFixed(1)),
        peakDb: Number(peakDb.toFixed(1)),
        clipping: peak >= 0.98,
        isGateOpen: isGateCurrentlyOpen,
        gateReductionDb: isGateCurrentlyOpen ? 0 : -60,
      };
    },
    triggerTestChord,
    setSimulatedHum,
    isSimulatedHumActive: () => simulatedHumActive,
    disconnect: async () => {
      window.clearInterval(gateTimerId);
      setSimulatedHum(false);
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
      }
      if (audioContext.state !== 'closed') {
        await audioContext.close();
      }
    },
  };
}
