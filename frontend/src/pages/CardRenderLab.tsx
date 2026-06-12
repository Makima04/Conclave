// CardRenderLab — 开发用卡片渲染验证页（M0 交付物）
// 路由：/lab，仅在 dev 环境可用
// 功能：加载 fixture 卡片 PNG → 提取嵌入 JSON → 用现有渲染管线渲染开场白 → 捕获 console.error 显示在侧栏
//
// 渲染管线与 Chat.tsx 一致：MessageContent → renderMessageHtml() → iframe/inline 路径

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageContent } from './components/MessageContent';
import type { CharacterCard, SessionRuntimeAssets } from '../api/types';

// ── PNG 元数据提取 ──

// ST PNG 的 base64 内容是 UTF-8 字节编码，atob() 返回 Latin1 二进制串，需要当 UTF-8 解码
function base64ToUtf8(b64: string): string {
  const binStr = atob(b64);
  const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function extractCardFromPng(file: File): Promise<Record<string, unknown>> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== pngSig[i]) throw new Error('不是有效的 PNG 文件');
  }

  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) break;
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);

    if (type === 'tEXt') {
      const data = bytes.slice(offset + 8, offset + 8 + length);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const key = new TextDecoder().decode(data.slice(0, nullIdx));
        if (key === 'chara' || key === 'Source') {
          const b64 = new TextDecoder().decode(data.slice(nullIdx + 1));
          return JSON.parse(base64ToUtf8(b64));
        }
      }
    }

    if (type === 'iTXt') {
      const data = bytes.slice(offset + 8, offset + 8 + length);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const key = new TextDecoder().decode(data.slice(0, nullIdx));
        if (key === 'chara' || key === 'Source') {
          const compressionFlag = data[nullIdx + 1];
          if (compressionFlag === 1) throw new Error('iTXt chunk 使用压缩，暂不支持');
          let textStart = nullIdx + 1;
          textStart = data.indexOf(0, textStart) + 1; // language tag
          textStart = data.indexOf(0, textStart) + 1; // translated keyword
          const text = new TextDecoder().decode(data.slice(textStart)).trim();
          try { return JSON.parse(text); } catch { return JSON.parse(base64ToUtf8(text)); }
        }
      }
    }

    if (type === 'IEND') break;
    offset += 12 + length;
  }

  throw new Error('PNG 中未找到角色卡元数据（tEXt chara/Source chunk）');
}

// ── 从卡片 JSON 构造 CharacterCard + runtimeAssets ──

function buildCharacterCard(json: Record<string, unknown>): CharacterCard {
  const data = (json.data as Record<string, unknown>) || {};
  return {
    id: 'lab-fake',
    name: String(json.name || ''),
    description: String(json.description || ''),
    personality: String(json.personality || ''),
    scenario: String(json.scenario || ''),
    first_mes: String(json.first_mes || ''),
    mes_example: String(json.mes_example || ''),
    system_prompt: String(json.system_prompt || ''),
    tags: [],
    spec: String(json.spec || 'chara_card_v2'),
    spec_version: String(json.spec_version || '2.0'),
    data: {
      name: String(data.name || json.name || ''),
      description: String(data.description || json.description || ''),
      personality: String(data.personality || json.personality || ''),
      scenario: String(data.scenario || json.scenario || ''),
      first_mes: String(data.first_mes || json.first_mes || ''),
      mes_example: String(data.mes_example || json.mes_example || ''),
      system_prompt: String(data.system_prompt || json.system_prompt || ''),
      tags: Array.isArray(data.tags) ? data.tags : [],
      creator_notes: String(data.creator_notes || ''),
      character_book: data.character_book as any,
      extensions: (data.extensions as Record<string, unknown>) || {},
      alternate_greetings: (data.alternate_greetings as string[]) || [],
    } as any,
    world_book_id: undefined,
    extensions: json.extensions as Record<string, unknown> || {},
  } as unknown as CharacterCard;
}

function extractRuntimeAssets(cardJson: Record<string, unknown>): SessionRuntimeAssets {
  const ext = (cardJson.extensions as Record<string, unknown>)
    || ((cardJson.data as Record<string, unknown>)?.extensions as Record<string, unknown>)
    || {};

  // regex_scripts: 卡片自带的 regex 脚本
  const rawRegex = ext.regex_scripts;
  const regex_scripts = Array.isArray(rawRegex)
    ? rawRegex.map(s => ({ ...s as Record<string, unknown>, source: { scope: 'card' } }))
    : [];

  // tavern_helper.scripts: 卡片自带的辅助脚本（浮动按钮、状态栏等）
  const th = ext.tavern_helper as Record<string, unknown> | undefined;
  const rawScripts = th?.scripts;
  const tavern_helper_scripts = Array.isArray(rawScripts)
    ? rawScripts.map((s: any) => ({
        name: s.name || '',
        code: s.code || s.script || '',
        type: s.type || 'script',
        source: { scope: 'card' },
      }))
    : [];

  return { regex_scripts, tavern_helper_scripts } as SessionRuntimeAssets;
}

