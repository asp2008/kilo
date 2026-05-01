// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 确保配置目录存在
            let app_data = app.path_resolver().app_data_dir().unwrap();
            let configs_dir = app_data.join("configs");
            std::fs::create_dir_all(&configs_dir)
                .expect("Failed to create configs directory");
            println!("Config dir: {:?}", configs_dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fetch_page_html,
            commands::open_url,
            commands::fill_field,
            commands::submit_form,
            commands::screenshot_captcha,
            commands::get_app_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
