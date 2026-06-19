//! Thinking/reasoning-mode control for LLM requests.
//!
//! Some models (e.g. DeepSeek's thinking models) expose a "thinking mode" that emits a
//! chain-of-thought before the final answer. That mode *rejects* `tool_choice` with an
//! HTTP 400 (`"Thinking mode does not support this tool_choice"`), which silently breaks
//! every tool-calling request — most importantly the variable-update State Agent.
//!
//! This module is the single place that knows the provider-specific request shape
//! (DeepSeek OpenAI-compatible: `{"thinking":{"type":"enabled|disabled"}}` plus an optional
//! `reasoning_effort`). Call sites express only *intent* — disabled / enabled-with-effort /
//! resolved-from-agent-config — and the concrete JSON lives here. Swap or extend the format
//! (e.g. add an Anthropic `output_config` variant) by editing this file only.

use crate::provider::types::ChatRequest;

#[derive(Debug, Clone)]
pub struct ThinkingConfig {
    enabled: bool,
    effort: Option<String>,
}

impl ThinkingConfig {
    /// Resolve from per-agent config fields.
    ///
    /// - State agents default to thinking **off** (their variable-update tool call needs
    ///   `tool_choice`, which thinking mode rejects), unless explicitly enabled.
    /// - Other agents with no explicit setting return `None` → nothing is injected, the
    ///   model uses its own default behavior.
    pub fn resolve(
        thinking_enabled: Option<bool>,
        effort: Option<String>,
        is_state: bool,
    ) -> Option<Self> {
        let enabled = match thinking_enabled {
            Some(value) => value,
            None if is_state => false,
            None => return None,
        };
        Some(Self {
            enabled,
            effort: effort.filter(|e| !e.trim().is_empty()),
        })
    }

    /// Disabled — for tool-calling paths that always carry `tool_choice` and have no
    /// per-agent config available (e.g. the single-agent variable-tool call).
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            effort: None,
        }
    }

    /// Write this config into a `ChatRequest`'s `thinking` / `reasoning_effort` fields.
    /// `reasoning_effort` is only meaningful when thinking is enabled.
    pub fn apply(self, request: &mut ChatRequest) {
        request.thinking = Some(serde_json::json!({
            "type": if self.enabled { "enabled" } else { "disabled" }
        }));
        request.reasoning_effort = if self.enabled { self.effort } else { None };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::types::ChatRequest;

    fn fresh_request() -> ChatRequest {
        ChatRequest {
            model: "m".to_string(),
            messages: vec![],
            temperature: None,
            ..Default::default()
        }
    }

    #[test]
    fn resolve_state_defaults_off() {
        // State agent, no explicit setting → Some(disabled) so tool_choice works.
        let cfg = ThinkingConfig::resolve(None, None, true).unwrap();
        let mut req = fresh_request();
        cfg.apply(&mut req);
        assert_eq!(req.thinking, Some(serde_json::json!({"type": "disabled"})));
        assert_eq!(req.reasoning_effort, None);
    }

    #[test]
    fn resolve_state_can_be_explicitly_enabled() {
        let cfg = ThinkingConfig::resolve(Some(true), Some("max".to_string()), true).unwrap();
        let mut req = fresh_request();
        cfg.apply(&mut req);
        assert_eq!(req.thinking, Some(serde_json::json!({"type": "enabled"})));
        assert_eq!(req.reasoning_effort.as_deref(), Some("max"));
    }

    #[test]
    fn resolve_non_state_no_setting_is_none() {
        // Non-state agent, no setting → None (don't inject, use model default).
        assert!(ThinkingConfig::resolve(None, None, false).is_none());
    }

    #[test]
    fn disabled_helper_emits_disabled() {
        let mut req = fresh_request();
        ThinkingConfig::disabled().apply(&mut req);
        assert_eq!(req.thinking, Some(serde_json::json!({"type": "disabled"})));
        assert_eq!(req.reasoning_effort, None);
    }
}
