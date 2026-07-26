fn env_file_value(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (name, value) = line.split_once('=')?;
        if name.trim() != key {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
            })
            .unwrap_or(value);
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn inject_native_secret(key: &str) {
    println!("cargo:rerun-if-env-changed={key}");
    if std::env::var_os(key).is_some() {
        return;
    }

    // Vite reads the project .env files for the WebView, but it does not
    // export non-VITE variables to Cargo. Load native-only secrets here so
    // local `npm run tauri dev` builds behave like CI release builds.
    for path in ["../.env.local", "../.env", ".env.local", ".env"] {
        println!("cargo:rerun-if-changed={path}");
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        if let Some(value) = env_file_value(&content, key) {
            println!("cargo:rustc-env={key}={value}");
            return;
        }
    }
}

fn main() {
    // These values are injected only into the native Rust compilation. They
    // are never exposed through import.meta.env or bundled JavaScript.
    inject_native_secret("SIMKL_CLIENT_SECRET");
    inject_native_secret("ANILIST_CLIENT_SECRET");
    tauri_build::build()
}
