//! Write-time validation for variable updates.
//!
//! The State Agent is an LLM; its output is not trusted. Before any change is
//! merged into `session_variables`, every `StateChangeCandidate` is passed
//! through [`validate_change`]. Changes that fail a *deterministic, generic*
//! rule are dropped (this change only), with a `tracing::warn`; the rest of the
//! turn's changes still persist. Semantic judgment ("should 反抗意志 have gone
//! up?") is deliberately NOT done here — that is not enumerable and stays the
//! LLM's job.
//!
//! Rules (all derivable from the existing variable tree, zero config):
//! - **Type isomorphism**: when the current value is an array, the new value
//!   must also be an array; when it is a bool, a bool; etc. The MVU
//!   `[value, 说明]` shape must be preserved.
//! - **Numeric range**: for numeric fields whose `说明` carries a `范围[min-max]`
//!   hint, a new numeric value out of range is dropped. Out-of-range detection
//!   needs the hint — without one, range is skipped (never a false rejection).
//! - **Reject yes/no / explanation strings**: bare `"Yes"` / `"No"` / `"是"` /
//!   `"否"` and the `"Yes (…)"` / `"No (…)"` explanation form the LLM emits when
//!   it misreads "did this change?" as "what is the new value?".
//! - **Reject empty / whitespace-only** string values.
//!
//! `add` / `remove` (structural ops) skip value checks — only the path matters.

use crate::runtime::card_state_adapter;
use crate::runtime::types::StateChangeCandidate;
use serde_json::Value;

/// Validate a single change against the current writable state.
///
/// Returns `Some(change)` (possibly with a sanitized `to`) if the change is
/// acceptable, or `None` if it should be dropped. The returned change is the
/// caller's; we do not mutate the input's owner here.
pub fn validate_change(
    change: &StateChangeCandidate,
    writable_state: &Value,
) -> Option<StateChangeCandidate> {
    // Structural ops: no value to validate. `add` into an array / new key,
    // `remove` of a path — only the path is checked downstream.
    if change.op == "add" || change.op == "remove" {
        return Some(change.clone());
    }

    let relative = change
        .target
        .strip_prefix("variables.")
        .or_else(|| change.target.strip_prefix("platform_state."))
        .unwrap_or(&change.target);
    let current = card_state_adapter::get_path_value(writable_state, relative);

    // Path not present in the writable tree → cannot type-check; keep it and let
    // the existence filter in normalize_changes decide (it already requires
    // existing paths for `update`/`set`).
    let Some(current) = current else {
        return Some(change.clone());
    };

    let to = &change.to;

    // Reject empty / whitespace-only strings.
    if to.as_str().is_some_and(|s| s.trim().is_empty()) {
        tracing::warn!(
            target = %change.target,
            "variable change dropped: empty value"
        );
        return None;
    }

    // Reject yes/no / explanation strings (the LLM answering "did it change?"
    // instead of giving the new value). Covers bare Yes/No/是/否 and the
    // "Yes (…)" / "No (…)" explanation form.
    if is_yes_no_value(to) {
        tracing::warn!(
            target = %change.target,
            value = %to,
            "variable change dropped: value is a yes/no or explanation string"
        );
        return None;
    }

    // Type isomorphism against the current value's shape.
    if !shape_compatible(current, to) {
        tracing::warn!(
            target = %change.target,
            current_shape = ?value_shape_name(current),
            new_shape = ?value_shape_name(to),
            "variable change dropped: new value shape does not match current"
        );
        return None;
    }

    // Numeric range check (only when a 范围[min-max] hint exists on the current
    // value's 说明 slot).
    if let Some((min, max)) = current_range_hint(current) {
        if let Some(num) = parse_numeric_value(to) {
            if num < min || num > max {
                tracing::warn!(
                    target = %change.target,
                    value = num,
                    min,
                    max,
                    "variable change dropped: numeric value out of range"
                );
                return None;
            }
        }
    }

    Some(change.clone())
}

