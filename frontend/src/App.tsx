import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './contexts/AppContext';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import AppShell from './components/AppShell';
import './styles/global.css';
import './styles/session-list.css';

const SessionList = React.lazy(() => import('./pages/SessionList'));
const StHost = React.lazy(() => import('./pages/StHost'));
const Chat = React.lazy(() => import('./pages/Chat'));
const Settings = React.lazy(() => import('./pages/Settings'));
const AgentManager = React.lazy(() => import('./pages/AgentManager'));
const AgentInspector = React.lazy(() => import('./pages/inspector/Inspector'));
const WorldBooks = React.lazy(() => import('./pages/WorldBooks'));
const Presets = React.lazy(() => import('./pages/Presets'));
const CharacterCard = React.lazy(() => import('./pages/CharacterCard'));

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <AppProvider>
          <ErrorBoundary>
            <Suspense fallback={<div className="page-loading">加载中...</div>}>
              <Routes>
                {/* Routes WITH sidebar (AppShell layout) */}
                <Route element={<AppShell />}>
                  <Route path="/" element={<SessionList />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/worldbooks" element={<WorldBooks />} />
                  <Route path="/presets" element={<Presets />} />
                </Route>
                {/* Routes WITHOUT sidebar (full-screen tool-rail layouts) */}
                <Route path="/chat/:sessionId" element={<Chat />} />
                <Route path="/st-host/:sessionId" element={<StHost />} />
                <Route path="/chat/:sessionId/agents" element={<AgentManager />} />
                <Route path="/chat/:sessionId/inspector" element={<AgentInspector />} />
                <Route path="/charactercards/:id" element={<CharacterCard />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </AppProvider>
      </BrowserRouter>
    </ToastProvider>
  );
}
