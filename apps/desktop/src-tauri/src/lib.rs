use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

mod diff;

const AUTH_FILE_NAME: &str = "forksd.auth";
const DEFAULT_BIND: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 38_765;

#[derive(Serialize)]
struct ForksdConnectionInfo {
  baseUrl: String,
  token: String,
}

#[derive(Deserialize)]
struct HealthResponse {
  code: Option<String>,
}

#[tauri::command]
fn compute_unified_diff(
  original: String,
  modified: String,
  context_lines: Option<usize>,
) -> Result<String, String> {
  let context = context_lines.unwrap_or(3).min(200);
  Ok(diff::unified_diff(&original, &modified, context))
}

fn forksd_port() -> u16 {
  env::var("FORKSD_PORT")
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(DEFAULT_PORT)
}

fn forksd_bind() -> String {
  env::var("FORKSD_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string())
}

fn forksd_base_url() -> String {
  let bind = forksd_bind();
  let host = if bind.contains(':') {
    format!("[{}]", bind)
  } else {
    bind
  };
  format!("http://{}:{}", host, forksd_port())
}

fn forksd_auth_path(app: &AppHandle) -> Result<PathBuf, String> {
  let base = app
    .path()
    .app_data_dir()
    .map_err(|err| err.to_string())?;
  Ok(base.join("forksd").join(AUTH_FILE_NAME))
}

fn read_stored_token(path: &Path) -> Option<String> {
  fs::read_to_string(path)
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn store_token(path: &Path, token: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  fs::write(path, token).map_err(|err| err.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let permissions = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, permissions).map_err(|err| err.to_string())?;
  }
  Ok(())
}

fn generate_token() -> String {
  let mut bytes = [0u8; 32];
  OsRng.fill_bytes(&mut bytes);
  URL_SAFE_NO_PAD.encode(bytes)
}

fn get_or_create_token(path: &Path) -> Result<String, String> {
  if let Some(token) = read_stored_token(path) {
    return Ok(token);
  }
  let token = generate_token();
  store_token(path, &token)?;
  Ok(token)
}

fn rotate_token(path: &Path) -> Result<String, String> {
  let token = generate_token();
  store_token(path, &token)?;
  Ok(token)
}

fn fetch_health(token: &str, base_url: &str) -> Result<(bool, u16, Option<String>), String> {
  let response = ureq::get(&format!("{}/health", base_url))
    .set("Authorization", &format!("Bearer {}", token))
    .call();

  match response {
    Ok(_) => Ok((true, 200, None)),
    Err(ureq::Error::Status(status, response)) => {
      let code = response
        .into_json::<HealthResponse>()
        .ok()
        .and_then(|value| value.code);
      Ok((false, status as u16, code))
    }
    Err(_) => Ok((false, 0, None)),
  }
}

fn resolve_forksd_dir(app: &AppHandle) -> Option<PathBuf> {
  if let Ok(dir) = env::var("FORKSD_DIR") {
    let path = PathBuf::from(dir);
    if path.join("package.json").exists() {
      return Some(path);
    }
  }

  let mut candidates = Vec::new();
  if let Ok(current) = env::current_dir() {
    candidates.push(current.join("../forksd"));
    candidates.push(current.join("../../forksd"));
  }
  if let Ok(resources) = app.path().resource_dir() {
    candidates.push(resources.join("../forksd"));
  }

  candidates
    .into_iter()
    .find(|candidate| candidate.join("package.json").exists())
}

fn spawn_forksd(app: &AppHandle, token: &str) -> Result<(), String> {
  if !tauri::is_dev() {
    return Ok(());
  }

  let Some(forksd_dir) = resolve_forksd_dir(app) else {
    return Err("forksd directory not found".to_string());
  };

  let default_origins = [
    "tauri://localhost",
    "http://localhost:1420",
    "http://localhost:5173",
    "file://",
  ]
  .join(",");

  let allowed_origins =
    env::var("FORKSD_ALLOWED_ORIGINS").unwrap_or_else(|_| default_origins);

  Command::new("bun")
    .arg("run")
    .arg("dev")
    .current_dir(forksd_dir)
    .env("FORKSD_AUTH_TOKEN", token)
    .env("FORKSD_BIND", forksd_bind())
    .env("FORKSD_PORT", forksd_port().to_string())
    .env("FORKSD_ALLOWED_ORIGINS", allowed_origins)
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .spawn()
    .map(|_| ())
    .map_err(|err| err.to_string())
}

fn ensure_forksd_running(app: &AppHandle, token: &str) -> Result<String, String> {
  let base_url = forksd_base_url();
  let (ok, status, code) = fetch_health(token, &base_url)?;
  if ok {
    return Ok(token.to_string());
  }

  if status == 0 {
    spawn_forksd(app, token)?;
    return Ok(token.to_string());
  }

  if status == 401 || code.as_deref() == Some("auth_invalid") {
    return Err("forksd auth mismatch; restart the app".to_string());
  }

  Err(format!("forksd health check failed (status: {})", status))
}

#[tauri::command]
fn forksd_connection_info(app: AppHandle) -> Result<ForksdConnectionInfo, String> {
  let token_path = forksd_auth_path(&app)?;
  let token = get_or_create_token(&token_path)?;
  let token = ensure_forksd_running(&app, &token)?;
  Ok(ForksdConnectionInfo {
    baseUrl: forksd_base_url(),
    token,
  })
}

#[tauri::command]
fn forksd_rotate_token(app: AppHandle) -> Result<String, String> {
  let token_path = forksd_auth_path(&app)?;
  rotate_token(&token_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      compute_unified_diff,
      forksd_connection_info,
      forksd_rotate_token
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