/// Is `to` a yes/no or explanation string the LLM emits instead of a real value?
fn is_yes_no_value(to: &Value) -> bool {
    let Some(text) = to.as_str() else {
        return false;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    matches!(
        trimmed,
        "Yes" | "No" | "yes" | "no" | "是" | "否" | "YES" | "NO"
    ) || trimmed.starts_with("Yes (")
        || trimmed.starts_with("No (")
        || trimmed.starts_with("yes (")
        || trimmed.starts_with("no (")
}

/// Does the new value's shape match the current value's? MVU arrays must stay
/// arrays; bools must stay bools. Numbers/strings/数值串 are interchangeable as
/// "scalar" (a `"15 | …"` string is the canonical numeric form).
fn shape_compatible(current: &Value, to: &Value) -> bool {
    match current {
        Value::Array(_) => to.is_array(),
        Value::Bool(_) => to.is_boolean(),
        // Numbers and strings are treated as one "scalar" bucket so the MVU
        // `"15 | …"` numeric string form is compatible with a bare number 15.
        Value::Number(_) | Value::String(_) => to.is_number() || to.is_string(),
        // Null / object current → accept anything (no shape to enforce).
        _ => true,
    }
}

fn value_shape_name(v: &Value) -> &'static str {
    match v {
        Value::Array(_) => "array",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Object(_) => "object",
        Value::Null => "null",
    }
}

/// Extract a numeric range from an MVU `[value, 说明]` current value's 说明
/// text. Looks for the canonical `范围[min-max]` / `范围[min~max]` marker
/// written by the card author. e.g. `"范围[0-100]。体现…"` → `Some((0.0, 100.0))`.
pub fn current_range_hint(current: &Value) -> Option<(f64, f64)> {
    let arr = current.as_array()?;
    let hint = arr.get(1).and_then(|v| v.as_str())?;
    extract_range(hint)
}

/// Parse `范围[min-max]` or `范围[min~max]` from a hint string.
pub fn extract_range(hint: &str) -> Option<(f64, f64)> {
    let start = hint.find('[')?;
    let end = hint[start..].find(']')?;
    let inside = &hint[start + 1..start + end];
    let (lo, hi) = inside.split_once(['-', '~'])?;
    let min: f64 = lo.trim().parse().ok()?;
    let max: f64 = hi.trim().parse().ok()?;
    Some((min, max.max(min)))
}

