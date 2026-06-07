// useStreamRecovery — pending message tracking + SSE stream recovery
// Extracted from Chat.tsx GROUP 27 + GROUP 28

import { useState, useRef } from 'react';
import * as api from '../../api/client';
import { consumeSseResponse } from '../../api/sse';
import type { Message } from '../../api/types';

export function useStreamRecovery(
  sessionId: string | undefined,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  loadMessages: () => Promise<Message[] | undefined>,
) {
  // --- state ---
  const [recovering, setRecovering] = useState(false);
  const [failedContent, setFailedContent] = useState<string | null>(null);
  const [memoryPending, setMemoryPendingState] = useState(false);
  const [stateUpdating, setStateUpdating] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState<Array<{ agent_type: string; label: string; status: string }>>([]);
  const [streamText, setStreamText] = useState('');
  const [streamError, setStreamErrorState] = useState<string | null>(null);

  // --- refs ---
  const recoveringRef = useRef(false);
  const recoverAbortRef = useRef<AbortController | null>(null);
  const streamHadErrorRef = useRef(false);
  const initialMsgCountRef = useRef(0);
  const memoryPendingRef = useRef(false);
  const streamingRef = useRef(false);
  const streamTextRef = useRef('');

  // --- helpers ---

  function pendingKey() {
    return `pending_${sessionId}`;
  }

  function setPending(turnNumber: number) {
    localStorage.setItem(pendingKey(), JSON.stringify({ turnNumber, sentAt: Date.now() }));
  }

  function clearPending() {
    localStorage.removeItem(pendingKey());
  }

  function setMemoryBusy(value: boolean) {
    memoryPendingRef.current = value;
    setMemoryPendingState(value);
  }

  function setStreamError(value: string | null) {
    setStreamErrorState(value);
  }

  function getPending(): { turnNumber: number; sentAt: number } | null {
    try {
      const raw = localStorage.getItem(pendingKey());
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after 10 minutes
      if (Date.now() - data.sentAt > 10 * 60 * 1000) {
        clearPending();
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  // --- recovery ---

  async function startRecovery(initialMsgCount: number) {
    if (!getPending() || !sessionId) return;
    setRecovering(true);
    recoveringRef.current = true;
    initialMsgCountRef.current = initialMsgCount;

    const controller = new AbortController();
    recoverAbortRef.current = controller;

    try {
      const res = await api.reconnectStream(sessionId, controller.signal);

      if (res.status === 404) {
        // No active turn — check if it already completed
        const data = await api.listMessages(sessionId);
        if (data.items.length > initialMsgCount) {
          setMessages(data.items);
        }
        clearPending();
        stopRecovery();
        return;
      }

      if (!res.ok || !res.body) {
        stopRecovery();
        return;
      }

      await consumeSseResponse(res, async message => {
        switch (message.event) {
          case 'agent_status':
            if (message.data.status === 'working') {
              setAgentStatuses(prev => [...prev.filter(s => s.agent_type !== message.data.agent_type), message.data]);
            } else {
              setAgentStatuses(prev => prev.filter(s => s.agent_type !== message.data.agent_type));
            }
            break;
          case 'message_delta':
            if (message.data.content) {
              setAgentStatuses([]);
              setStreamText(prev => {
                const next = prev + message.data.content;
                streamTextRef.current = next;
                return next;
              });
            }
            break;
          case 'stream_error':
            setStreamError(message.data.error || '生成出现错误');
            break;
          case 'state_update':
            setStateUpdating(message.data.status === 'processing');
            break;
          case 'turn_end': {
            setStateUpdating(false);
            const data = await api.listMessages(sessionId);
            setMessages(data.items);
            setStreamText('');
            streamTextRef.current = '';
            setMemoryBusy(true);
            break;
          }
          case 'memory_start':
            setMemoryBusy(true);
            break;
          case 'memory_error':
            setStreamError(message.data.error || '记忆整理失败，已允许继续');
            break;
          case 'turn_ready':
            setMemoryBusy(false);
            setStateUpdating(false);
            clearPending();
            stopRecovery();
            return false;
        }
      });

      // Stream closed without turn_end — turn likely finished, reload
      if (recoveringRef.current) {
        const data = await api.listMessages(sessionId);
        if (data.items.length > initialMsgCountRef.current) {
          setMessages(data.items);
        }
        if (streamTextRef.current) {
          setStreamText('');
          streamTextRef.current = '';
        }
        clearPending();
        stopRecovery();
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Recovery reconnect failed:', err);
        stopRecovery();
      }
    }
  }

  function stopRecovery() {
    recoverAbortRef.current?.abort();
    recoverAbortRef.current = null;
    setRecovering(false);
    recoveringRef.current = false;
    setMemoryBusy(false);
    setStateUpdating(false);
    setAgentStatuses([]);
    setStreamError(null);
  }

  return {
    // state
    recovering,
    failedContent,
    setFailedContent,
    memoryPending,
    stateUpdating,
    agentStatuses,
    setAgentStatuses,
    streamText,
    setStreamText,
    streamError,
    setStreamError,
    // refs
    recoveringRef,
    streamHadErrorRef,
    streamTextRef,
    memoryPendingRef,
    streamingRef,
    // actions
    setPending,
    clearPending,
    setMemoryBusy,
    getPending,
    startRecovery,
    stopRecovery,
  };
}
