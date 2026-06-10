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
import { ContractWorkbench } from './import/ContractWorkbench';
import { LlmAssistPanel } from './import/LlmAssistPanel';
import { ActionBar } from './import/ActionBar';
import { buildSandboxDocument } from './sandbox-document';
import '../styles/import-workbench.css';

interface NavItem {
  id: string;
  label: string;
  condition?: boolean;
}

const MIN_RAW_PREVIEW_IFRAME_HEIGHT = 360;
const MAX_RAW_PREVIEW_IFRAME_HEIGHT = 720;

function summarizeDiagnostics(diagnostics: ImportDraftResponse['import_report']['diagnostics']) {
  return diagnostics.reduce(
    (acc, diagnostic) => {
      acc[diagnostic.level] += 1;
      return acc;
    },
    { error: 0, warn: 0, info: 0 },
  );
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

  const draftSummary = useMemo(() => {
    if (!draft) return null;

    const diagnostics = summarizeDiagnostics(draft.import_report.diagnostics);
    const packageDraft = draft.package_draft;
    const variableCount = packageDraft.variables.length;
    const stateFieldCount = packageDraft.state_schema?.fields.length || 0;
    const mappedStateCount =
      packageDraft.state_schema?.fields.filter((field) => Boolean(field.canonical_path)).length || 0;
    const extractedSignalCount =
      (packageDraft.extraction_layers?.state_signals.length || 0)
      + (packageDraft.extraction_layers?.ui_signals.length || 0)
      + (packageDraft.extraction_layers?.action_signals.length || 0);
    const apiWarnings =
      packageDraft.compatibility.unsupported_apis.length + packageDraft.compatibility.warnings.length;
    const renderCritical = draft.import_report.stages.filter(
      (stage) =>
        stage.status === 'error' ||
        ((stage.id === 'html_split' || stage.id === 'package_build') && stage.status === 'warning'),
    );
    const runtimeWarnings = draft.import_report.stages.filter((stage) =>
      ['action_extract', 'variable_extract', 'state_adapter', 'js_parse'].includes(stage.id) &&
      stage.status !== 'success',
    );
    const saveTarget = worldBookId
      ? {
          label: '更新当前角色工作台关联卡包',
          detail: '保存后会覆盖当前世界书源数据、关联角色卡原始数据，并写入新的导入报告。',
        }
      : {
          label: '创建新的角色卡包记录',
          detail: '保存后会新建世界书、角色卡与导入报告，再交给前端运行时渲染。',
        };

    return {
      diagnostics,
      variableCount,
      stateFieldCount,
      mappedStateCount,
      extractedSignalCount,
      actionCount: packageDraft.actions.length,
      apiWarnings,
      renderCritical,
      runtimeWarnings,
      saveTarget,
    };
  }, [draft, worldBookId]);

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
          {draftSummary && (
            <section className="import-overview">
              <div className="overview-card overview-card-primary">
                <span className="overview-eyebrow">当前阶段</span>
                <h2>分析草案已生成，尚未写入正式卡包</h2>
                <p>
                  这里展示的是导入器对 ST 原始数据的拆解结果。最终渲染是否稳定，取决于保存后的统一运行时模型，而不是单个补丁规则。
                </p>
                <div className="overview-stats" aria-label="草案摘要">
                  <div className="overview-stat">
                    <span>变量</span>
                    <strong>{draftSummary.variableCount}</strong>
                  </div>
                  <div className="overview-stat">
                    <span>状态映射</span>
                    <strong>
                      {draftSummary.stateFieldCount > 0
                        ? `${draftSummary.mappedStateCount}/${draftSummary.stateFieldCount}`
                        : '未检测'}
                    </strong>
                  </div>
                  <div className="overview-stat">
                    <span>动作</span>
                    <strong>{draftSummary.actionCount}</strong>
                  </div>
                  <div className="overview-stat">
                    <span>提取信号</span>
                    <strong>{draftSummary.extractedSignalCount}</strong>
                  </div>
                  <div className="overview-stat">
                    <span>诊断</span>
                    <strong>
                      {draftSummary.diagnostics.error}/{draftSummary.diagnostics.warn}/{draftSummary.diagnostics.info}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="overview-card">
                <span className="overview-eyebrow">保存会修改什么</span>
                <h3>{draftSummary.saveTarget.label}</h3>
                <p>{draftSummary.saveTarget.detail}</p>
                <ul className="overview-list">
                  <li>工作台重新解析只更新内存中的导入草案，不会立即写数据库。</li>
                  <li>点击保存后，才会把原始卡数据、导入报告和平台卡包一起落库。</li>
                  <li>前端实际展示会读取保存后的运行时模型，而不是这个页面上的临时视图。</li>
                </ul>
              </div>

              <div className="overview-card">
                <span className="overview-eyebrow">风险分层</span>
                <div className="impact-list">
                  <div className={`impact-item ${draftSummary.renderCritical.length > 0 ? 'impact-danger' : 'impact-ok'}`}>
                    <strong>渲染关键</strong>
                    <span>
                      {draftSummary.renderCritical.length > 0
                        ? draftSummary.renderCritical.map((stage) => stage.name).join('、')
                        : '未发现会直接阻断容器渲染的阶段'}
                    </span>
                  </div>
                  <div className={`impact-item ${draftSummary.runtimeWarnings.length > 0 ? 'impact-warn' : 'impact-ok'}`}>
                    <strong>运行时行为</strong>
                    <span>
                      {draftSummary.runtimeWarnings.length > 0
                        ? draftSummary.runtimeWarnings.map((stage) => stage.name).join('、')
                        : '变量桥、动作桥、状态映射目前没有额外告警'}
                    </span>
                  </div>
                  <div className={`impact-item ${draftSummary.apiWarnings > 0 ? 'impact-warn' : 'impact-ok'}`}>
                    <strong>兼容与桥接</strong>
                    <span>
                      {draftSummary.apiWarnings > 0
                        ? `检测到 ${draftSummary.apiWarnings} 条 API/兼容性提醒`
                        : '未发现额外兼容性告警'}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          )}

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
                <ContractWorkbench packageDraft={draft.package_draft} />
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
  const [viewportFitHeight, setViewportFitHeight] = useState(MIN_RAW_PREVIEW_IFRAME_HEIGHT);
  const documentHtml = useMemo(() => buildSandboxDocument(html, {}), [html]);

  useEffect(() => {
    let frame = 0;
    const updateViewportFitHeight = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const iframe = iframeRef.current;
        if (!iframe) return;
        const rect = iframe.getBoundingClientRect();
        const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
        const bottomGutter = 24;
        const available = viewportHeight - Math.max(0, rect.top) - bottomGutter;
        if (Number.isFinite(available)) {
          setViewportFitHeight(
            Math.max(
              MIN_RAW_PREVIEW_IFRAME_HEIGHT,
              Math.min(MAX_RAW_PREVIEW_IFRAME_HEIGHT, available),
            ),
          );
        }
      });
    };

    updateViewportFitHeight();
    window.addEventListener('resize', updateViewportFitHeight);
    window.visualViewport?.addEventListener('resize', updateViewportFitHeight);
    const observer = new ResizeObserver(updateViewportFitHeight);
    if (iframeRef.current?.parentElement) observer.observe(iframeRef.current.parentElement);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateViewportFitHeight);
      window.visualViewport?.removeEventListener('resize', updateViewportFitHeight);
      observer.disconnect();
    };
  }, [documentHtml]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (event.data?.type === 'sandbox-resize') {
        const next = Number(event.data.height);
        if (Number.isFinite(next)) {
          setHeight(
            Math.max(
              MIN_RAW_PREVIEW_IFRAME_HEIGHT,
              Math.min(MAX_RAW_PREVIEW_IFRAME_HEIGHT, next),
            ),
          );
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
        style={{ height: Math.max(height, viewportFitHeight) }}
        onLoad={() => {
          const iframe = iframeRef.current;
          if (!iframe) return;
          const rect = iframe.getBoundingClientRect();
          const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
          const available = viewportHeight - Math.max(0, rect.top) - 24;
          if (Number.isFinite(available)) {
            setViewportFitHeight(
              Math.max(
                MIN_RAW_PREVIEW_IFRAME_HEIGHT,
                Math.min(MAX_RAW_PREVIEW_IFRAME_HEIGHT, available),
              ),
            );
          }
        }}
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
