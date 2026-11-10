import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Power,
  Volume2,
  Sliders,
  Activity,
  Copy,
  Check,
  Radio,
  Cpu,
  AlertTriangle,
  Play,
  RefreshCw,
  ShieldAlert,
  RotateCcw,
} from 'lucide-react';
import {
  initializeGuitarAudioEngine,
  listAudioInputDevices,
  DEFAULT_DSP_PARAMS,
  type AudioEngineInstance,
  type AudioTelemetry,
  type DspParameters,
  type SignalMeterSnapshot,
} from './audioEngine';
import { PROJECT_BLUEPRINTS, type BlueprintFile } from './data/projectBlueprints';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';
import { useOnlineStatus } from './hooks/useOnlineStatus';

const STORAGE_KEY = 'umam_guitar_dsp_params_v1';
const PRESET_STORAGE_KEY = 'umam_guitar_active_preset_v1';

interface TonePreset {
  id: string;
  name: string;
  artistRef: string;
  bypassMode: boolean;
  noiseGateEnabled: boolean;
  noiseGateThresholdDb: number;
  noiseGateReleaseMs: number;
  inputGain: number;
  outputGain: number;
  driveAmount: number;
  toneCutoffHz: number;
  delayTimeSec: number;
  delayFeedback: number;
  delayMix: number;
}

const TONE_PRESETS: TonePreset[] = [
  {
    id: 'pure-dry-bypass',
    name: 'Pure Dry Bypass (Direct GainNode)',
    artistRef: 'Unprocessed Instrument Reference · Unity Gain 1.00x',
    bypassMode: true,
    noiseGateEnabled: true,
    noiseGateThresholdDb: -48,
    noiseGateReleaseMs: 110,
    inputGain: 1.0,
    outputGain: 0.95,
    driveAmount: 0,
    toneCutoffHz: 6500,
    delayTimeSec: 0.25,
    delayFeedback: 0.0,
    delayMix: 0.0,
  },
  {
    id: 'clean-chime-boost',
    name: 'Studio Clean Preamp Boost',
    artistRef: 'Warm Headroom · +3.5 dB Input Gain',
    bypassMode: false,
    noiseGateEnabled: true,
    noiseGateThresholdDb: -46,
    noiseGateReleaseMs: 120,
    inputGain: 1.35,
    outputGain: 0.9,
    driveAmount: 12,
    toneCutoffHz: 5200,
    delayTimeSec: 0.34,
    delayFeedback: 0.22,
    delayMix: 0.18,
  },
  {
    id: 'crunch-british-drive',
    name: 'British Valve Overdrive',
    artistRef: 'Asymmetric Tube Clipping · 4x Oversampled',
    bypassMode: false,
    noiseGateEnabled: true,
    noiseGateThresholdDb: -42,
    noiseGateReleaseMs: 95,
    inputGain: 1.25,
    outputGain: 0.82,
    driveAmount: 54,
    toneCutoffHz: 3600,
    delayTimeSec: 0.28,
    delayFeedback: 0.25,
    delayMix: 0.16,
  },
  {
    id: 'lead-ambient-sustain',
    name: 'High-Gain Arena Lead',
    artistRef: 'Tight Noise Gate (-38 dB) · Saturated Sustain',
    bypassMode: false,
    noiseGateEnabled: true,
    noiseGateThresholdDb: -38,
    noiseGateReleaseMs: 85,
    inputGain: 1.45,
    outputGain: 0.78,
    driveAmount: 82,
    toneCutoffHz: 3100,
    delayTimeSec: 0.42,
    delayFeedback: 0.38,
    delayMix: 0.3,
  },
];

function loadPersistedParams(): { params: DspParameters; hasSavedSession: boolean } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { params: { ...DEFAULT_DSP_PARAMS }, hasSavedSession: false };
    }
    const parsed = JSON.parse(raw) as Partial<DspParameters>;
    return {
      params: {
        ...DEFAULT_DSP_PARAMS,
        ...parsed,
      },
      hasSavedSession: true,
    };
  } catch {
    return { params: { ...DEFAULT_DSP_PARAMS }, hasSavedSession: false };
  }
}

function loadPersistedPresetId(): string {
  try {
    return window.localStorage.getItem(PRESET_STORAGE_KEY) || 'pure-dry-bypass';
  } catch {
    return 'pure-dry-bypass';
  }
}

