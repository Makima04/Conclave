/// Truncate a string to `max_chars` Unicode characters, returning a string slice.
/// Use when you need a `&str` reference into the original string (no allocation).
pub fn truncate_str(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
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
