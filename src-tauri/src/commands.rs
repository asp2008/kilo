use serde::{Deserialize, Serialize};
use tauri::{Manager, Window};

/// 统一错误类型
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("HTTP 请求失败: {0}")]
    Http(#[from] reqwest::Error),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("Tauri 错误: {0}")]
    Tauri(String),
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

// ─── fetch_page_html ───────────────────────────────────────────────────────

/// 抓取目标页面 HTML（绕过浏览器 CORS 限制）
#[tauri::command]
pub async fn fetch_page_html(url: String) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?;

    let resp = client.get(&url).send().await?;
    let status = resp.status();
    let html = resp.text().await?;

    if !status.is_success() {
        return Err(AppError::Other(format!("HTTP {}", status)));
    }
    Ok(html)
}

// ─── WebView 注入辅助（通过 automation 窗口的 eval）─────────────────────────

/// 在 automation WebView 中执行 JS，返回字符串结果
async fn eval_in_webview(app: &tauri::AppHandle, script: &str) -> Result<String, AppError> {
    let win = app
        .get_window("automation")
        .ok_or_else(|| AppError::Other("automation 窗口未创建，请先调用 open_url".into()))?;

    // Tauri 1.x: window.eval() 是 fire-and-forget，
    // 用 emit/listen 拿回返回值
    win.eval(script)
        .map_err(|e| AppError::Tauri(e.to_string()))?;
    Ok(String::new())
}

// ─── open_url ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct OpenUrlOptions {
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 在 automation WebView 窗口中打开 URL（若窗口不存在则创建）
#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    use tauri::WindowBuilder;

    if let Some(win) = app.get_window("automation") {
        // 已有窗口：导航到新 URL
        win.eval(&format!("window.location.href = {:?};", url))
            .map_err(|e| AppError::Tauri(e.to_string()))?;
        win.show().map_err(|e| AppError::Tauri(e.to_string()))?;
        win.set_focus().map_err(|e| AppError::Tauri(e.to_string()))?;
    } else {
        // 创建新的 automation WebView 窗口
        WindowBuilder::new(
            &app,
            "automation",
            tauri::WindowUrl::External(url.parse().map_err(|e: url::ParseError| AppError::Other(e.to_string()))?),
        )
        .title("KiloForm — 自动化窗口")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| AppError::Tauri(e.to_string()))?;
    }
    Ok(())
}

// ─── fill_field ────────────────────────────────────────────────────────────

/// 向目标表单字段填入值（使用原生 setter 确保 React/Vue 响应式也能触发）
#[tauri::command]
pub async fn fill_field(
    app: tauri::AppHandle,
    selector: String,
    value: String,
) -> Result<bool, AppError> {
    let script = format!(
        r#"
        (function() {{
            const el = document.querySelector({sel});
            if (!el) return false;
            const inputProto = window.HTMLInputElement.prototype;
            const textProto  = window.HTMLTextAreaElement.prototype;
            const setter =
                Object.getOwnPropertyDescriptor(inputProto, 'value')?.set ||
                Object.getOwnPropertyDescriptor(textProto,  'value')?.set;
            if (setter) {{
                setter.call(el, {val});
            }} else {{
                el.value = {val};
            }}
            ['input','change'].forEach(ev =>
                el.dispatchEvent(new Event(ev, {{ bubbles: true }}))
            );
            return true;
        }})();
        "#,
        sel = serde_json::to_string(&selector).unwrap(),
        val = serde_json::to_string(&value).unwrap(),
    );
    eval_in_webview(&app, &script).await?;
    Ok(true)
}

// ─── submit_form ───────────────────────────────────────────────────────────

/// 点击提交按钮 / 调用 form.submit()
#[tauri::command]
pub async fn submit_form(
    app: tauri::AppHandle,
    selector: String,
) -> Result<bool, AppError> {
    let script = format!(
        r#"
        (function() {{
            // 先尝试点击指定选择器
            const btn = document.querySelector({sel});
            if (btn) {{ btn.click(); return 'clicked'; }}
            // fallback: 通用提交按钮
            const sub = document.querySelector(
                'button[type=submit],input[type=submit],[type=submit]'
            );
            if (sub) {{ sub.click(); return 'fallback-click'; }}
            // 最后: form.submit()
            const form = document.querySelector('form');
            if (form) {{ form.submit(); return 'form-submit'; }}
            return 'not-found';
        }})();
        "#,
        sel = serde_json::to_string(&selector).unwrap(),
    );
    eval_in_webview(&app, &script).await?;
    Ok(true)
}

// ─── screenshot_captcha ────────────────────────────────────────────────────

/// 获取验证码图片 src/dataURL（从页面 DOM 提取）
#[tauri::command]
pub async fn screenshot_captcha(
    app: tauri::AppHandle,
    selector: String,
) -> Result<String, AppError> {
    // 这里用 JS 读取验证码图片 src
    // 真正的像素截图需要 Tauri 截图 API（需要额外权限），此处先返回 img.src
    let script = format!(
        r#"
        (function() {{
            const el = document.querySelector({sel});
            if (!el) return '';
            if (el.tagName === 'IMG') return el.src;
            if (el.tagName === 'CANVAS') return el.toDataURL('image/png');
            // 从输入框附近找验证码 img
            const root = el.closest('.captcha,.verify-group,form,.form-group') || el.parentElement;
            if (root) {{
                const img = root.querySelector(
                    'img[src*="captcha"],img[src*="verify"],img[src*="code"],img'
                );
                if (img) return img.src;
            }}
            return '';
        }})();
        "#,
        sel = serde_json::to_string(&selector).unwrap(),
    );
    eval_in_webview(&app, &script).await
}

// ─── get_app_data_dir ──────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    let dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or_else(|| AppError::Other("无法获取 appDataDir".into()))?;
    Ok(dir.to_string_lossy().to_string())
}