export default function App() {
  const engineRef = useRef<AudioEngineInstance | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Direct DOM refs for 60fps requestAnimationFrame ballistic headroom meter animation
  const postGatePeakBarRef = useRef<HTMLDivElement | null>(null);
  const postGateRmsBarRef = useRef<HTMLDivElement | null>(null);
  const postGatePeakHoldRef = useRef<HTMLDivElement | null>(null);
  const preGateInputBarRef = useRef<HTMLDivElement | null>(null);

  // Ballistic smoothing state for 60fps meter interpolation
  const meterBallisticsRef = useRef({
    smoothedPeakPct: 0,
    smoothedRmsPct: 0,
    smoothedPreGatePct: 0,
    peakHoldPct: 0,
    peakHoldFrames: 0,
  });

  const isOnline = useOnlineStatus();

  const [connectionStatus, setConnectionStatus] = useState<
    'disconnected' | 'connecting' | 'connected' | 'error'
  >('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [useSimulatorFallback, setUseSimulatorFallback] = useState<boolean>(false);
  const [simulatedHumEnabled, setSimulatedHumEnabled] = useState<boolean>(false);

  const [dspParams, setDspParams] = useState<DspParameters>(() => loadPersistedParams().params);
  const [activePresetId, setActivePresetId] = useState<string>(() => loadPersistedPresetId());
  const [lastSavedTimestamp, setLastSavedTimestamp] = useState<string>('Tersimpan otomatis');

  const [telemetry, setTelemetry] = useState<AudioTelemetry>({
    sampleRate: 48000,
    baseLatencyMs: 0,
    outputLatencyMs: 0,
    totalRoundtripMs: 0,
    contextState: 'uninitialized',
    channelCount: 1,
    rawConstraintsVerified: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    deviceLabel: 'No Guitar Interface Connected',
  });

  const [signalLevels, setSignalLevels] = useState<SignalMeterSnapshot>({
    preGateDb: -60.0,
    rmsDb: -60.0,
    peakDb: -60.0,
    clipping: false,
    isGateOpen: true,
    gateReductionDb: 0,
  });

  const [visualizerMode, setVisualizerMode] = useState<'waveform' | 'spectrum'>('waveform');
  const [selectedBlueprint, setSelectedBlueprint] = useState<BlueprintFile>(PROJECT_BLUEPRINTS[2]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Persist user-defined parameter tweaks (drive, cutoff, delay, noise gate, gains) to localStorage
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dspParams));
      window.localStorage.setItem(PRESET_STORAGE_KEY, activePresetId);
      const now = new Date();
      setLastSavedTimestamp(
        now.toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    } catch {
      // Ignore storage quota errors in restricted browsing modes
    }
  }, [dspParams, activePresetId]);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await listAudioInputDevices();
      setInputDevices(devices);
    } catch {
      // Ignore enumeration errors before permission is granted
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
      };
    }
  }, [refreshDevices]);

  // Real-time 60fps Oscilloscope, Spectrum & Ballistic Headroom Meter Animation Loop
  const startTelemetryLoop = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }

    const waveBuffer = new Uint8Array(new ArrayBuffer(2048));
    const freqBuffer = new Uint8Array(new ArrayBuffer(1024));
    let frameCounter = 0;

    const renderFrame = () => {
      const engine = engineRef.current;
      const canvas = canvasRef.current;
      const b = meterBallisticsRef.current;

      if (engine) {
        const levels = engine.getSignalLevels();

        // Convert dBFS (-60 to 0 dBFS) to percentage (0 to 100%)
        const targetPeakPct = Math.min(100, Math.max(0, ((levels.peakDb + 60) / 60) * 100));
        const targetRmsPct = Math.min(100, Math.max(0, ((levels.rmsDb + 60) / 60) * 100));
        const targetPreGatePct = Math.min(100, Math.max(0, ((levels.preGateDb + 80) / 65) * 100));

        // Asymmetric ballistic smoothing: fast attack (0.48), smooth musical decay (0.14)
        const peakAttackOrDecay = targetPeakPct > b.smoothedPeakPct ? 0.48 : 0.14;
        const rmsAttackOrDecay = targetRmsPct > b.smoothedRmsPct ? 0.38 : 0.12;
        const preGateRate = targetPreGatePct > b.smoothedPreGatePct ? 0.45 : 0.16;

        b.smoothedPeakPct += (targetPeakPct - b.smoothedPeakPct) * peakAttackOrDecay;
        b.smoothedRmsPct += (targetRmsPct - b.smoothedRmsPct) * rmsAttackOrDecay;
        b.smoothedPreGatePct += (targetPreGatePct - b.smoothedPreGatePct) * preGateRate;

        // Peak-hold needle with 35-frame hold before smooth release
        if (b.smoothedPeakPct >= b.peakHoldPct) {
          b.peakHoldPct = b.smoothedPeakPct;
          b.peakHoldFrames = 35;
        } else if (b.peakHoldFrames > 0) {
          b.peakHoldFrames--;
        } else {
          b.peakHoldPct = Math.max(0, b.peakHoldPct - 0.65);
        }

        // Apply GPU-accelerated transform directly to meter bar DOM nodes at 60fps
        if (postGatePeakBarRef.current) {
          postGatePeakBarRef.current.style.transform = `scaleX(${(b.smoothedPeakPct / 100).toFixed(4)})`;
        }
        if (postGateRmsBarRef.current) {
          postGateRmsBarRef.current.style.transform = `scaleX(${(b.smoothedRmsPct / 100).toFixed(4)})`;
        }
        if (postGatePeakHoldRef.current) {
          postGatePeakHoldRef.current.style.left = `${Math.min(99.2, b.peakHoldPct).toFixed(2)}%`;
        }
        if (preGateInputBarRef.current) {
          preGateInputBarRef.current.style.transform = `scaleX(${(b.smoothedPreGatePct / 100).toFixed(4)})`;
        }

        // Throttle React numerical readout state updates to every 3 frames (~20Hz) to keep text crisp
        frameCounter++;
        if (frameCounter % 3 === 0) {
          setSignalLevels(levels);
        }

        if (canvas) {
          const ctx = canvas.getContext('2d');
          const width = canvas.width;
          const height = canvas.height;

          if (ctx) {
            ctx.fillStyle = '#07090E';
            ctx.fillRect(0, 0, width, height);

            // Precision oscilloscope graticule grid
            ctx.strokeStyle = '#1E293B';
            ctx.lineWidth = 1;
            const vSteps = 4;
            const hSteps = 8;
            for (let i = 1; i < vSteps; i++) {
              const y = (height / vSteps) * i;
              ctx.beginPath();
              ctx.setLineDash(i === 2 ? [4, 4] : [2, 6]);
              ctx.moveTo(0, y);
              ctx.lineTo(width, y);
              ctx.stroke();
            }
            for (let j = 1; j < hSteps; j++) {
              const x = (width / hSteps) * j;
              ctx.beginPath();
              ctx.setLineDash([2, 6]);
              ctx.moveTo(x, 0);
              ctx.lineTo(x, height);
              ctx.stroke();
            }
            ctx.setLineDash([]);

            if (visualizerMode === 'waveform') {
              engine.getWaveformData(waveBuffer);
              ctx.lineWidth = 2;
              ctx.strokeStyle = !levels.isGateOpen
                ? '#475569'
                : engine.getParams().bypassMode
                ? '#06B6D4'
                : '#F59E0B';
              ctx.beginPath();

              const sliceWidth = width / waveBuffer.length;
              let x = 0;
              for (let i = 0; i < waveBuffer.length; i++) {
                const v = waveBuffer[i] / 128.0;
                const y = (v * height) / 2;
                if (i === 0) {
                  ctx.moveTo(x, y);
                } else {
                  ctx.lineTo(x, y);
                }
                x += sliceWidth;
              }
              ctx.lineTo(width, height / 2);
              ctx.stroke();
            } else {
              engine.getFrequencyData(freqBuffer);
              const barCount = 96;
              const barWidth = width / barCount;
              const activeColor = engine.getParams().bypassMode ? '#06B6D4' : '#F59E0B';

              for (let i = 0; i < barCount; i++) {
                const val = freqBuffer[i];
                const percent = val / 255;
                const barHeight = percent * (height - 16);
                ctx.fillStyle = activeColor;
                ctx.fillRect(
                  i * barWidth + 1,
                  height - barHeight,
                  Math.max(1, barWidth - 2),
                  barHeight
                );
              }
            }
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(renderFrame);
    };

    animFrameRef.current = requestAnimationFrame(renderFrame);
  }, [visualizerMode]);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      startTelemetryLoop();
    } else {
      meterBallisticsRef.current = {
        smoothedPeakPct: 0,
        smoothedRmsPct: 0,
        smoothedPreGatePct: 0,
        peakHoldPct: 0,
        peakHoldFrames: 0,
      };
      if (postGatePeakBarRef.current) postGatePeakBarRef.current.style.transform = 'scaleX(0)';
      if (postGateRmsBarRef.current) postGateRmsBarRef.current.style.transform = 'scaleX(0)';
      if (postGatePeakHoldRef.current) postGatePeakHoldRef.current.style.left = '0%';
      if (preGateInputBarRef.current) preGateInputBarRef.current.style.transform = 'scaleX(0)';
    }
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [connectionStatus, visualizerMode, startTelemetryLoop]);

  useEffect(() => {
    return () => {
      if (engineRef.current) {
        engineRef.current.disconnect();
      }
    };
  }, []);

  const handleConnectGuitar = async (forceSimulator = false) => {
    if (connectionStatus === 'connected' && engineRef.current && !forceSimulator) {
      await engineRef.current.disconnect();
      engineRef.current = null;
      setConnectionStatus('disconnected');
      setSimulatedHumEnabled(false);
      setSignalLevels({
        preGateDb: -60.0,
        rmsDb: -60.0,
        peakDb: -60.0,
        clipping: false,
        isGateOpen: true,
        gateReductionDb: 0,
      });
      setTelemetry((prev) => ({
        ...prev,
        contextState: 'closed',
        deviceLabel: 'Audio Disconnected',
      }));
      return;
    }

    if (engineRef.current) {
      await engineRef.current.disconnect();
      engineRef.current = null;
    }

    setConnectionStatus('connecting');
    setErrorMessage(null);

    try {
      const engine = await initializeGuitarAudioEngine({
        deviceId: selectedDeviceId || undefined,
        useTestGenerator: forceSimulator || useSimulatorFallback,
        initialParams: dspParams,
      });

      engineRef.current = engine;
      setTelemetry(engine.getTelemetry());
      setConnectionStatus('connected');
      await refreshDevices();

      if (forceSimulator || useSimulatorFallback) {
        engine.triggerTestChord('E5');
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Izin mikrofon/input gitar ditolak atau perangkat tidak ditemukan.';
      setConnectionStatus('error');
      setErrorMessage(
        `${msg} — Anda juga dapat mengaktifkan "Start with Test Guitar Synth" di bawah untuk menguji jalur Noise Gate, GainNode & DSP tanpa mikrofon fisik.`
      );
    }
  };

  const updateParameter = <K extends keyof DspParameters>(key: K, value: DspParameters[K]) => {
    setActivePresetId('custom-user-preset');
    setDspParams((prev) => {
      const next = { ...prev, [key]: value };
      if (engineRef.current) {
        engineRef.current.updateParams({ [key]: value });
      }
      return next;
    });
  };

  const applyPreset = (preset: TonePreset) => {
    setActivePresetId(preset.id);
    const nextParams: DspParameters = {
      inputGain: preset.inputGain,
      outputGain: preset.outputGain,
      bypassMode: preset.bypassMode,
      noiseGateEnabled: preset.noiseGateEnabled,
      noiseGateThresholdDb: preset.noiseGateThresholdDb,
      noiseGateReleaseMs: preset.noiseGateReleaseMs,
      driveAmount: preset.driveAmount,
      toneCutoffHz: preset.toneCutoffHz,
      delayTimeSec: preset.delayTimeSec,
      delayFeedback: preset.delayFeedback,
      delayMix: preset.delayMix,
    };
    setDspParams(nextParams);
    if (engineRef.current) {
      engineRef.current.updateParams(nextParams);
    }
  };

  const handleResetSavedParameters = () => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(PRESET_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    setActivePresetId('pure-dry-bypass');
    setDspParams({ ...DEFAULT_DSP_PARAMS });
    if (engineRef.current) {
      engineRef.current.updateParams({ ...DEFAULT_DSP_PARAMS });
    }
  };

  const handleToggleSimulatedHum = () => {
    if (!engineRef.current) return;
    const next = !simulatedHumEnabled;
    engineRef.current.setSimulatedHum(next);
    setSimulatedHumEnabled(next);
  };

  const handleCopyBlueprint = async (file: BlueprintFile) => {
    try {
      await navigator.clipboard.writeText(file.code);
      setCopiedId(file.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback if clipboard is restricted
    }
  };

  // Position of the Noise Gate threshold marker on the -80 dB to -15 dB pre-gate scale
  const gateThresholdMarkerPct = Math.min(
    100,
    Math.max(0, ((dspParams.noiseGateThresholdDb + 80) / 65) * 100)
  );

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col">
      <OfflineIndicator />

      {/* Top Bar Contract: 3 Zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800 bg-[#07090E]/95 sticky top-0 z-30 backdrop-blur-xs">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#workstation"
          className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          UMAM GUITAR
        </a>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#workstation"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Signal Chain
          </a>
          <a
            href="#telemetry"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Oscilloscope
          </a>
          <a
            href="#presets"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Noise Gate &amp; DSP
          </a>
          <a
            href="#blueprints"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Source Blueprints
          </a>
        </nav>

        {/* Zone 3: 1 Primary Action (PWA Install Button) */}
        <div className="flex items-center shrink-0">
          <PWAInstallButton />
        </div>
      </header>

      {/* Top Instrument Telemetry Ribbon */}
      <div className="border-b border-slate-800/80 bg-[#0B0F17] px-6 py-2">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
          <div className="flex items-center gap-3 text-slate-300">
            <span
              className={
                connectionStatus === 'connected'
                  ? 'text-emerald-400 font-semibold'
                  : connectionStatus === 'connecting'
                  ? 'text-amber-400 font-semibold'
                  : connectionStatus === 'error'
                  ? 'text-rose-400 font-semibold'
                  : 'text-slate-400'
              }
            >
              {connectionStatus === 'connected'
                ? engineRef.current?.isSimulatedInput
                  ? '▲ Simulation Active (Internal Riff Synth)'
                  : '● Nominal · Guitar Input Connected'
                : connectionStatus === 'connecting'
                ? '▲ Requesting Audio Interface...'
                : connectionStatus === 'error'
                ? '✖ Input Fault / Permission Denied'
                : '○ Standby · AudioContext Suspended'}
            </span>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span className="text-slate-400 truncate max-w-xs sm:max-w-md">
              {telemetry.deviceLabel}
            </span>
          </div>

          <div className="flex items-center gap-3 text-slate-400 tabular-nums">
            <span>
              NOISE GATE:{' '}
              <strong
                className={
                  !dspParams.noiseGateEnabled
                    ? 'text-slate-400'
                    : signalLevels.isGateOpen
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }
              >
                {!dspParams.noiseGateEnabled
                  ? 'BYPASSED'
                  : signalLevels.isGateOpen
                  ? 'OPEN'
                  : 'MUTING HUM'}
              </strong>
            </span>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span>SR: {telemetry.sampleRate} Hz</span>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span>
              NET: {isOnline ? 'Online (SW Ready)' : 'Offline Cache Active'}
            </span>
          </div>
        </div>
      </div>

      {/* Main Workstation Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 space-y-10">
        {/* Section 1: Asymmetric Split Console (Left Parameter & Connection Column + Right Oscilloscope & Signal Stage) */}
        <section id="workstation" className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Left Control & Connection Column (5 cols on lg) */}
          <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111827] p-6 flex flex-col justify-between space-y-6">
            <div className="space-y-5">
              <div>
                <p className="text-xs font-mono text-cyan-400 tracking-wide">
                  01. INSTRUMENT INPUT &amp; GAIN ROUTING
                </p>
                <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-100">
                  UMAM GUITAR — Web Audio DSP
                </h1>
                <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
                  Menangkap sinyal gitar mentah dengan{' '}
                  <code className="text-xs font-mono text-slate-200">
                    latencyHint: &apos;interactive&apos;
                  </code>
                  , memfilter derau/hum saat gitar idle melalui{' '}
                  <code className="text-xs font-mono text-cyan-400">Threshold Noise Gate</code>,
                  dan me-routing sinyal ke output melalui{' '}
                  <code className="text-xs font-mono text-cyan-400">GainNode</code>.
                </p>
              </div>

              {/* Primary CTA: Connect Guitar / Start Audio */}
              <div className="space-y-3 pt-1">
                <button
                  onClick={() => handleConnectGuitar(false)}
                  disabled={connectionStatus === 'connecting'}
                  className={`w-full py-3.5 px-5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2.5 transition-colors cursor-pointer whitespace-nowrap ${
                    connectionStatus === 'connected'
                      ? 'bg-rose-500/15 border border-rose-500/50 text-rose-300 hover:bg-rose-500/25'
                      : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow-sm'
                  }`}
                >
                  <Power className="w-4 h-4 shrink-0" />
                  <span>
                    {connectionStatus === 'connected'
                      ? 'Disconnect Guitar / Stop Audio'
                      : connectionStatus === 'connecting'
                      ? 'Initializing AudioContext...'
                      : 'Connect Guitar / Start Audio'}
                  </span>
                </button>

                {/* Built-in Test Signal Generator Trigger & 60Hz Hum Test */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setUseSimulatorFallback(true);
                      handleConnectGuitar(true);
                    }}
                    className="flex-1 py-2 px-3 rounded-lg border border-slate-700/80 bg-[#07090E] text-xs font-mono text-slate-300 hover:border-amber-500/50 hover:text-amber-300 transition-colors flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>Start with Test Guitar Synth</span>
                  </button>

                  {connectionStatus === 'connected' && (
                    <div className="flex items-center gap-1">
                      {(['E5', 'A5', 'D5', 'Em9'] as const).map((chord) => (
                        <button
                          key={chord}
                          type="button"
                          onClick={() => engineRef.current?.triggerTestChord(chord)}
                          className="px-2.5 py-2 rounded-lg border border-slate-700 bg-[#07090E] text-xs font-mono text-cyan-300 hover:bg-slate-800 transition-colors cursor-pointer"
                          title={`Strum ${chord} Test Guitar Chord`}
                        >
                          {chord}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {connectionStatus === 'connected' && (
                  <button
                    type="button"
                    onClick={handleToggleSimulatedHum}
                    className={`w-full py-2 px-3 rounded-lg border text-xs font-mono transition-colors flex items-center justify-between cursor-pointer ${
                      simulatedHumEnabled
                        ? 'border-amber-500/60 bg-amber-500/10 text-amber-300'
                        : 'border-slate-800 bg-[#07090E] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>Test 60Hz Pickup Hum Injection (-52 dBFS)</span>
                    <span>{simulatedHumEnabled ? '● HUM ACTIVE' : '○ INJECT HUM'}</span>
                  </button>
                )}
              </div>

              {errorMessage && (
                <div className="border-t border-slate-800 pt-3 flex items-start gap-2.5 text-xs text-rose-300 leading-relaxed">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Audio Interface Device Selector */}
              <div className="border-t border-slate-800 pt-4 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="audio-input-select" className="font-medium text-slate-300">
                    Input Interface / Line-In Channel
                  </label>
                  <button
                    type="button"
                    onClick={refreshDevices}
                    className="text-slate-400 hover:text-cyan-400 flex items-center gap-1 font-mono text-[11px] cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Refresh
                  </button>
                </div>
                <select
                  id="audio-input-select"
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#07090E] px-3 py-2 text-xs text-slate-200 font-mono focus:border-cyan-500 focus:outline-hidden"
                >
                  <option value="">Default System Audio Interface / Line-In</option>
                  {inputDevices.map((dev, index) => (
                    <option key={dev.deviceId || index} value={dev.deviceId}>
                      {dev.label || `External Guitar Interface #${index + 1}`}
                    </option>
                  ))}
                </select>
              </div>

              {/* Raw Guitar Signal Constraints Verification */}
              <div className="border-t border-slate-800 pt-4 space-y-2">
                <div className="text-xs font-medium text-slate-300">
                  Raw Instrument Constraints (`getUserMedia`)
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono text-slate-400">
                  <span>
                    echoCancellation:{' '}
                    <strong className="text-emerald-400">
                      {String(telemetry.rawConstraintsVerified.echoCancellation)}
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    noiseSuppression:{' '}
                    <strong className="text-emerald-400">
                      {String(telemetry.rawConstraintsVerified.noiseSuppression)}
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    autoGainControl:{' '}
                    <strong className="text-emerald-400">
                      {String(telemetry.rawConstraintsVerified.autoGainControl)}
                    </strong>
                  </span>
                </div>
              </div>
            </div>

            {/* Primary Dry/Bypass GainNode Controls */}
            <div className="border-t border-slate-800 pt-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200">
                  Routing Mode (Dry Bypass vs Wet DSP)
                </span>
                <div className="flex items-center gap-1 p-1 rounded-lg bg-[#07090E] border border-slate-800">
                  <button
                    type="button"
                    onClick={() => updateParameter('bypassMode', true)}
                    className={`px-3 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer whitespace-nowrap ${
                      dspParams.bypassMode
                        ? 'bg-cyan-500 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Dry Bypass (GainNode)
                  </button>
                  <button
                    type="button"
                    onClick={() => updateParameter('bypassMode', false)}
                    className={`px-3 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer whitespace-nowrap ${
                      !dspParams.bypassMode
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Wet DSP Chain
                  </button>
                </div>
              </div>

              {/* Input / Dry GainNode Slider */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label
                    htmlFor="input-gain-slider"
                    className="text-slate-300 font-medium flex items-center gap-1.5"
                  >
                    <Volume2 className="w-3.5 h-3.5 text-cyan-400" />
                    Input / Dry GainNode (`gain.value`)
                  </label>
                  <span className="font-mono text-sm font-semibold text-cyan-400 tabular-nums">
                    {dspParams.inputGain.toFixed(2)}x{' '}
                    <span className="text-xs text-slate-500">
                      (
                      {dspParams.inputGain > 0
                        ? (20 * Math.log10(dspParams.inputGain)).toFixed(1)
                        : '-∞'}{' '}
                      dB)
                    </span>
                  </span>
                </div>
                <input
                  id="input-gain-slider"
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  value={dspParams.inputGain}
                  onChange={(e) => updateParameter('inputGain', parseFloat(e.target.value))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
              </div>

              {/* Master Output GainNode Slider */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="output-gain-slider" className="text-slate-300 font-medium">
                    Master Output GainNode (`destination`)
                  </label>
                  <span className="font-mono text-sm font-semibold text-slate-200 tabular-nums">
                    {dspParams.outputGain.toFixed(2)}x
                  </span>
                </div>
                <input
                  id="output-gain-slider"
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  value={dspParams.outputGain}
                  onChange={(e) => updateParameter('outputGain', parseFloat(e.target.value))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Right Main Viewport / Oscilloscope & Live Ballistic Headroom Stage (7 cols on lg) */}
          <div
            id="telemetry"
            className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#111827] p-6 flex flex-col justify-between space-y-6"
          >
            {/* Top Header & Visualizer Mode Selector */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <p className="text-xs font-mono text-cyan-400 tracking-wide">
                  02. REAL-TIME OSCILLOSCOPE &amp; BALLISTIC HEADROOM METERING
                </p>
                <h2 className="mt-0.5 text-lg font-semibold text-slate-100">
                  {dspParams.bypassMode
                    ? 'Direct Path: Source → InputGain → NoiseGate → DryGain → Destination'
                    : 'Active DSP Path: Source → NoiseGate → 4x Overdrive → Cab Filter → Delay'}
                </h2>
              </div>

              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#07090E] border border-slate-800">
                <button
                  type="button"
                  onClick={() => setVisualizerMode('waveform')}
                  className={`px-3 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                    visualizerMode === 'waveform'
                      ? 'bg-slate-800 text-cyan-400 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Time-Domain Wave
                </button>
                <button
                  type="button"
                  onClick={() => setVisualizerMode('spectrum')}
                  className={`px-3 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                    visualizerMode === 'spectrum'
                      ? 'bg-slate-800 text-cyan-400 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  FFT Spectrum
                </button>
              </div>
            </div>

            {/* High-Contrast Oscilloscope Canvas */}
            <div className="relative rounded-lg border border-slate-800 bg-[#07090E] overflow-hidden">
              <canvas
                ref={canvasRef}
                width={760}
                height={230}
                className="w-full h-[210px] sm:h-[230px] block cursor-crosshair"
              />
              {connectionStatus !== 'connected' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#07090E]/85 p-4 text-center">
                  <Activity className="w-6 h-6 text-cyan-400 mb-2" />
                  <p className="text-sm font-medium text-slate-200">
                    Oscilloscope Standby — Klik &ldquo;Connect Guitar / Start Audio&rdquo;
                  </p>
                  <p className="mt-1 text-xs font-mono text-slate-400 max-w-md">
                    Hubungkan audio interface gitar (Focusrite, iRig, Line-In) atau gunakan tombol{' '}
                    <span className="text-amber-300">Start with Test Guitar Synth</span> untuk menguji Noise Gate &amp; sinyal.
                  </p>
                </div>
              )}
              <div className="absolute top-2.5 left-3 right-3 flex items-center justify-between pointer-events-none text-[11px] font-mono text-slate-400 tabular-nums">
                <span>
                  PRE-GATE INPUT: {signalLevels.preGateDb.toFixed(1)} dBFS · GATE THRESHOLD:{' '}
                  {dspParams.noiseGateThresholdDb} dB
                </span>
                <span>
                  OUTPUT PEAK: {signalLevels.peakDb.toFixed(1)} dBFS · RMS:{' '}
                  {signalLevels.rmsDb.toFixed(1)} dBFS
                </span>
              </div>
            </div>

            {/* 60fps Ballistic Headroom Meter Bars (Pre-Gate Detector + Post-Gate Output) */}
            <div className="space-y-4">
              {/* Meter 1: Pre-Gate Input Signal vs Noise Gate Threshold */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="text-slate-400">
                    PRE-GATE DETECTOR LEVEL vs NOISE GATE THRESHOLD ({dspParams.noiseGateThresholdDb} dBFS)
                  </span>
                  <span
                    className={
                      !dspParams.noiseGateEnabled
                        ? 'text-slate-400'
                        : signalLevels.isGateOpen
                        ? 'text-emerald-400 font-semibold'
                        : 'text-amber-400 font-semibold'
                    }
                  >
                    {!dspParams.noiseGateEnabled
                      ? '○ GATE BYPASSED'
                      : signalLevels.isGateOpen
                      ? '● GATE OPEN · PASSING GUITAR'
                      : '▲ GATE CLOSED · HUM SUPPRESSED'}
                  </span>
                </div>
                <div className="relative h-3 w-full rounded-md bg-[#07090E] border border-slate-800 overflow-hidden">
                  {/* Smooth rAF + CSS transition Pre-Gate Bar */}
                  <div
                    ref={preGateInputBarRef}
                    className={`h-full w-full origin-left transition-transform duration-75 ease-out will-change-transform ${
                      signalLevels.isGateOpen ? 'bg-emerald-400/80' : 'bg-slate-600'
                    }`}
                    style={{ transform: 'scaleX(0)' }}
                  />
                  {/* Threshold Marker Line */}
                  {dspParams.noiseGateEnabled && (
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-10"
                      style={{ left: `${gateThresholdMarkerPct}%` }}
                      title={`Noise Gate Threshold: ${dspParams.noiseGateThresholdDb} dBFS`}
                    />
                  )}
                </div>
              </div>

              {/* Meter 2: Post-Gate Master Output Headroom (Peak + RMS + Peak-Hold Needle) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="text-slate-400">
                    POST-GATE OUTPUT HEADROOM METER (60FPS BALLISTIC PEAK &amp; RMS)
                  </span>
                  <span
                    className={
                      signalLevels.clipping
                        ? 'text-rose-400 font-semibold'
                        : 'text-cyan-400'
                    }
                  >
                    {signalLevels.clipping
                      ? '✖ CLIPPING (> -0.2 dBFS)'
                      : `● HEADROOM NOMINAL (${signalLevels.peakDb.toFixed(1)} dBFS)`}
                  </span>
                </div>
                <div className="relative h-3.5 w-full rounded-md bg-[#07090E] border border-slate-800 overflow-hidden">
                  {/* Instantaneous Peak Bar (Translucent Layer) */}
                  <div
                    ref={postGatePeakBarRef}
                    className={`absolute inset-0 origin-left transition-transform duration-75 ease-out will-change-transform ${
                      signalLevels.clipping
                        ? 'bg-rose-500/45'
                        : 'bg-cyan-400/35'
                    }`}
                    style={{ transform: 'scaleX(0)' }}
                  />
                  {/* Solid Ballistic RMS Body Bar */}
                  <div
                    ref={postGateRmsBarRef}
                    className={`absolute inset-0 origin-left transition-transform duration-75 ease-out will-change-transform ${
                      signalLevels.clipping
                        ? 'bg-rose-500'
                        : 'bg-gradient-to-r from-cyan-500 via-cyan-400 to-amber-400'
                    }`}
                    style={{ transform: 'scaleX(0)' }}
                  />
                  {/* Floating Peak-Hold Indicator Cursor */}
                  <div
                    ref={postGatePeakHoldRef}
                    className="absolute top-0 bottom-0 w-0.5 bg-white/90 z-10 transition-[left] duration-75 ease-out"
                    style={{ left: '0%' }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 tabular-nums">
                  <span>-60 dB</span>
                  <span>-48 dB</span>
                  <span>-36 dB</span>
                  <span>-24 dB</span>
                  <span>-12 dB</span>
                  <span>-6 dB</span>
                  <span className="text-rose-400">0 dB</span>
                </div>
              </div>

              {/* 4-Column Precision Telemetry Readout Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-slate-800 pt-4">
                <div>
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    SAMPLE RATE
                  </div>
                  <div className="mt-0.5 text-xl font-mono font-bold text-slate-100 tabular-nums">
                    {(telemetry.sampleRate / 1000).toFixed(1)}
                    <span className="text-xs font-mono text-slate-400 ml-1">kHz</span>
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    BASE LATENCY
                  </div>
                  <div className="mt-0.5 text-xl font-mono font-bold text-cyan-400 tabular-nums">
                    {telemetry.baseLatencyMs.toFixed(2)}
                    <span className="text-xs font-mono text-slate-400 ml-1">ms</span>
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    SIGNAL ROUTING
                  </div>
                  <div className="mt-0.5 text-sm font-mono font-semibold text-slate-200 pt-1">
                    {dspParams.bypassMode ? 'Dry GainNode (1:1)' : 'Tonebridge DSP Wet'}
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    SESSION STORAGE
                  </div>
                  <div className="mt-0.5 text-xs font-mono font-semibold text-emerald-400 pt-1.5 tabular-nums">
                    Saved · {lastSavedTimestamp}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 2: Dynamics Processor (Noise Gate) + Tonebridge-Style Pedal Chain & localStorage Persistence */}
        <section id="presets" className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <p className="text-xs font-mono text-amber-400 tracking-wide">
                03. DYNAMICS NOISE GATE &amp; TONEBRIDGE DSP PEDALBOARD
              </p>
              <h2 className="mt-0.5 text-lg font-semibold text-slate-100">
                Configurable Threshold Noise Gate &amp; Persistent Tone Tweaks (`localStorage`)
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {TONE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    activePresetId === preset.id
                      ? 'bg-cyan-500 text-slate-950 font-semibold'
                      : 'bg-[#07090E] text-slate-300 border border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {preset.name}
                </button>
              ))}

              <button
                type="button"
                onClick={handleResetSavedParameters}
                className="px-3 py-1.5 rounded-lg text-xs font-mono text-slate-300 bg-[#07090E] border border-slate-700 hover:border-rose-500/50 hover:text-rose-300 transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                title="Reset all saved parameters in localStorage back to factory defaults"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Saved Tweaks</span>
              </button>
            </div>
          </div>

          {/* 4 DSP Stage Modules: Stage 1 Noise Gate + Stage 2 Overdrive + Stage 3 Cabinet + Stage 4 Delay */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Stage 1: Dynamics & Threshold Noise Gate */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-emerald-400" />
                  Stage 1 · Noise Gate
                </span>
                <button
                  type="button"
                  onClick={() => updateParameter('noiseGateEnabled', !dspParams.noiseGateEnabled)}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono cursor-pointer transition-colors ${
                    dspParams.noiseGateEnabled
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {dspParams.noiseGateEnabled ? 'ACTIVE' : 'BYPASS'}
                </button>
              </div>
              <p className="text-xs text-slate-400">
                Meredam hum 60Hz dan derau latar secara otomatis saat senar gitar tidak dipetik.
              </p>
              <div className="pt-1 space-y-2.5">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-slate-300">THRESHOLD</span>
                    <span className="text-emerald-400 tabular-nums">
                      {dspParams.noiseGateThresholdDb} dBFS
                    </span>
                  </div>
                  <input
                    type="range"
                    min="-80"
                    max="-15"
                    step="1"
                    disabled={!dspParams.noiseGateEnabled}
                    value={dspParams.noiseGateThresholdDb}
                    onChange={(e) =>
                      updateParameter('noiseGateThresholdDb', parseInt(e.target.value, 10))
                    }
                    className="w-full accent-emerald-400 cursor-pointer disabled:opacity-40"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-slate-300">RELEASE ENVELOPE</span>
                    <span className="text-slate-300 tabular-nums">
                      {dspParams.noiseGateReleaseMs} ms
                    </span>
                  </div>
                  <input
                    type="range"
                    min="20"
                    max="400"
                    step="5"
                    disabled={!dspParams.noiseGateEnabled}
                    value={dspParams.noiseGateReleaseMs}
                    onChange={(e) =>
                      updateParameter('noiseGateReleaseMs', parseInt(e.target.value, 10))
                    }
                    className="w-full accent-emerald-400 cursor-pointer disabled:opacity-40"
                  />
                </div>
              </div>
            </div>

            {/* Stage 2: Tube Overdrive WaveShaper */}
            <div className="space-y-3 md:border-l md:border-slate-800 md:pl-6">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-amber-400" />
                  Stage 2 · Tube Overdrive
                </span>
                <span className="text-xs font-mono text-slate-400">WaveShaper 4x</span>
              </div>
              <p className="text-xs text-slate-400">
                Kurva saturasi asimetris untuk mensimulasikan karakter distorsi tabung amplifier gitar.
              </p>
              <div className="pt-1 space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-300">DRIVE SATURATION</span>
                  <span className="text-amber-400 tabular-nums">{dspParams.driveAmount}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={dspParams.driveAmount}
                  onChange={(e) => {
                    updateParameter('bypassMode', false);
                    updateParameter('driveAmount', parseInt(e.target.value, 10));
                  }}
                  className="w-full accent-amber-400 cursor-pointer"
                />
              </div>
            </div>

            {/* Stage 3: Cabinet Low-Pass Filter */}
            <div className="space-y-3 lg:border-l lg:border-slate-800 lg:pl-6">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Radio className="w-4 h-4 text-cyan-400" />
                  Stage 3 · 4x12 Cabinet
                </span>
                <span className="text-xs font-mono text-slate-400">Biquad Lowpass</span>
              </div>
              <p className="text-xs text-slate-400">
                Meroll-off frekuensi tinggi yang tajam di atas 3.8 kHz layaknya speaker kabinet gitar asli.
              </p>
              <div className="pt-1 space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-300">CABINET CUTOFF</span>
                  <span className="text-cyan-400 tabular-nums">{dspParams.toneCutoffHz} Hz</span>
                </div>
                <input
                  type="range"
                  min="1200"
                  max="7500"
                  step="50"
                  value={dspParams.toneCutoffHz}
                  onChange={(e) => {
                    updateParameter('bypassMode', false);
                    updateParameter('toneCutoffHz', parseInt(e.target.value, 10));
                  }}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
              </div>
            </div>

            {/* Stage 4: Delay Network */}
            <div className="space-y-3 md:border-l md:border-slate-800 md:pl-6">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-cyan-400" />
                  Stage 4 · Stereo Delay
                </span>
                <span className="text-xs font-mono text-slate-400">DelayNode Loop</span>
              </div>
              <p className="text-xs text-slate-400">
                Jalur feedback echo yang tersimpan otomatis antar sesi browser via localStorage.
              </p>
              <div className="pt-1 space-y-2.5">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-slate-300">DELAY MIX</span>
                    <span className="text-cyan-400 tabular-nums">
                      {Math.round(dspParams.delayMix * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="0.65"
                    step="0.01"
                    value={dspParams.delayMix}
                    onChange={(e) => {
                      updateParameter('bypassMode', false);
                      updateParameter('delayMix', parseFloat(e.target.value));
                    }}
                    className="w-full accent-cyan-400 cursor-pointer"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-slate-300">DELAY TIME</span>
                    <span className="text-slate-300 tabular-nums">
                      {(dspParams.delayTimeSec * 1000).toFixed(0)} ms
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.08"
                    max="0.75"
                    step="0.01"
                    value={dspParams.delayTimeSec}
                    onChange={(e) => {
                      updateParameter('bypassMode', false);
                      updateParameter('delayTimeSec', parseFloat(e.target.value));
                    }}
                    className="w-full accent-cyan-400 cursor-pointer"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: Complete Project Foundation Blueprints (vite.config.js, vercel.json, audioEngine.js, App.tsx) */}
        <section id="blueprints" className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <p className="text-xs font-mono text-cyan-400 tracking-wide">
                04. PRODUCTION ARCHITECTURE BLUEPRINTS (UMAM GUITAR)
              </p>
              <h2 className="mt-0.5 text-lg font-semibold text-slate-100">
                Fondasi Proyek Lengkap: Konfigurasi Vite PWA, Vercel SPA, Audio Engine &amp; React UI
              </h2>
            </div>

            {/* Interactive File Selector Tabs */}
            <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-lg bg-[#07090E] border border-slate-800">
              {PROJECT_BLUEPRINTS.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setSelectedBlueprint(file)}
                  className={`px-3 py-1.5 rounded-md text-xs font-mono transition-colors cursor-pointer whitespace-nowrap ${
                    selectedBlueprint.id === file.id
                      ? 'bg-cyan-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {file.filename}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">{selectedBlueprint.title}</h3>
                <p className="text-xs text-slate-400 mt-0.5">{selectedBlueprint.description}</p>
              </div>
              <button
                type="button"
                onClick={() => handleCopyBlueprint(selectedBlueprint)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-[#07090E] text-xs font-mono text-slate-200 hover:border-cyan-500/60 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedId === selectedBlueprint.id ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Copy {selectedBlueprint.filename}</span>
                  </>
                )}
              </button>
            </div>

            <pre className="rounded-lg border border-slate-800 bg-[#07090E] p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
              <code>{selectedBlueprint.code}</code>
            </pre>
          </div>
        </section>
      </main>

      {/* Quiet Functional Footer */}
      <footer className="border-t border-slate-800/80 py-5 px-6 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <span>UMAM GUITAR · Real-Time Web Audio DSP &amp; Offline-Ready Vite PWA</span>
          <div className="flex items-center gap-3 font-mono">
            <a href="#workstation" className="hover:text-slate-300 transition-colors">
              Audio Console
            </a>
            <span aria-hidden="true">·</span>
            <a href="#presets" className="hover:text-slate-300 transition-colors">
              Noise Gate &amp; DSP
            </a>
            <span aria-hidden="true">·</span>
            <a href="#blueprints" className="hover:text-slate-300 transition-colors">
              Vercel &amp; PWA Configs
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
