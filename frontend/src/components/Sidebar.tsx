import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import * as api from '../api/client';
import '../styles/sidebar.css';

interface NavItem {
  key: string;
  label: string;
  icon: string;
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'sessions',     label: '会话',   icon: '📋', path: '/' },
  { key: 'worldbooks',   label: '世界书', icon: '📖', path: '/worldbooks' },
  { key: 'presets',      label: '预设',   icon: '⚙', path: '/presets' },
  { key: 'settings',     label: '设置',   icon: '🔧', path: '/settings' },
  { key: 'lab',          label: '渲染实验室', icon: '🧪', path: '/lab' },
];

function isActive(pathname: string, itemPath: string): boolean {
  if (itemPath === '/') return pathname === '/';
  return pathname.startsWith(itemPath);
}

interface SidebarProps {
  openNewSessionDialog?: () => boolean;
}

export default function Sidebar({ openNewSessionDialog }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [openingStHost, setOpeningStHost] = useState(false);

  function handleCreateSession() {
    if (openNewSessionDialog?.()) {
      return;
    }
    navigate('/');
  }

  async function handleOpenStHost() {
    if (openingStHost) return;
    setOpeningStHost(true);
    try {
      const data = await api.listSessions({ limit: 1 });
      const session = data.items?.[0];
      if (!session) {
        window.alert('还没有可打开的会话，请先新建会话。');
        navigate('/');
        return;
      }
      navigate(`/st-host/${session.id}`);
    } catch (error) {
      console.error('Failed to open ST Host:', error);
      window.alert(error instanceof Error ? error.message : '打开 ST Host 失败');
    } finally {
      setOpeningStHost(false);
    }
  }

  return (
    <aside className="sidebar" aria-label="主导航">
      <nav className="sidebar-nav">
        <button
          className={`sidebar-item${location.pathname.startsWith('/st-host') ? ' active' : ''}`}
          onClick={() => void handleOpenStHost()}
          disabled={openingStHost}
          aria-label="ST Host"
          title="ST Host"
        >
          <span>🖥</span>
          <span className="sidebar-tooltip">ST Host</span>
        </button>
        {NAV_ITEMS.map(item => (
          <button
            key={item.key}
            className={`sidebar-item${isActive(location.pathname, item.path) ? ' active' : ''}`}
            onClick={() => navigate(item.path)}
            aria-label={item.label}
          >
            <span>{item.icon}</span>
            <span className="sidebar-tooltip">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button
          className="sidebar-new-btn"
          aria-label="新建会话"
          title="新建会话"
          onClick={handleCreateSession}
        >
          <span>+</span>
        </button>
      </div>
    </aside>
  );
}
