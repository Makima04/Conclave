// CardRenderLab — 开发用卡片渲染验证页（M0 交付物）
// 路由：/lab，仅在 dev 环境可用
// 功能：加载 fixture 卡片 PNG → 提取嵌入 JSON → 用现有渲染管线渲染开场白 → 捕获 console.error 显示在侧栏

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { renderCardIframeHtml } from './card-content';
import { IframeHtmlRuntimeHost } from './components/IframeHtmlRuntimeHost';
import type { CharacterCard } from '../api/types';

// ── PNG 元数据提取 ──

/**
 * 从 ST 格式 PNG 文件中提取角色卡 JSON。
 * ST 卡片在 PNG 的 tEXt chunk 中以 key "chara"（或 "Source"）存储 base64 编码的 JSON。
 */
async function extractCardFromPng(file: File): Promise<Record<string, unknown>> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // 验证 PNG 签名
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
          const json = atob(b64);
          return JSON.parse(json);
        }
      }
    }

    // 跳过 iTXt chunk（部分工具用 iTXt 而非 tEXt）
    if (type === 'iTXt') {
      const data = bytes.slice(offset + 8, offset + 8 + length);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const key = new TextDecoder().decode(data.slice(0, nullIdx));
        if (key === 'chara' || key === 'Source') {
          // iTXt: compressionFlag(1) + compressionMethod(1) + languageTag(0) + translatedKeyword(0) + text
          const textStart = data.indexOf(0, nullIdx + 1) + 1; // skip translated keyword
          const textStart2 = data.indexOf(0, textStart) + 1;
          // compression flag
          const compressionFlag = data[nullIdx + 1];
          let textBytes: Uint8Array;
          if (compressionFlag === 1) {
            // zlib compressed — skip for now, would need DecompressionStream
            throw new Error('iTXt chunk 使用压缩，暂不支持');
          }
          textBytes = data.slice(textStart2);
          const text = new TextDecoder().decode(textBytes).trim();
          // 检查是否是 base64（ST 格式）还是纯 JSON
          try {
            return JSON.parse(text);
          } catch {
            return JSON.parse(atob(text));
          }
        }
      }
    }

    // IEND chunk — 结束
    if (type === 'IEND') break;

    offset += 12 + length; // 4(length) + 4(type) + length + 4(CRC)
  }

  throw new Error('PNG 中未找到角色卡元数据（tEXt chara/Source chunk）');
}

// ── Fixture 卡片信息 ──

interface FixtureCard {
  slug: string;
  name: string;
  file: string;
  /** 动态 import 的 PNG URL */
  pngUrl: string;
}

// Vite 会自动 serve public/ 下的文件，fixtures 放在 public/fixtures/cards/
const FIXTURE_CARDS: FixtureCard[] = [
  { slug: 'cangxuanjie', name: '苍玄界', file: '3.X.png', pngUrl: '/fixtures/cards/cangxuanjie/3.X.png' },
  { slug: 'bianshenshaonv', name: '变身少女', file: '-7.png', pngUrl: '/fixtures/cards/bianshenshaonv/-7.png' },
  { slug: 'lurenunzhu', name: '路人女主 v0.09', file: 'v0.09.png', pngUrl: '/fixtures/cards/lurenunzhu/v0.09.png' },
  { slug: 'dahuangz', name: '大荒 z', file: 'z_30.png', pngUrl: '/fixtures/cards/dahuangz/z_30.png' },
];

// ── Console 拦截 ──

interface ConsoleEntry {
  id: number;
  level: 'error' | 'warn' | 'info';
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
        if (typeof a === 'object') {
          try { return JSON.stringify(a, null, 2); } catch { return String(a); }
        }
        return String(a);
      });
      setEntries(prev => [...prev, { id, level, args: serialized, time }]);
      // 仍然输出到浏览器控制台
      (level === 'error' ? origError : origWarn)(...args);
    };

    console.error = capture('error');
    console.warn = capture('warn');

    return () => {
      console.error = origError;
      console.warn = origWarn;
    };
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, clear };
}

// ── 组件 ──

