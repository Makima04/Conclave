import { BrowserRouter, Routes, Route } from 'react-router-dom';
import SessionList from './pages/SessionList';
import Chat from './pages/Chat';
import Settings from './pages/Settings';
import AgentManager from './pages/AgentManager';
import WorldBooks from './pages/WorldBooks';
import CharacterCardPage from './pages/CharacterCard';
import Presets from './pages/Presets';
import './styles/global.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SessionList />} />
        <Route path="/chat/:sessionId" element={<Chat />} />
        <Route path="/chat/:sessionId/agents" element={<AgentManager />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/worldbooks" element={<WorldBooks />} />
        <Route path="/presets" element={<Presets />} />
        <Route path="/charactercards/:id" element={<CharacterCardPage />} />
      </Routes>
    </BrowserRouter>
  );
}
