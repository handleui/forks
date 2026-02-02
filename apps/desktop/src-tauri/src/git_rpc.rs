use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::thread;
use tauri::{AppHandle, Manager};

use crate::diff;
use crate::git;

const GIT_RPC_SOCKET_NAME: &str = "git-rpc.sock";

static RPC_SOCKET_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Deserialize)]
struct RpcRequest {
  id: String,
  method: String,
  params: serde_json::Value,
}

#[derive(Serialize)]
struct RpcResponse<T> {
  id: String,
  ok: bool,
  result: Option<T>,
  error: Option<String>,
}

#[derive(Deserialize)]
struct PathParam {
  path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoPathParam {
  repo_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchExistsParam {
  repo_path: String,
  branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBranchParam {
  repo_path: String,
  branch: String,
  start_point: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorktreeParam {
  repo_path: String,
  path: String,
  branch: String,
  create_branch: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWorktreeParam {
  worktree_path: String,
  force: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteBranchParam {
  repo_path: String,
  branch: String,
  force: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetHardParam {
  repo_path: String,
  git_ref: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffRequest {
  original: String,
  modified: String,
  context_lines: Option<usize>,
}

#[allow(dead_code)]
pub fn active_socket_path() -> Option<PathBuf> {
  RPC_SOCKET_PATH.get().cloned()
}

pub fn start_git_rpc_server(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = RPC_SOCKET_PATH.get() {
    return Ok(path.clone());
  }

  let socket_path = git_rpc_socket_path(app)?;
  if socket_path.exists() {
    fs::remove_file(&socket_path).map_err(|err| err.to_string())?;
  }

  let listener =
    UnixListener::bind(&socket_path).map_err(|err| err.to_string())?;

  // Set socket permissions to owner-only (0600) for security
  fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
    .map_err(|err| format!("failed to set socket permissions: {}", err))?;

  RPC_SOCKET_PATH
    .set(socket_path.clone())
    .map_err(|_| "Git RPC already initialized".to_string())?;

  // No limit on concurrent connections - each spawns a new thread. Fine for a local
  // single-user app. A thread pool (e.g., rayon) could be added if this becomes an issue.
  thread::spawn(move || {
    for stream in listener.incoming() {
      match stream {
        Ok(stream) => {
          thread::spawn(|| {
            handle_stream(stream);
          });
        }
        Err(err) => {
          eprintln!("[git-rpc] accept failed: {}", err);
        }
      }
    }
  });

  Ok(socket_path)
}

pub fn ensure_git_rpc_server(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = RPC_SOCKET_PATH.get() {
    return Ok(path.clone());
  }
  start_git_rpc_server(app)
}

fn git_rpc_socket_path(app: &AppHandle) -> Result<PathBuf, String> {
  let base = app
    .path()
    .app_data_dir()
    .map_err(|err| err.to_string())?;
  let dir = base.join("forksd");
  fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
  Ok(dir.join(GIT_RPC_SOCKET_NAME))
}

// Request-per-connection design: each connection handles exactly one request then closes.
// This simplifies the protocol (no framing/multiplexing) and client implementation.
// Clients must open a new connection for each RPC call.
fn handle_stream(stream: UnixStream) {
  let reader = BufReader::new(&stream);
  let mut writer = &stream;

  for line in reader.lines() {
    let line = match line {
      Ok(line) => line,
      Err(err) => {
        eprintln!("[git-rpc] read failed: {}", err);
        return;
      }
    };
    if line.trim().is_empty() {
      continue;
    }

    let response = match serde_json::from_str::<RpcRequest>(&line) {
      Ok(request) => handle_request(request),
      Err(err) => RpcResponse::<serde_json::Value> {
        id: "unknown".to_string(),
        ok: false,
        result: None,
        error: Some(err.to_string()),
      },
    };

    if let Ok(payload) = serde_json::to_string(&response) {
      if writer.write_all(payload.as_bytes()).is_ok() {
        let _ = writer.write_all(b"\n");
      }
    }
    return;
  }
}

fn handle_request(request: RpcRequest) -> RpcResponse<serde_json::Value> {
  let id = request.id.clone();
  let result = match request.method.as_str() {
    "git_is_repo" => parse_and_execute::<PathParam, _>(request.params, |p| {
      git::git_is_repo(p.path)
        .map(|value| serde_json::Value::Bool(value))
    }),
    "git_repo_root" => parse_and_execute::<PathParam, _>(request.params, |p| {
      git::git_repo_root(p.path)
        .map(serde_json::Value::String)
    }),
    "git_default_branch" => {
      parse_and_execute::<RepoPathParam, _>(request.params, |p| {
        git::git_default_branch(p.repo_path)
          .map(serde_json::Value::String)
      })
    }
    "git_current_branch" => {
      parse_and_execute::<PathParam, _>(request.params, |p| {
        git::git_current_branch(p.path)
          .map(serde_json::Value::String)
      })
    }
    "git_branch_exists" => {
      parse_and_execute::<BranchExistsParam, _>(request.params, |p| {
        git::git_branch_exists(p.repo_path, p.branch)
          .map(|value| serde_json::Value::Bool(value))
      })
    }
    "git_create_branch" => {
      parse_and_execute::<CreateBranchParam, _>(request.params, |p| {
        git::git_create_branch(p.repo_path, p.branch, p.start_point)
          .map(|_| serde_json::Value::Null)
      })
    }
    "git_list_worktrees" => {
      parse_and_execute::<RepoPathParam, _>(request.params, |p| {
        git::git_list_worktrees(p.repo_path)
          .map(|value| serde_json::to_value(value).unwrap_or_default())
      })
    }
    "git_create_worktree" => {
      parse_and_execute::<CreateWorktreeParam, _>(request.params, |p| {
        git::git_create_worktree(
          p.repo_path,
          p.path,
          p.branch,
          p.create_branch.unwrap_or(false),
        )
        .map(|_| serde_json::Value::Null)
      })
    }
    "git_remove_worktree" => {
      parse_and_execute::<RemoveWorktreeParam, _>(request.params, |p| {
        git::git_remove_worktree(p.worktree_path, p.force)
          .map(|_| serde_json::Value::Null)
      })
    }
    "git_delete_branch" => {
      parse_and_execute::<DeleteBranchParam, _>(request.params, |p| {
        git::git_delete_branch(p.repo_path, p.branch, p.force)
          .map(|_| serde_json::Value::Null)
      })
    }
    "git_current_commit" => {
      parse_and_execute::<RepoPathParam, _>(request.params, |p| {
        git::git_current_commit(p.repo_path)
          .map(serde_json::Value::String)
      })
    }
    "git_reset_hard" => {
      parse_and_execute::<ResetHardParam, _>(request.params, |p| {
        git::git_reset_hard(p.repo_path, p.git_ref)
          .map(|_| serde_json::Value::Null)
      })
    }
    "git_status" => {
      parse_and_execute::<RepoPathParam, _>(request.params, |p| {
        git::git_status(p.repo_path)
          .map(|value| serde_json::to_value(value).unwrap_or_default())
      })
    }
    "git_changed_files" => {
      parse_and_execute::<RepoPathParam, _>(request.params, |p| {
        git::git_changed_files(p.repo_path)
          .map(|value| serde_json::to_value(value).unwrap_or_default())
      })
    }
    "diff_unified" => {
      parse_and_execute::<DiffRequest, _>(request.params, |p| {
        let context = p.context_lines.unwrap_or(3).min(200);
        Ok(serde_json::Value::String(diff::unified_diff(
          &p.original,
          &p.modified,
          context,
        )))
      })
    }
    _ => Err("unknown_method".to_string()),
  };

  match result {
    Ok(value) => RpcResponse {
      id,
      ok: true,
      result: Some(value),
      error: None,
    },
    Err(err) => RpcResponse {
      id,
      ok: false,
      result: None,
      error: Some(err),
    },
  }
}

fn parse_and_execute<P, F>(
  params: serde_json::Value,
  handler: F,
) -> Result<serde_json::Value, String>
where
  P: for<'de> Deserialize<'de>,
  F: FnOnce(P) -> Result<serde_json::Value, String>,
{
  let parsed: P = serde_json::from_value(params).map_err(|_| "invalid_params".to_string())?;
  handler(parsed)
}
