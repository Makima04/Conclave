import { useNavigate, useLocation } from 'react-router-dom';
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

  function handleCreateSession() {
    if (openNewSessionDialog?.()) {
      return;
    }
    navigate('/');
  }

  return (
    <aside className="sidebar" aria-label="主导航">
      <nav className="sidebar-nav">
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
