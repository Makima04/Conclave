use crate::importer::types::*;
use regex::Regex;

/// Scan HTML/CSS/JS for resource references.
pub fn scan_resources(html: &str, css: &[String], js: &[String]) -> ResourceManifest {
    let mut resources = Vec::new();
    resources.extend(scan_html_elements(html));
    for (i, css_block) in css.iter().enumerate() {
        resources.extend(scan_css_urls(css_block, &format!("style_{}", i)));
    }
    for (i, js_block) in js.iter().enumerate() {
        resources.extend(scan_js_urls(js_block, &format!("script_{}", i)));
    }
    ResourceManifest { resources }
}

/// Scan HTML for `<img src>`, `<audio src>`, `<video src>`, `<source src>`, `<link href>`.
fn scan_html_elements(html: &str) -> Vec<ResourceEntry> {
    let mut resources = Vec::new();

    // Tags with src="..." attribute
    let src_re =
        Regex::new(r#"(?is)<(img|audio|video|source|embed)\s[^>]*?src\s*=\s*["']([^"']+)["']"#)
            .unwrap();
    for cap in src_re.captures_iter(html) {
        let tag = cap[1].to_lowercase();
        let url = cap[2].to_string();
        let kind = match tag.as_str() {
            "img" | "embed" => ResourceKind::Image,
            "audio" => ResourceKind::Audio,
            "video" => ResourceKind::Video,
            "source" => classify_by_extension(&url).unwrap_or(ResourceKind::Image),
            _ => ResourceKind::Image,
        };
        let offset = cap.get(0).unwrap().start();
        let excerpt = make_excerpt(html, offset, 80);
        resources.push(ResourceEntry {
            url,
            kind,
            source_location: SourceLocation {
                file: "inline_html".to_string(),
                offset,
                excerpt,
            },
        });
    }

    // <link href="...">
    let link_re = Regex::new(r#"(?is)<link\s[^>]*?href\s*=\s*["']([^"']+)["']"#).unwrap();
    for cap in link_re.captures_iter(html) {
        let url = cap[1].to_string();
        // Skip rel="canonical", rel="preconnect", etc. that aren't resources
        let full_match = cap[0].to_lowercase();
        if full_match.contains("rel=\"canonical\"")
            || full_match.contains("rel=\"preconnect\"")
            || full_match.contains("rel=\"dns-prefetch\"")
            || full_match.contains("rel=\"preload\"")
        {
            continue;
        }
        let kind = classify_by_extension(&url).unwrap_or(ResourceKind::CssUrl);
        let offset = cap.get(0).unwrap().start();
        let excerpt = make_excerpt(html, offset, 80);
        resources.push(ResourceEntry {
            url,
            kind,
            source_location: SourceLocation {
                file: "inline_html".to_string(),
                offset,
                excerpt,
            },
        });
    }

    resources
}

/// Scan CSS for `url(...)` references.
fn scan_css_urls(css: &str, file_label: &str) -> Vec<ResourceEntry> {
    let mut resources = Vec::new();

    // Match url('...'), url("..."), url(...) — with optional quotes
    let url_re = Regex::new(r#"(?i)url\(\s*['"]?([^)'"]+?)['"]?\s*\)"#).unwrap();
    for cap in url_re.captures_iter(css) {
        let url = cap[1].to_string();
        // Skip data URIs and empty values
        if url.starts_with("data:") || url.trim().is_empty() {
            continue;
        }
        let kind = classify_by_extension(&url).unwrap_or(ResourceKind::CssUrl);
        let offset = cap.get(0).unwrap().start();
        let excerpt = make_excerpt(css, offset, 80);
        resources.push(ResourceEntry {
            url,
            kind,
            source_location: SourceLocation {
                file: file_label.to_string(),
                offset,
                excerpt,
            },
        });
    }

    // Also match @import "..." and @import url("...").
    let import_re =
        Regex::new(r#"(?i)@import\s+(?:url\(\s*['"]([^'"]+)['"]\s*\)|['"]([^'"]+)['"])"#).unwrap();
    for cap in import_re.captures_iter(css) {
        let url = cap
            .get(1)
            .or_else(|| cap.get(2))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
        if url.starts_with("data:") || url.trim().is_empty() {
            continue;
        }
        if resources
            .iter()
            .any(|resource: &ResourceEntry| resource.url == url)
        {
            continue;
        }
        // Avoid duplicates from the url() regex above
        let kind = classify_by_extension(&url).unwrap_or(ResourceKind::CssUrl);
        let offset = cap.get(0).unwrap().start();
        let excerpt = make_excerpt(css, offset, 80);
        resources.push(ResourceEntry {
            url,
            kind,
            source_location: SourceLocation {
                file: file_label.to_string(),
                offset,
                excerpt,
            },
        });
    }

    resources
}

/// Scan JS for obvious static URL patterns.
fn scan_js_urls(js: &str, file_label: &str) -> Vec<ResourceEntry> {
    let mut resources = Vec::new();

    // 1. String literals that look like HTTP(S) URLs
    let http_re = Regex::new(r#""(https?://[^"\s]+)"|'(https?://[^'\s]+)'"#).unwrap();
    for cap in http_re.captures_iter(js) {
        let url = cap.get(1).or(cap.get(2)).unwrap().as_str().to_string();
        let kind = classify_by_extension(&url).unwrap_or(ResourceKind::JsStatic);
        let offset = cap.get(0).unwrap().start();
        let excerpt = make_excerpt(js, offset, 80);
        resources.push(ResourceEntry {
            url,
            kind,
            source_location: SourceLocation {
                file: file_label.to_string(),
                offset,
                excerpt,
            },
        });
    }

    // 2. new Audio("...") / new Audio('...')
    let audio_re = Regex::new(r#"(?i)new\s+Audio\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap();
    for cap in audio_re.captures_iter(js) {
        let url = cap[1].to_string();
        let offset = cap.get(0).unwrap().start();
        let excerpt = make_excerpt(js, offset, 80);
        resources.push(ResourceEntry {
            url,
            kind: ResourceKind::Audio,
            source_location: SourceLocation {
                file: file_label.to_string(),
                offset,
                excerpt,
            },
        });
    }

    // 3. .src = "..." assignments (covers createElement("img").src = "..." patterns)
    let src_assign_re = Regex::new(r#"(?i)\.src\s*=\s*['"]([^'"]+)['"]"#).unwrap();
    for cap in src_assign_re.captures_iter(js) {
        let url = cap[1].to_string();
        if url.starts_with("data:") {
            continue;
        }
        let kind = classify_by_extension(&url).unwrap_or(ResourceKind::JsStatic);
        let offset = cap.get(0).unwrap().start();
        let excerpt = make_excerpt(js, offset, 80);
        resources.push(ResourceEntry {
            url,
            kind,
            source_location: SourceLocation {
                file: file_label.to_string(),
                offset,
                excerpt,
            },
        });
    }

    resources
}

/// Classify a resource by its file extension.
fn classify_by_extension(url: &str) -> Option<ResourceKind> {
    // Strip query string and fragment
    let path = url
        .split('?')
        .next()
        .unwrap_or(url)
        .split('#')
        .next()
        .unwrap_or(url);
    let lower = path.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");

    match ext {
        // Images
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" => {
            Some(ResourceKind::Image)
        }
        // Audio
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "m4a" | "webm" => Some(ResourceKind::Audio),
        // Video (exclude .webm if we already matched it as audio above — webm is ambiguous,
        // but in practice webm video is more common; we let Audio win in the audio list)
        "mp4" | "mov" | "avi" | "mkv" => Some(ResourceKind::Video),
        // Fonts
        "woff" | "woff2" | "ttf" | "otf" | "eot" => Some(ResourceKind::Font),
        // CSS
        "css" => Some(ResourceKind::CssUrl),
        // JS
        "js" | "mjs" => Some(ResourceKind::JsStatic),
        _ => None,
    }
}

/// Extract a ~`width`-character excerpt centered on `offset` within `text`.
fn make_excerpt(text: &str, offset: usize, width: usize) -> String {
    let half = width / 2;
    let start = offset.saturating_sub(half);
    let end = (offset + half).min(text.len());

    // Snap to char boundaries
    let start = snap_to_char_boundary(text, start);
    let end = snap_to_char_boundary(text, end);

    let snippet = &text[start..end];
    let prefix = if start > 0 { "..." } else { "" };
    let suffix = if end < text.len() { "..." } else { "" };
    format!("{}{}{}", prefix, snippet, suffix)
}

/// Snap an offset to the nearest valid UTF-8 char boundary.
fn snap_to_char_boundary(s: &str, mut idx: usize) -> usize {
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_html_img() {
        let html = r#"<img src="photo.png" alt="test"><img src='other.jpg'>"#;
        let resources = scan_html_elements(html);
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[0].url, "photo.png");
        assert_eq!(resources[0].kind, ResourceKind::Image);
        assert_eq!(resources[1].url, "other.jpg");
    }

    #[test]
    fn test_scan_html_audio_video() {
        let html = r#"<audio src="sound.mp3"></audio><video src="clip.mp4"></video>"#;
        let resources = scan_html_elements(html);
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[0].kind, ResourceKind::Audio);
        assert_eq!(resources[1].kind, ResourceKind::Video);
    }

    #[test]
    fn test_scan_html_link() {
        let html = r#"<link rel="stylesheet" href="style.css"><link rel="canonical" href="https://example.com">"#;
        let resources = scan_html_elements(html);
        assert_eq!(resources.len(), 1); // canonical is skipped
        assert_eq!(resources[0].kind, ResourceKind::CssUrl);
    }

    #[test]
    fn test_scan_css_urls() {
        let css = r#"
            .bg { background: url('bg.png'); }
            @import url("reset.css");
            .data { background: url(data:image/png;base64,abc); }
        "#;
        let resources = scan_css_urls(css, "style_0");
        // data: URI is skipped
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[0].url, "bg.png");
        assert_eq!(resources[1].url, "reset.css");
    }

    #[test]
    fn test_scan_js_urls() {
        let js = r#"fetch("https://api.example.com/data"); new Audio("song.mp3");"#;
        let resources = scan_js_urls(js, "script_0");
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[0].url, "https://api.example.com/data");
        assert_eq!(resources[0].kind, ResourceKind::JsStatic);
        assert_eq!(resources[1].url, "song.mp3");
        assert_eq!(resources[1].kind, ResourceKind::Audio);
    }

    #[test]
    fn test_classify_by_extension() {
        assert_eq!(
            classify_by_extension("photo.PNG"),
            Some(ResourceKind::Image)
        );
        assert_eq!(
            classify_by_extension("song.mp3?v=2"),
            Some(ResourceKind::Audio)
        );
        assert_eq!(
            classify_by_extension("font.woff2"),
            Some(ResourceKind::Font)
        );
        assert_eq!(classify_by_extension("unknown.xyz"), None);
    }

    #[test]
    fn test_scan_resources_integration() {
        let html = r#"<img src="hero.jpg"><link rel="stylesheet" href="app.css">"#;
        let css = vec![r#".bg { background: url(bg.png); }"#.to_string()];
        let js = vec![r#"new Audio("music.mp3")"#.to_string()];
        let manifest = scan_resources(html, &css, &js);
        assert_eq!(manifest.resources.len(), 4); // hero.jpg, app.css, bg.png, music.mp3
    }
}
