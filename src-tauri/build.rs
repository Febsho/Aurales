fn main() {
    // Inject SIMKL_CLIENT_SECRET from .env.local at compile time so that
    // option_env!("SIMKL_CLIENT_SECRET") resolves in commands.rs.
    // This keeps the secret OUT of any JS bundle – it only lives in the
    // compiled Rust binary.
    if std::env::var("SIMKL_CLIENT_SECRET").is_err() {
        // Walk up from src-tauri/ to find .env.local in the project root
        let candidates = ["../.env.local", ".env.local"];
        'outer: for path in &candidates {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines() {
                    let line = line.trim();
                    if line.starts_with('#') || line.is_empty() {
                        continue;
                    }
                    if let Some(val) = line.strip_prefix("SIMKL_CLIENT_SECRET=") {
                        println!("cargo:rustc-env=SIMKL_CLIENT_SECRET={}", val.trim());
                        break 'outer;
                    }
                }
            }
        }
    }

    tauri_build::build()
}
