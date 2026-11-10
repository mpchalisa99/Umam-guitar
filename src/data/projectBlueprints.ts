export interface BlueprintFile {
  id: 'vite-config' | 'vercel-json' | 'audio-engine' | 'app-jsx';
  filename: string;
  title: string;
  description: string;
  language: string;
  code: string;
}

export const PROJECT_BLUEPRINTS: BlueprintFile[] = [
  {
    id: 'vite-config',
    filename: 'vite.config.js',
    title: '1. Konfigurasi Vite & PWA (vite.config.js)',
    description:
      'Konfigurasi Vite untuk UMAM GUITAR dengan vite-plugin-pwa dan Workbox Service Worker untuk meng-cache aset statis agar aplikasi berjalan penuh secara offline.',
    language: 'javascript',
    code: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'icon.svg',
        'apple-touch-icon.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'pwa-maskable-512x512.png',
      ],
      manifest: {
        id: '/',
        name: 'UMAM GUITAR — Real-Time Web Audio DSP',
        short_name: 'UMAM GUITAR',
        description: 'Real-time Web Audio DSP guitar effects processor with threshold Noise Gate and offline PWA support.',
        theme_color: '#07090E',
        background_color: '#07090E',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,wav}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: '/index.html',
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
});`,
  },
  {
    id: 'vercel-json',
    filename: 'vercel.json',
    title: '2. Konfigurasi Vercel SPA & PWA (vercel.json)',
    description:
      'Konfigurasi standar deployment Vercel untuk memastikan routing Single Page Application (SPA) React di-rewrite ke index.html.',
    language: 'json',
    code: `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/sw.js",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=0, must-revalidate"
        },
        {
          "key": "Service-Worker-Allowed",
          "value": "/"
        }
      ]
    },
    {
      "source": "/manifest.webmanifest",
      "headers": [
        {
          "key": "Content-Type",
          "value": "application/manifest+json"
        }
      ]
    }
  ]
}`,
  },
  {
    id: 'audio-engine',
    filename: 'src/audioEngine.js',
    title: '3. Modul Audio Engine + Threshold Noise Gate (src/audioEngine.js)',
    description:
      'Inisialisasi AudioContext (latencyHint: "interactive"), input gitar murni tanpa pemrosesan suara WebRTC, serta modul Dynamics Processor dengan Threshold-Based Noise Gate untuk meredam hum saat gitar idle.',
    language: 'javascript',
    code: `/**
 * UMAM GUITAR — Core Audio Engine (audioEngine.js)
 * Menginisialisasi AudioContext dengan latencyHint: 'interactive',
 * menangkap sinyal instrumen murni, serta menyertakan Dynamics Processor
 * dengan Threshold-Based Noise Gate untuk menghilangkan hum saat gitar idle.
 */
export async function initGuitarAudioEngine(initialParams = {}) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;

  const audioContext = new AudioCtx({
    latencyHint: 'interactive',
  });

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  const sourceNode = audioContext.createMediaStreamSource(stream);
  const inputGainNode = audioContext.createGain();
  inputGainNode.gain.setValueAtTime(initialParams.inputGain ?? 1.0, audioContext.currentTime);

  // Dynamics & Noise Gate Processor Nodes
  const preGateAnalyser = audioContext.createAnalyser();
  preGateAnalyser.fftSize = 512;

  const noiseGateNode = audioContext.createGain();
  noiseGateNode.gain.setValueAtTime(1.0, audioContext.currentTime);

  const dynamicsCompressor = audioContext.createDynamicsCompressor();
  dynamicsCompressor.threshold.setValueAtTime(-20, audioContext.currentTime);
  dynamicsCompressor.ratio.setValueAtTime(3.5, audioContext.currentTime);

  const outputGainNode = audioContext.createGain();
  outputGainNode.gain.setValueAtTime(initialParams.outputGain ?? 0.95, audioContext.currentTime);

  // Signal Routing: Source -> InputGain -> PreGateAnalyser + NoiseGate -> Compressor -> OutputGain -> Destination
  sourceNode.connect(inputGainNode);
  inputGainNode.connect(preGateAnalyser);
  inputGainNode.connect(noiseGateNode);
  noiseGateNode.connect(dynamicsCompressor);
  dynamicsCompressor.connect(outputGainNode);
  outputGainNode.connect(audioContext.destination);

  // Real-time Threshold Noise Gate Envelope Follower
  let gateThresholdDb = initialParams.noiseGateThresholdDb ?? -46;
  let gateEnabled = initialParams.noiseGateEnabled ?? true;
  let isGateOpen = true;
  const detectorBuffer = new Float32Array(preGateAnalyser.fftSize);

  const gateInterval = setInterval(() => {
    if (!gateEnabled) {
      noiseGateNode.gain.setTargetAtTime(1.0, audioContext.currentTime, 0.005);
      isGateOpen = true;
      return;
    }
    preGateAnalyser.getFloatTimeDomainData(detectorBuffer);
    let sumSq = 0;
    for (let i = 0; i < detectorBuffer.length; i++) {
      sumSq += detectorBuffer[i] * detectorBuffer[i];
    }
    const rms = Math.sqrt(sumSq / detectorBuffer.length);
    const db = rms > 0.00001 ? 20 * Math.log10(rms) : -80;

    if (isGateOpen && db < gateThresholdDb - 2.5) {
      isGateOpen = false;
      noiseGateNode.gain.setTargetAtTime(0.0, audioContext.currentTime, 0.04); // Smooth release
    } else if (!isGateOpen && db >= gateThresholdDb) {
      isGateOpen = true;
      noiseGateNode.gain.setTargetAtTime(1.0, audioContext.currentTime, 0.0025); // Fast attack
    }
  }, 10);

  return {
    audioContext,
    stream,
    setGateThreshold: (db) => { gateThresholdDb = db; },
    setGateEnabled: (enabled) => { gateEnabled = enabled; },
    stopAudio: async () => {
      clearInterval(gateInterval);
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
    },
  };
}`,
  },
  {
    id: 'app-jsx',
    filename: 'src/App.tsx',
    title: '4. Komponen Utama UMAM GUITAR (src/App.tsx)',
    description:
      'Antarmuka utama UMAM GUITAR dengan animasi headroom meter berbasis requestAnimationFrame + CSS transitions, kontrol Threshold Noise Gate, dan penyimpanan parameter otomatis di localStorage.',
    language: 'tsx',
    code: `// Contoh integrasi penyimpanan localStorage & animasi Headroom Meter di App.tsx:
const STORAGE_KEY = 'umam_guitar_dsp_params_v1';

// 1. Inisialisasi state dari localStorage
const [dspParams, setDspParams] = useState(() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? { ...DEFAULT_DSP_PARAMS, ...JSON.parse(saved) } : DEFAULT_DSP_PARAMS;
});

// 2. Simpan setiap perubahan parameter (drive, cutoff, delay, noise gate) ke localStorage
useEffect(() => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dspParams));
}, [dspParams]);

// 3. Animasi halus Headroom Meter di dalam requestAnimationFrame loop
const smoothedPeakPct = prevSmoothed + (targetPct - prevSmoothed) * 0.35;
if (peakBarRef.current) {
  peakBarRef.current.style.transform = \`scaleX(\${smoothedPeakPct / 100})\`;
}`,
  },
];