/// Parse a numeric value out of an MVU value. Accepts:
/// - a bare number (`15`, `15.5`),
/// - the canonical `"15 | 屈辱萌动"` form (number before ` | `),
/// - a numeric-leading string (`"15"`),
/// - an MVU `[value, 说明]` array (parses `[0]`).
pub fn parse_numeric_value(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    // MVU [value, 说明] array → its [0] slot.
    if let Some(arr) = v.as_array() {
        if let Some(first) = arr.first() {
            return parse_numeric_value(first);
        }
        return None;
    }
    let s = v.as_str()?;
    let head = s.split('|').next()?.trim();
    head.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(op: &str, target: &str, to: Value) -> StateChangeCandidate {
        StateChangeCandidate {
            op: op.to_string(),
            target: target.to_string(),
            from: None,
            to,
            evidence_turns: vec![],
        }
    }

    fn mvu_state() -> Value {
        serde_json::json!({
            "<user>": {
                "精神状态数值": {
                    "爱意值": ["0 | 我只会恨你", "范围[0-100]。体现情感。"],
                    "反抗意志": ["99 | 愤怒燃烧", "范围[0-100]"]
                },
                "当前位置": ["空庭", "<user>所在地点"],
                "内核状态": { "处女状态": [true, "布尔值，true代表仍是处女"] },
                "称号": "待雕琢的璞玉"
            }
        })
    }

    #[test]
    fn drops_bare_yes_and_no_strings() {
        let state = mvu_state();
        assert!(validate_change(
            &change("set", "<user>.精神状态数值.爱意值", Value::String("Yes".to_string())),
            &state,
        )
        .is_none());
        assert!(validate_change(
            &change("set", "<user>.精神状态数值.爱意值", Value::String("No".to_string())),
            &state,
        )
        .is_none());
    }

    #[test]
    fn drops_yes_no_explanation_form() {
        let state = mvu_state();
        assert!(validate_change(
            &change(
                "set",
                "<user>.精神状态数值.反抗意志",
                Value::String("No (暂时不变，后续场景可能会波动)".to_string()),
            ),
            &state,
        )
        .is_none());
    }

    #[test]
    fn drops_empty_and_whitespace_string() {
        let state = mvu_state();
        assert!(validate_change(
            &change("set", "<user>.称号", Value::String("".to_string())),
            &state,
        )
        .is_none());
        assert!(validate_change(
            &change("set", "<user>.称号", Value::String("   ".to_string())),
            &state,
        )
        .is_none());
    }

    #[test]
    fn drops_out_of_range_numeric() {
        let state = mvu_state();
        // 999 > [0-100] → dropped.
        let r = validate_change(
            &change(
                "set",
                "<user>.精神状态数值.爱意值",
                serde_json::json!(["999 | 越界", "范围[0-100]"]),
            ),
            &state,
        );
        assert!(r.is_none(), "999 is out of [0-100] and must be dropped");
    }

    #[test]
    fn accepts_in_range_numeric_and_mvu_string() {
        let state = mvu_state();
        // Canonical "数值 | 描述" string, in range, as a complete MVU array.
        let ok = validate_change(
            &change(
                "set",
                "<user>.精神状态数值.爱意值",
                serde_json::json!(["15 | 屈辱萌动", "范围[0-100]"]),
            ),
            &state,
        );
        assert!(ok.is_some(), "in-range MVU array string should pass");

        // Scalar (称号) field accepts a plain string in range-irrelevant context.
        let ok = validate_change(
            &change("set", "<user>.称号", serde_json::json!("咬伤主人的野猫")),
            &state,
        );
        assert!(ok.is_some(), "scalar string field should accept a string");

        // A bare number aimed at an array field is a shape mismatch → dropped.
        // The model must give the complete [value, 说明] array for array fields.
        let bad = validate_change(
            &change("set", "<user>.精神状态数值.爱意值", serde_json::json!(42)),
            &state,
        );
        assert!(bad.is_none(), "bare scalar on array field must be dropped");
    }

    #[test]
    fn drops_array_shape_mismatch() {
        let state = mvu_state();
        // Current is an array [value, 说明]; a bare scalar string is a shape
        // mismatch → dropped (prevents overwriting the array with a scalar).
        assert!(validate_change(
            &change(
                "set",
                "<user>.精神状态数值.爱意值",
                Value::String("13".to_string()),
            ),
            &state,
        )
        .is_none());
    }

    #[test]
    fn drops_bool_shape_mismatch() {
        let state = mvu_state();
        assert!(validate_change(
            &change(
                "set",
                "<user>.内核状态.处女状态",
                Value::String("是".to_string()),
            ),
            &state,
        )
        .is_none());
    }

    #[test]
    fn structural_ops_skip_value_check() {
        let state = mvu_state();
        // remove with any value passes.
        assert!(validate_change(
            &change("remove", "<user>.称号", Value::Null),
            &state,
        )
        .is_some());
        // add with an object passes.
        assert!(validate_change(
            &change("add", "characters[1]", serde_json::json!({ "name": "新角色" })),
            &state,
        )
        .is_some());
    }

    #[test]
    fn extract_range_handles_minus_and_tilde() {
        assert_eq!(extract_range("范围[0-100]。体现…"), Some((0.0, 100.0)));
        assert_eq!(extract_range("范围[0~100]"), Some((0.0, 100.0)));
        assert_eq!(extract_range("范围[0-∞]"), None);
        assert_eq!(extract_range("无范围提示"), None);
    }

    #[test]
    fn parse_numeric_value_forms() {
        assert_eq!(parse_numeric_value(&serde_json::json!(15)), Some(15.0));
        assert_eq!(
            parse_numeric_value(&serde_json::json!("15 | 屈辱萌动")),
            Some(15.0),
        );
        assert_eq!(parse_numeric_value(&serde_json::json!("99")), Some(99.0));
        assert_eq!(parse_numeric_value(&serde_json::json!("愤怒燃烧")), None);
        // MVU [value, 说明] array → parses [0].
        assert_eq!(
            parse_numeric_value(&serde_json::json!(["15 | 屈辱萌动", "范围[0-100]"])),
            Some(15.0),
        );
    }
}
