/// Truncate a string to `max_chars` Unicode characters, returning a string slice.
/// Use when you need a `&str` reference into the original string (no allocation).
pub fn truncate_str(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Tail-priority truncation: when the string exceeds `max_chars` Unicode characters,
/// keep the LAST `max_chars` (the ending) instead of the beginning. Used for narrative
/// recent-context, where the end of a long message (e.g. an opening greeting) reflects
/// the current story position and matters far more than the preamble.
pub fn truncate_str_tail(s: &str, max_chars: usize) -> &str {
    let total = s.chars().count();
    if total <= max_chars {
        return s;
    }
    let skip = total - max_chars;
    match s.char_indices().nth(skip) {
        Some((idx, _)) => &s[idx..],
        None => s,
    }
}

/// Truncate a string to `max_chars` Unicode characters with an optional suffix.
/// Returns a new String. If no truncation needed, returns the original as String.
pub fn truncate_with_suffix(s: &str, max_chars: usize, suffix: &str) -> String {
    let mut chars = s.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}{}", truncated, suffix)
    } else {
        s.to_string()
    }
}

/// True iff `text` contains any of `needles` (case-sensitive; callers lowercase first where
/// needed). Shared by the world-book / preset heuristics for keyword-group classification.
pub fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_str_no_truncation() {
        assert_eq!(truncate_str("hello", 10), "hello");
    }

    #[test]
    fn truncate_str_exact() {
        assert_eq!(truncate_str("hello", 5), "hello");
    }

    #[test]
    fn truncate_str_ascii() {
        assert_eq!(truncate_str("hello world", 5), "hello");
    }

    #[test]
    fn truncate_str_cjk() {
        assert_eq!(truncate_str("好感度规则", 3), "好感度");
    }

    #[test]
    fn truncate_str_empty() {
        assert_eq!(truncate_str("", 5), "");
    }

    #[test]
    fn truncate_str_tail_no_truncation() {
        assert_eq!(truncate_str_tail("hello", 10), "hello");
    }

    #[test]
    fn truncate_str_tail_keeps_ending_ascii() {
        // 11 chars, cap 5 → keep the last 5
        assert_eq!(truncate_str_tail("hello world", 5), "world");
    }

    #[test]
    fn truncate_str_tail_keeps_ending_cjk() {
        // 好感度规则 = 5 chars, cap 3 → keep the last 3
        assert_eq!(truncate_str_tail("好感度规则", 3), "度规则");
    }

    #[test]
    fn truncate_str_tail_empty() {
        assert_eq!(truncate_str_tail("", 5), "");
    }

    #[test]
    fn truncate_with_suffix_no_truncation() {
        assert_eq!(truncate_with_suffix("hello", 10, "..."), "hello");
    }

    #[test]
    fn truncate_with_suffix_ascii() {
        assert_eq!(truncate_with_suffix("hello world", 5, "..."), "hello...");
    }

    #[test]
    fn truncate_with_suffix_cjk() {
        assert_eq!(
            truncate_with_suffix("好感度规则", 3, "...[truncated]"),
            "好感度...[truncated]"
        );
    }

    #[test]
    fn truncate_with_suffix_empty_suffix() {
        assert_eq!(truncate_with_suffix("hello world", 5, ""), "hello");
    }
}
