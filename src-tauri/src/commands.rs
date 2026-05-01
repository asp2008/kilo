use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 错误类型
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("HTTP 请求失败: {0}")]
    Http(#[from] reqwest::Error),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// 抓取目标页面 HTML
#[tauri::command]
pub async fn fetch_page_html(url: String) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let resp = client.get(&url).send().await?;
    let html = resp.text().await?;
    Ok(html)
}

/// 打开目标 URL（在内嵌 WebView 中，或系统浏览器）
#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    // 在生产环境中，这里会创建一个新的 WebView 窗口加载目标 URL
    // 目前使用系统浏览器作为占位实现
    tauri::api::shell::open(&app.shell_scope(), &url, None)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

/// 向目标页面的表单字段注入值（通过 WebView evaluate_script）
/// 实际 Tauri 1.x 中通过 Window::eval() 注入 JS
#[tauri::command]
pub async fn fill_field(
    app: tauri::AppHandle,
    selector: String,
    value: String,
) -> Result<(), AppError> {
    // 获取自动化窗口（如果存在）
    if let Some(window) = app.get_window("automation") {
        let script = format!(
            r#"
            (function() {{
                const el = document.querySelector({selector:?});
                if (!el) return 'NOT_FOUND';
                el.value = {value:?};
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return 'OK';
            }})()
            "#
        );
        window
            .eval(&script)
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

/// 提交表单
#[tauri::command]
pub async fn submit_form(
    app: tauri::AppHandle,
    selector: String,
) -> Result<(), AppError> {
    if let Some(window) = app.get_window("automation") {
        let script = format!(
            r#"
            (function() {{
                const form = document.querySelector({selector:?});
                if (!form) {{
                    // 尝试找提交按钮
                    const btn = document.querySelector('button[type=submit], input[type=submit]');
                    if (btn) {{ btn.click(); return 'CLICKED'; }}
                    return 'NOT_FOUND';
                }}
                form.submit();
                return 'SUBMITTED';
            }})()
            "#
        );
        window
            .eval(&script)
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

/// 截取验证码图片（base64）
#[tauri::command]
pub async fn screenshot_captcha(
    app: tauri::AppHandle,
    selector: String,
) -> Result<String, AppError> {
    if let Some(window) = app.get_window("automation") {
        // 通过 JS 将验证码图片转为 base64 数据 URL
        let script = format!(
            r#"
            (async function() {{
                const el = document.querySelector({selector:?});
                if (!el) return '';
                if (el.tagName === 'IMG') return el.src;
                // 对于 canvas 验证码
                if (el.tagName === 'CANVAS') return el.toDataURL();
                // 截取元素区域
                const rect = el.getBoundingClientRect();
                return JSON.stringify({{ x: rect.x, y: rect.y, w: rect.width, h: rect.height }});
            }})()
            "#
        );
        let result = window
            .eval(&script)
            .map_err(|e| AppError::Other(e.to_string()));
        // 返回空字符串作为占位（实际需配合 Tauri screenshot API）
        return Ok(String::new());
    }
    Ok(String::new())
}

/// 获取应用数据目录
#[tauri::command]
pub fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    let dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or_else(|| AppError::Other("无法获取 appDataDir".into()))?;
    Ok(dir.to_string_lossy().to_string())
}
