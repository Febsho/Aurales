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

fn native_secret(key: &str) -> Option<String> {
    println!("cargo:rerun-if-env-changed={key}");
    if let Ok(value) = std::env::var(key) {
        if !value.is_empty() {
            return Some(value);
        }
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
            return Some(value);
        }
    }
    None
}

fn write_native_secrets() {
    let simkl = native_secret("SIMKL_CLIENT_SECRET")
        .map(|value| format!("Some({value:?})"))
        .unwrap_or_else(|| "None".into());
    let anilist = native_secret("ANILIST_CLIENT_SECRET")
        .map(|value| format!("Some({value:?})"))
        .unwrap_or_else(|| "None".into());
    let source = format!(
        "pub const SIMKL_CLIENT_SECRET: Option<&str> = {simkl};\npub const ANILIST_CLIENT_SECRET: Option<&str> = {anilist};\n"
    );
    let output =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"))
            .join("native_secrets.rs");
    std::fs::write(output, source).expect("could not write generated native secrets module");
}

fn main() {
    // Keep values out of Cargo's build-script stdout: cargo:rustc-env would
    // echo each secret in build logs. The generated file lives under OUT_DIR
    // and is compiled only into the native application.
    write_native_secrets();
    tauri_build::build()
}
