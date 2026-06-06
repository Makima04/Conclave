import { useEffect, useMemo, useState } from 'react';
import * as api from '../api/client';
import type { ProviderConfig } from '../api/types';

const PROVIDER_MODEL_PREFIX = 'provider:';
const CUSTOM_SOURCE = '__custom__';
const DEFAULT_SOURCE = '__default__';
const MANUAL_MODEL = '__manual__';

export function makeProviderModelRef(providerId: string, model: string): string {
  return `${PROVIDER_MODEL_PREFIX}${providerId}:${encodeURIComponent(model)}`;
}

export function parseProviderModelRef(value: string | undefined | null): { providerId: string; model: string } | null {
  if (!value?.startsWith(PROVIDER_MODEL_PREFIX)) return null;
  const rest = value.slice(PROVIDER_MODEL_PREFIX.length);
  const split = rest.indexOf(':');
  if (split < 0) return null;
  const providerId = rest.slice(0, split);
  const encodedModel = rest.slice(split + 1);
  if (!providerId || !encodedModel) return null;
  try {
    return { providerId, model: decodeURIComponent(encodedModel) };
  } catch {
    return { providerId, model: encodedModel };
  }
}

export function describeModelRef(value: string | undefined, providers: ProviderConfig[], defaultText = '默认模型'): string {
  if (!value) return defaultText;
  const parsed = parseProviderModelRef(value);
  if (!parsed) return value;
  const provider = providers.find(p => p.id === parsed.providerId);
  return provider ? `${provider.name} / ${parsed.model}` : parsed.model;
}

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map(m => m.trim()).filter(Boolean)));
}

interface ModelPickerProps {
  label?: string;
  value: string;
  providers: ProviderConfig[];
  defaultText: string;
  onChange: (value: string) => void;
}

export function ModelPicker({ label, value, providers, defaultText, onChange }: ModelPickerProps) {
  const parsed = parseProviderModelRef(value);
  const selectedProviderId = parsed?.providerId || '';
  const selectedProvider = providers.find(p => p.id === selectedProviderId);
  const isCustom = Boolean(value && !parsed);
  const sourceValue = !value ? DEFAULT_SOURCE : isCustom ? CUSTOM_SOURCE : selectedProviderId;
  const [customValue, setCustomValue] = useState(isCustom ? value : '');
  const [manualModel, setManualModel] = useState(parsed?.model || selectedProvider?.model || '');
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [fetchingProviderId, setFetchingProviderId] = useState('');
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    const nextParsed = parseProviderModelRef(value);
    setCustomValue(value && !nextParsed ? value : '');
    setManualModel(nextParsed?.model || '');
  }, [value]);

  const providerModels = useMemo(() => {
    if (!selectedProvider) return [];
    return uniqueModels([selectedProvider.model, ...(modelsByProvider[selectedProvider.id] || [])]);
  }, [modelsByProvider, selectedProvider]);

  const selectedModel = parsed?.model || selectedProvider?.model || '';
  const modelSelectValue = selectedModel && providerModels.includes(selectedModel) ? selectedModel : MANUAL_MODEL;

  async function fetchProviderModels(provider: ProviderConfig) {
    setFetchingProviderId(provider.id);
    setFetchError('');
    try {
      const data = await api.fetchModels(provider.base_url, provider.api_key || undefined);
      setModelsByProvider(prev => ({ ...prev, [provider.id]: uniqueModels(data.models) }));
    } catch (err: any) {
      setFetchError(err?.message || '获取模型列表失败');
    } finally {
      setFetchingProviderId('');
    }
  }

  return (
    <div className="model-picker">
      {label && <label>{label}</label>}
      <select
        value={sourceValue}
        onChange={e => {
          const next = e.target.value;
          setFetchError('');
          if (next === DEFAULT_SOURCE) {
            onChange('');
            return;
          }
          if (next === CUSTOM_SOURCE) {
            const nextCustom = customValue || (parsed?.model ?? value);
            setCustomValue(nextCustom);
            onChange(nextCustom);
            return;
          }
          const provider = providers.find(p => p.id === next);
          if (provider) {
            setManualModel(provider.model);
            onChange(makeProviderModelRef(provider.id, provider.model));
          }
        }}
      >
        <option value={DEFAULT_SOURCE}>{defaultText}</option>
        {providers.map(provider => (
          <option key={provider.id} value={provider.id}>
            {provider.name}{provider.is_default ? ' (默认配置)' : ''}
          </option>
        ))}
        <option value={CUSTOM_SOURCE}>自定义模型名</option>
      </select>

      {selectedProvider && (
        <div className="model-picker-detail">
          <select
            value={modelSelectValue}
            onChange={e => {
              const nextModel = e.target.value;
              if (nextModel === MANUAL_MODEL) {
                const nextManual = selectedModel || selectedProvider.model;
                setManualModel(nextManual);
                onChange(makeProviderModelRef(selectedProvider.id, nextManual));
                return;
              }
              setManualModel(nextModel);
              onChange(makeProviderModelRef(selectedProvider.id, nextModel));
            }}
          >
            {providerModels.map(model => <option key={model} value={model}>{model}</option>)}
            <option value={MANUAL_MODEL}>输入此配置下的其他模型</option>
          </select>
          {modelSelectValue === MANUAL_MODEL && (
            <input
              value={manualModel}
              onChange={e => {
                setManualModel(e.target.value);
                onChange(makeProviderModelRef(selectedProvider.id, e.target.value));
              }}
              placeholder="模型名称"
            />
          )}
          <button
            type="button"
            className="fetch-btn"
            onClick={() => fetchProviderModels(selectedProvider)}
            disabled={fetchingProviderId === selectedProvider.id}
          >
            {fetchingProviderId === selectedProvider.id ? '获取中...' : '获取模型列表'}
          </button>
        </div>
      )}

      {isCustom && (
        <input
          value={customValue}
          onChange={e => {
            setCustomValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder="按默认配置调用此模型名"
        />
      )}
      {fetchError && <span className="fetch-error">{fetchError}</span>}
    </div>
  );
}