export default function CardRenderLab() {
  const [selectedCard, setSelectedCard] = useState<FixtureCard | null>(null);
  const [cardJson, setCardJson] = useState<Record<string, unknown> | null>(null);
  const [cardName, setCardName] = useState('');
  const [openingContent, setOpeningContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { entries: consoleEntries, clear: clearConsole } = useConsoleCapture();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadCard = useCallback(async (card?: FixtureCard, file?: File) => {
    setLoading(true);
    setError('');
    setCardJson(null);
    setCardName('');
    setOpeningContent('');
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
      const name = String(json.name || json.char_name || '未知');
      setCardName(name);
      // ST 卡片的开场白字段
      const firstMes = String(json.first_mes || '');
      setOpeningContent(firstMes);
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

  // 构建渲染用的 CharacterCard 对象（最小化，仅用于 renderCardIframeHtml）
  const fakeCharacterCard: CharacterCard | null = cardJson ? {
    id: 'lab-fake',
    name: cardName,
    description: String(cardJson.description || ''),
    personality: String(cardJson.personality || ''),
    scenario: String(cardJson.scenario || ''),
    first_mes: String(cardJson.first_mes || ''),
    mes_example: String(cardJson.mes_example || ''),
    system_prompt: String(cardJson.system_prompt || ''),
    tags: [],
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: cardName,
      description: String(cardJson.description || ''),
      personality: String(cardJson.personality || ''),
      scenario: String(cardJson.scenario || ''),
      first_mes: String(cardJson.first_mes || ''),
      mes_example: String(cardJson.mes_example || ''),
      system_prompt: String(cardJson.system_prompt || ''),
      tags: [],
      creator_notes: String(cardJson.creator_notes || ''),
      character_book: (cardJson.data as Record<string, unknown>)?.character_book as any,
      extensions: (cardJson.data as Record<string, unknown>)?.extensions as Record<string, unknown> || {},
      alternate_greetings: (cardJson.data as Record<string, unknown>)?.alternate_greetings as string[] || [],
    },
    world_book_id: undefined,
    extensions: cardJson.extensions as Record<string, unknown> || {},
  } as any : null;

  // 构建 iframe HTML（使用现有管线）
  const iframeHtml = openingContent && fakeCharacterCard
    ? renderCardIframeHtml(
        openingContent,
        {},
        '用户',
        cardName,
        undefined, // sessionId
        undefined, // worldBookId
        fakeCharacterCard,
        undefined,  // runtime
        undefined,  // runtimeAssets
      )
    : '';

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
        <input
          ref={fileInputRef}
          type="file"
          accept=".png,.json"
          onChange={handleFileUpload}
          style={{ display: 'none' }}
        />
      </aside>

      {/* 中间：渲染预览 */}
      <main style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        <div style={{ marginBottom: 12, fontSize: 12, color: '#888' }}>
          CardRenderLab — 迁移前基线验证（现有 v3 管线）
        </div>

        {loading && <div style={{ color: '#6c63ff' }}>加载中...</div>}
        {error && <div style={{ color: '#ff6b6b', padding: 12, background: '#2a1a1a', borderRadius: 6 }}>{error}</div>}

        {cardName && (
          <div style={{ marginBottom: 12 }}>
            <strong style={{ fontSize: 16 }}>{cardName}</strong>
            {'spec' in (cardJson || {}) && <span style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>{String(cardJson!.spec)}</span>}
          </div>
        )}

        {iframeHtml && (
          <div style={{ background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
            <IframeHtmlRuntimeHost
              documentHtml={iframeHtml}
              variables={{}}
              runtime={undefined}
              sessionId="lab"
              worldBookId={undefined}
              onAction={(action) => console.info('[Lab] sandbox action:', action)}
              onMessagesChanged={() => console.info('[Lab] messages changed')}
            />
          </div>
        )}

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
          <button onClick={clearConsole} style={{ fontSize: 11, color: '#888', background: 'none', border: 'none', cursor: 'pointer' }}>
            清除
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', fontSize: 12, fontFamily: 'monospace' }}>
          {consoleEntries.length === 0 && (
            <div style={{ color: '#555' }}>暂无输出。选择一张卡片开始。</div>
          )}
          {consoleEntries.map(entry => (
            <div
              key={entry.id}
              style={{
                marginBottom: 6, padding: '4px 6px', borderRadius: 4,
                background: entry.level === 'error' ? '#2a1a1a' : entry.level === 'warn' ? '#2a2a1a' : 'transparent',
                borderLeft: `3px solid ${entry.level === 'error' ? '#ff6b6b' : entry.level === 'warn' ? '#f0a500' : '#444'}`,
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}
            >
              <span style={{ color: '#666', fontSize: 10 }}>{entry.time}</span>
              <span style={{ marginLeft: 4, color: entry.level === 'error' ? '#ff6b6b' : '#f0a500' }}>
                [{entry.level}]
              </span>
              <div style={{ marginTop: 2 }}>{entry.args.join(' ')}</div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
