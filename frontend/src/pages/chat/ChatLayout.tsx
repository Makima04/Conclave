import { type ReactNode, useState } from 'react';

export interface ChatLayoutProps {
  /** Left column: category rail + expanding settings panel. */
  left: ReactNode;
  /** Center column: chat messages. */
  center: ReactNode;
  /** Right column: input + debug rail. */
  right: ReactNode;
  /** Top header (brand / back / actions). */
  header?: ReactNode;
}

/**
 * Three-column chat layout:
 *   [56px rail] [center messages 1fr] [right input+debug]
 * The 56px icon rail is docked in-flow; the expanding settings PANEL floats as
 * an absolute overlay above the center (see `.chat-category-panel` in
 * chat-v3.css), so opening a category never squeezes the render pane.
 * Right rail is collapsible. Center scrolls.
 *
 * Narrow viewport (≤700px, e.g. browser DevTools docked): the left/right
 * columns drop out of the grid and become slide-in drawer overlays triggered
 * from a bar at the top of the center pane — instead of being `display:none`'d
 * and leaving an empty shell. Desktop layout is untouched.
 */
export function ChatLayout({ left, center, right, header }: ChatLayoutProps) {
  const [rightOpen, setRightOpen] = useState(true);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);

  function closeDrawers() {
    setLeftDrawerOpen(false);
    setRightDrawerOpen(false);
  }

  return (
    <div className="chat-page">
      {header && <header className="chat-header">{header}</header>}
      <div
        className="chat-workspace"
        style={{
          gridTemplateColumns: `56px minmax(0, 1fr) ${rightOpen ? '340px' : '0px'}`,
        }}
      >
        <aside className={`chat-sidebar chat-sidebar-left${leftDrawerOpen ? ' is-drawer-open' : ''}`}>{left}</aside>

        <main className="chat-render-pane">
          {/* Narrow-viewport drawer trigger bar. Hidden on desktop via CSS. */}
          <div className="chat-drawer-bar">
            <button type="button" className="chat-drawer-btn" onClick={() => setLeftDrawerOpen(o => !o)}>
              ☰ 设置
            </button>
            <button
              type="button"
              className="chat-drawer-btn"
              onClick={() => {
                setRightOpen(true); // ensure content is rendered before sliding it in
                setRightDrawerOpen(o => !o);
              }}
            >
              输入/调试 ☰
            </button>
          </div>
          {center}
        </main>

        <aside
          className={`chat-sidebar chat-sidebar-right${rightDrawerOpen ? ' is-drawer-open' : ''}${
            rightOpen ? '' : ' is-collapsed'
          }`}
        >
          <button
            type="button"
            className="chat-rail-toggle chat-rail-toggle-right"
            onClick={() => setRightOpen(open => !open)}
            aria-label={rightOpen ? '收起输入/调试栏' : '展开输入/调试栏'}
          >
            {rightOpen ? '»' : '«'}
          </button>
          {rightOpen && <div className="chat-sidebar-scroll">{right}</div>}
        </aside>
      </div>

      {/* Drawer scrim (narrow viewport only; CSS hides on desktop). */}
      {(leftDrawerOpen || rightDrawerOpen) && (
        <div className="chat-drawer-overlay" onClick={closeDrawers} />
      )}
    </div>
  );
}
