import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2.5 rounded-lg border border-amber-500/40 bg-slate-950/95 px-3.5 py-2 text-xs font-mono text-amber-400 shadow-lg">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>▲ OFFLINE MODE · Running from Service Worker Cache</span>
    </div>
  );
};
