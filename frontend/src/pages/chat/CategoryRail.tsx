export interface CategoryItem {
  key: string;
  label: string;
  icon: string;
}

export interface CategoryRailProps {
  items: CategoryItem[];
  active: string | null;
  onSelect: (key: string | null) => void;
}

/**
 * Narrow 56px icon rail (like the homepage Sidebar). Clicking an inactive item
 * selects it; clicking the active item again collapses it (onSelect(null)).
 * Styles live in chat-v3.css (`.chat-cat-*`); the homepage's `sidebar.css`
 * is NOT loaded here since the chat page is outside AppShell.
 */
export function CategoryRail({ items, active, onSelect }: CategoryRailProps) {
  return (
    <nav className="chat-category-rail" aria-label="设置分类">
      {items.map(item => {
        const isActive = active === item.key;
        return (
          <button
            key={item.key}
            type="button"
            className={`chat-cat-item${isActive ? ' active' : ''}`}
            onClick={() => onSelect(isActive ? null : item.key)}
            aria-label={item.label}
            aria-pressed={isActive}
          >
            <span className="chat-cat-icon">{item.icon}</span>
            <span className="chat-cat-tooltip">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
