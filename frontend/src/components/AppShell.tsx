import { useCallback, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import '../styles/app-shell.css';

export interface AppShellOutletContext {
  registerOpenNewSessionDialog?: (handler: (() => void) | null) => void;
}

export default function AppShell() {
  const openNewSessionDialogRef = useRef<(() => void) | null>(null);

  const registerOpenNewSessionDialog = useCallback((handler: (() => void) | null) => {
    openNewSessionDialogRef.current = handler;
  }, []);

  return (
    <div className="app-shell">
      <Sidebar
        openNewSessionDialog={() => {
          if (!openNewSessionDialogRef.current) return false;
          openNewSessionDialogRef.current();
          return true;
        }}
      />
      <main className="app-main">
        <Outlet context={{ registerOpenNewSessionDialog } satisfies AppShellOutletContext} />
      </main>
    </div>
  );
}
