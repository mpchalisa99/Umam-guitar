import React, { useState } from 'react';
import { Download, Smartphone, X, Check } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showModal, setShowModal] = useState(false);

  if (isInstalled) {
    return (
      <span className="text-xs font-mono text-emerald-400 whitespace-nowrap shrink-0">
        ● PWA Standalone Active
      </span>
    );
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-2 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 transition-colors cursor-pointer whitespace-nowrap shrink-0"
      >
        <Download className="w-3.5 h-3.5" />
        Install PWA App
      </button>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
      >
        <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
        {isIOS ? 'Install on iOS' : 'Offline PWA Info'}
      </button>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-[#111827] p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <h3 className="text-base font-semibold text-slate-100">
                Instalasi PWA & Mode Offline
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm text-slate-300 leading-relaxed">
              <p>
                Aplikasi DSP ini telah dikonfigurasi menggunakan{' '}
                <code className="font-mono text-cyan-400">vite-plugin-pwa</code>{' '}
                dan Workbox Service Worker sehingga seluruh aset statis, modul Web Audio, dan UI tersimpan di cache lokal.
              </p>

              {isIOS ? (
                <div className="rounded-lg border border-slate-800 bg-[#07090E] p-3.5 text-xs space-y-1.5">
                  <p className="font-semibold text-slate-200">Cara Install di iPhone / iPad (Safari):</p>
                  <p>1. Ketuk tombol <strong>Share (Bagikan)</strong> di bilah navigasi Safari.</p>
                  <p>2. Pilih <strong>Add to Home Screen (Tambah ke Layar Utama)</strong>.</p>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-800 bg-[#07090E] p-3.5 text-xs space-y-1.5">
                  <p className="font-semibold text-slate-200">Cara Install sebagai Aplikasi Desktop / Mobile:</p>
                  <p>1. Buka aplikasi di tab penuh (di luar pratinjau iframe) pada Chrome, Edge, atau Brave.</p>
                  <p>2. Klik ikon <strong>Install UMAM GUITAR</strong> pada address bar browser untuk menjalankan secara offline tanpa koneksi internet.</p>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1 text-xs font-mono text-emerald-400">
                <Check className="w-4 h-4 shrink-0" />
                <span>Service Worker & Static Asset Precache Siap</span>
              </div>
            </div>

            <button
              onClick={() => setShowModal(false)}
              className="mt-5 w-full rounded-lg bg-cyan-500 py-2.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 transition-colors cursor-pointer"
            >
              Mengerti
            </button>
          </div>
        </div>
      )}
    </>
  );
};