// ── Fixture 卡片信息 ──

interface FixtureCard {
  slug: string;
  name: string;
  file: string;
  pngUrl: string;
}

const FIXTURE_CARDS: FixtureCard[] = [
  { slug: 'cangxuanjie', name: '苍玄界', file: '3.X.png', pngUrl: '/fixtures/cards/cangxuanjie/3.X.png' },
  { slug: 'bianshenshaonv', name: '变身少女', file: '-7.png', pngUrl: '/fixtures/cards/bianshenshaonv/-7.png' },
  { slug: 'lurenunzhu', name: '路人女主 v0.09', file: 'v0.09.png', pngUrl: '/fixtures/cards/lurenunzhu/v0.09.png' },
  { slug: 'dahuangz', name: '大荒 z', file: 'z_30.png', pngUrl: '/fixtures/cards/dahuangz/z_30.png' },
];

// ── Console 拦截 ──

interface ConsoleEntry {
  id: number;
  level: 'error' | 'warn';
  args: string[];
  time: string;
}

function useConsoleCapture() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const counterRef = useRef(0);

  useEffect(() => {
    const origError = console.error;
    const origWarn = console.warn;

    const capture = (level: 'error' | 'warn') => (...args: unknown[]) => {
      const id = ++counterRef.current;
      const time = new Date().toLocaleTimeString();
      const serialized = args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack}`;
        if (typeof a === 'object') { try { return JSON.stringify(a, null, 2); } catch { return String(a); } }
        return String(a);
      });
      setEntries(prev => [...prev, { id, level, args: serialized, time }]);
      (level === 'error' ? origError : origWarn)(...args);
    };

    console.error = capture('error');
    console.warn = capture('warn');
    return () => { console.error = origError; console.warn = origWarn; };
  }, []);

  const clear = useCallback(() => setEntries([]), []);
  return { entries, clear };
}

// ── 组件 ──

export default function CardRenderLab() {
  const [selectedCard, setSelectedCard] = useState<FixtureCard | null>(null);
  const [cardJson, setCardJson] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { entries: consoleEntries, clear: clearConsole } = useConsoleCapture();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadCard = useCallback(async (card?: FixtureCard, file?: File) => {
    setLoading(true);
    setError('');
    setCardJson(null);
    clearConsole();

    try {
      let json: Record<string, unknown>;
      if (file) {
        json = await extractCardFromPng(file);
      } else if (card?.pngUrl) {
        const res = await fetch(card.pngUrl);
        const blob = await res.blob();
        json = await extractCardFromPng(new File([blob], card.file, { type: 'image/png' }));
      } else {
        throw new Error('无卡片来源');
      }
      setCardJson(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [clearConsole]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadCard(undefined, file);
  }, [loadCard]);

  // 构造渲染所需数据（对齐 Chat.tsx 的 props 传法）
  const characterCard = cardJson ? buildCharacterCard(cardJson) : null;
  const runtimeAssets: SessionRuntimeAssets = cardJson
    ? extractRuntimeAssets(cardJson)
    : { regex_scripts: [], tavern_helper_scripts: [] };
  const userName = '用户';
  const openingContent = characterCard?.first_mes || '';
  const cardName = characterCard?.name || '';
  const altGreetings = (cardJson?.data as Record<string, unknown>)?.alternate_greetings as string[] || [];

  const errorCount = consoleEntries.filter(e => e.level === 'error').length;
  const warnCount = consoleEntries.filter(e => e.level === 'warn').length;

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#1a1a2e', color: '#e0e0e0' }}>
      {/* 左侧：卡片列表 */}
      <aside style={{ width: 220, borderRight: '1px solid #333', padding: 16, overflowY: 'auto', flexShrink: 0 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 14, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Fixtures
        </h2>
        {FIXTURE_CARDS.map(card => (
          <button
            key={card.slug}
            onClick={() => { setSelectedCard(card); loadCard(card); }}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
              marginBottom: 4, borderRadius: 6, border: '1px solid transparent',
              background: selectedCard?.slug === card.slug ? '#2d3454' : 'transparent',
              color: '#e0e0e0', cursor: 'pointer', fontSize: 13,
              borderColor: selectedCard?.slug === card.slug ? '#6c63ff' : 'transparent',
            }}
          >
            {card.name}
            <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>{card.slug}</span>
          </button>
        ))}
        <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '12px 0' }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            display: 'block', width: '100%', padding: '8px 10px', borderRadius: 6,
            border: '1px dashed #555', background: 'transparent', color: '#aaa',
            cursor: 'pointer', fontSize: 13,
          }}
        >
          + 上传 PNG 卡片
        </button>
        <input ref={fileInputRef} type="file" accept=".png,.json" onChange={handleFileUpload} style={{ display: 'none' }} />

        {/* 脚本信息 */}
        {cardJson && (
          <div style={{ marginTop: 16, fontSize: 11, color: '#666' }}>
            <div>regex scripts: {runtimeAssets.regex_scripts.length}</div>
            <div>tavern_helper scripts: {runtimeAssets.tavern_helper_scripts.length}</div>
            {altGreetings.length > 0 && <div>alternate greetings: {altGreetings.length}</div>}
          </div>
        )}
      </aside>

      {/* 中间：渲染预览（与 Chat.tsx 一致的 MessageContent 管线） */}
      <main style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        <div style={{ marginBottom: 12, fontSize: 12, color: '#888' }}>
          CardRenderLab — 迁移前基线（MessageContent 管线，等同对话时渲染）
        </div>

        {loading && <div style={{ color: '#6c63ff' }}>加载中...</div>}
        {error && <div style={{ color: '#ff6b6b', padding: 12, background: '#2a1a1a', borderRadius: 6 }}>{error}</div>}

        {cardName && (
          <div style={{ marginBottom: 16 }}>
            <strong style={{ fontSize: 18, color: '#fff' }}>{cardName}</strong>
            <span style={{ marginLeft: 8, fontSize: 11, color: '#666' }}>{String(cardJson?.spec || 'chara_card_v2')}</span>
          </div>
        )}

        {/* 开场白渲染——与 Chat.tsx opening-preview 区域一致 */}
        {characterCard && openingContent && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Opening Preview（主开场白）</div>
            <div className="message assistant opening-preview" style={{ background: '#fff', borderRadius: 8, padding: 16 }}>
              <div className="message-role" style={{ fontWeight: 600, marginBottom: 8, color: '#333' }}>{cardName}</div>
              <div className="message-content">
                <MessageContent
                  content={openingContent}
                  card={characterCard}
                  runtimeAssets={runtimeAssets}
                  variables={{}}
                  runtime={{}}
                  renderMode="auto"
                  userName={userName}
                />
              </div>
            </div>
          </div>
        )}

        {/* Alternate greetings 也渲染——更全面的回归覆盖 */}
        {altGreetings.map((greeting, idx) => (
          <div key={idx} style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
              Alternate Greeting #{idx + 1}
            </div>
            <div className="message assistant" style={{ background: '#fff', borderRadius: 8, padding: 16 }}>
              <div className="message-role" style={{ fontWeight: 600, marginBottom: 8, color: '#333' }}>{cardName}</div>
              <div className="message-content">
                <MessageContent
                  content={greeting}
                  card={characterCard}
                  runtimeAssets={runtimeAssets}
                  variables={{}}
                  runtime={{}}
                  renderMode="auto"
                  userName={userName}
                />
              </div>
            </div>
          </div>
        ))}

        {!cardName && !loading && !error && (
          <div style={{ color: '#555', textAlign: 'center', marginTop: 80, fontSize: 14 }}>
            ← 从左侧选择一张 fixture 卡片，或上传 PNG
          </div>
        )}
      </main>

      {/* 右侧：Console 侧栏 */}
      <aside style={{ width: 360, borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            Console
            {errorCount > 0 && <span style={{ color: '#ff6b6b', marginLeft: 6 }}>{errorCount} err</span>}
            {warnCount > 0 && <span style={{ color: '#f0a500', marginLeft: 6 }}>{warnCount} warn</span>}
          </span>
          <button onClick={clearConsole} style={{ fontSize: 11, color: '#888', background: 'none', border: 'none', cursor: 'pointer' }}>清除</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', fontSize: 12, fontFamily: 'monospace' }}>
          {consoleEntries.length === 0 && <div style={{ color: '#555' }}>暂无输出。选择一张卡片开始。</div>}
          {consoleEntries.map(entry => (
            <div
              key={entry.id}
              style={{
                marginBottom: 6, padding: '4px 6px', borderRadius: 4,
                background: entry.level === 'error' ? '#2a1a1a' : '#2a2a1a',
                borderLeft: `3px solid ${entry.level === 'error' ? '#ff6b6b' : '#f0a500'}`,
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}
            >
              <span style={{ color: '#666', fontSize: 10 }}>{entry.time}</span>
              <span style={{ marginLeft: 4, color: entry.level === 'error' ? '#ff6b6b' : '#f0a500' }}>[{entry.level}]</span>
              <div style={{ marginTop: 2 }}>{entry.args.join(' ')}</div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
