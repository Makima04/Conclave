import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  importCharacterCard,
  runImportForCard,
  confirmImport,
  requestLlmAssist,
  getRawPreview,
  saveFailureSample,
} from '../api/client';
import type { ImportDraftResponse, LlmAssistResponse } from '../api/types';
import { PipelineVisualization } from './import/PipelineVisualization';
import { RuleTracePanel } from './import/RuleTracePanel';
import { DiagnosticsPanel } from './import/DiagnosticsPanel';
import { PackagePreview } from './import/PackagePreview';
import { LlmAssistPanel } from './import/LlmAssistPanel';
import { ActionBar } from './import/ActionBar';
import { buildSandboxDocument } from './sandbox-document';
import '../styles/import-workbench.css';

interface NavItem {
  id: string;
  label: string;
  condition?: boolean;
}

export default function ImportWorkbench() {
  const navigate = useNavigate();
  const { cardId } = useParams<{ cardId: string }>();
  const [searchParams] = useSearchParams();
  const worldBookId = searchParams.get('wb');
  const [draft, setDraft] = useState<ImportDraftResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmResult, setLlmResult] = useState<LlmAssistResponse | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [rawPreviewHtml, setRawPreviewHtml] = useState<string | null>(null);
  const [rawPreviewEvents, setRawPreviewEvents] = useState<Array<{ action: string; payload: unknown }>>([]);
  const [activeTab, setActiveTab] = useState('section-pipeline');

  const runCardImport = useCallback(async (id: string, cancelledRef?: { current: boolean }) => {
    setUploading(true);
    setError(null);
    setLlmResult(null);
    setRawPreviewHtml(null);
    setRawPreviewEvents([]);
    try {
      const result = await runImportForCard(id);
      if (!cancelledRef?.current) setDraft(result);
    } catch (e: any) {
      if (!cancelledRef?.current) setError(e.message || 'Import failed');
    } finally {
      if (!cancelledRef?.current) setUploading(false);
    }
  }, []);

  // Auto-load mode: when cardId is present, run import pipeline on mount
  useEffect(() => {
    if (!cardId) return;
    const cancelledRef = { current: false };
    runCardImport(cardId, cancelledRef);
    return () => { cancelledRef.current = true; };
  }, [cardId, runCardImport]);

  const handleFileUpload = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const result = await importCharacterCard(file);
      setDraft(result);
    } catch (e: any) {
      setError(e.message || 'Import failed');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileUpload(file);
    },
    [handleFileUpload],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileUpload(file);
    },
    [handleFileUpload],
  );

  const handleConfirm = useCallback(
    async (degradeToSchema?: boolean) => {
      if (!draft) return;
      try {
        const result = await confirmImport(draft.import_id, {
          degrade_to_schema: degradeToSchema,
          world_book_id: worldBookId || undefined,
        });
        // Navigate to the character card detail page
        navigate(`/charactercards/${result.character_card_id}`);
      } catch (e: any) {
        setError(e.message || 'Save failed');
      }
    },
    [draft, navigate, worldBookId],
  );

  const handleLlmAssist = useCallback(
    async (type: string) => {
      if (!draft) return;
      setLlmLoading(true);
      try {
        const result = await requestLlmAssist(draft.import_id, {
          type: type as any,
        });
        setLlmResult(result);
      } catch (e: any) {
        setError(e.message || 'LLM assist failed');
      } finally {
        setLlmLoading(false);
      }
    },
    [draft],
  );

  const handleRawPreview = useCallback(async () => {
    if (!draft) return;
    try {
      const result = await getRawPreview(draft.import_id);
      setRawPreviewHtml(result.html);
      setRawPreviewEvents([]);
      setActiveTab('section-raw-preview');
    } catch (e: any) {
      setError(e.message || 'Preview failed');
    }
  }, [draft]);

  const handleSaveFailure = useCallback(async () => {
    if (!draft) return;
    try {
      await saveFailureSample(draft.import_id);
    } catch (e: any) {
      setError(e.message || 'Save failed');
    }
  }, [draft]);

  const handleBack = useCallback(() => {
    if (worldBookId) {
      navigate(`/worldbooks?wb=${worldBookId}`);
    } else {
      navigate(-1);
    }
  }, [worldBookId, navigate]);

  // In-page nav items
  const navItems: NavItem[] = [
    { id: 'section-pipeline', label: '导入流水线' },
    { id: 'section-rule-traces', label: '规则命中' },
    { id: 'section-diagnostics', label: '诊断信息' },
    { id: 'section-package-draft', label: '卡包草案' },
    { id: 'section-raw-preview', label: '原始预览', condition: !!rawPreviewHtml },
  ];

  return (
    <div className="import-workbench">
      {/* Header */}
      <div className="import-header">
        <button onClick={handleBack} className="btn-back">
          {'←'} 返回
        </button>
        <h1>导入工作台</h1>
        {draft && (
          <span
            className={`status-badge status-${draft.import_report.status}`}
          >
            {draft.import_report.status}
          </span>
        )}
      </div>

      {/* Loading state (auto-load mode) */}
      {cardId && uploading && (
        <div className="upload-zone">
          <div className="upload-spinner">正在解析角色卡...</div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="upload-zone" style={{ borderColor: 'var(--danger)' }}>
          <div className="upload-error">{error}</div>
          {worldBookId && (
            <button className="btn btn-secondary" onClick={() => navigate(`/worldbooks?wb=${worldBookId}`)}>
              返回世界书
            </button>
          )}
        </div>
      )}

      {/* Upload zone (standalone mode, no cardId) */}
      {!cardId && !draft && !error && (
        <div
          className={`upload-zone ${uploading ? 'uploading' : ''}`}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          <p>拖放角色卡文件到此处（PNG / JSON）</p>
          <label className="upload-btn">
            选择文件
            <input
              type="file"
              accept=".png,.json"
              onChange={handleFileInput}
              hidden
            />
          </label>
          {uploading && <div className="upload-spinner">解析中...</div>}
        </div>
      )}

      {/* In-page navigation (shown when draft is loaded) */}
      {draft && (
        <nav className="iw-nav" aria-label="页内导航">
          {navItems.map((item) =>
            item.condition === false ? null : (
              <button
                key={item.id}
                className={`iw-nav-item ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => setActiveTab(item.id)}
              >
                {item.label}
              </button>
            ),
          )}
        </nav>
      )}

      {/* Results (shown when draft exists) */}
      {draft && (
        <>
          <main className="iw-tab-panel">
            {activeTab === 'section-pipeline' && (
              <PipelineVisualization stages={draft.import_report.stages} />
            )}

            {activeTab === 'section-rule-traces' && (
              <RuleTracePanel traces={draft.import_report.rule_traces} />
            )}

            {activeTab === 'section-diagnostics' && (
              <DiagnosticsPanel diagnostics={draft.import_report.diagnostics} />
            )}

            {activeTab === 'section-package-draft' && (
              <>
                <PackagePreview packageDraft={draft.package_draft} />
                <LlmAssistPanel result={llmResult} loading={llmLoading} />
              </>
            )}

            {activeTab === 'section-raw-preview' && rawPreviewHtml && (
            <div className="raw-preview-panel" id="section-raw-preview">
              <h3>原始 ST Sandbox 预览</h3>
              <RawPreviewFrame
                html={rawPreviewHtml}
                events={rawPreviewEvents}
                onEvent={(event) => {
                  setRawPreviewEvents((items) => [event, ...items].slice(0, 20));
                }}
              />
            </div>
            )}
          </main>

          {/* Action bar */}
          <ActionBar
            status={draft.import_report.status}
            onConfirm={() => handleConfirm()}
            onDegrade={() => handleConfirm(true)}
            onLlmAssist={handleLlmAssist}
            onRawPreview={handleRawPreview}
            onSaveFailure={handleSaveFailure}
            onReparse={() => {
              if (cardId) {
                runCardImport(cardId);
              } else {
                setDraft(null);
                setRawPreviewHtml(null);
                setRawPreviewEvents([]);
                setLlmResult(null);
              }
            }}
          />
        </>
      )}
    </div>
  );
}

function RawPreviewFrame({
  html,
  events,
  onEvent,
}: {
  html: string;
  events: Array<{ action: string; payload: unknown }>;
  onEvent: (event: { action: string; payload: unknown }) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(520);
  const documentHtml = useMemo(() => buildSandboxDocument(html, {}), [html]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (event.data?.type === 'sandbox-resize') {
        const next = Number(event.data.height);
        if (Number.isFinite(next)) {
          setHeight(Math.max(360, Math.min(1800, next)));
        }
      }
      if (event.data?.type === 'card-sandbox-action' && typeof event.data.action === 'string') {
        onEvent({ action: event.data.action, payload: event.data.payload || {} });
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onEvent]);

  const notableEvents = events.filter((event) => event.action === 'runtimeError' || event.action === 'missingApi');

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={documentHtml}
        sandbox="allow-scripts"
        className="raw-preview-iframe"
        style={{ height }}
      />
      {notableEvents.length > 0 && (
        <div className="raw-preview-events">
          {notableEvents.map((event, index) => (
            <div key={`${event.action}-${index}`} className="raw-preview-event">
              <span>{event.action}</span>
              <code>{JSON.stringify(event.payload).slice(0, 500)}</code>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
