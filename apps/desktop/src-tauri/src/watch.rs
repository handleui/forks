use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const DEFAULT_DEBOUNCE_MS: u64 = 150;
const MIN_DEBOUNCE_MS: u64 = 50;
const MAX_DEBOUNCE_MS: u64 = 2000;
const EVENT_NAME: &str = "fs/watch";
// Cap pending paths to prevent unbounded memory growth during burst events
const MAX_PENDING_PATHS: usize = 10_000;
const DEFAULT_IGNORED_DIRS: [&str; 12] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".turbo",
  ".context",
  ".tauri",
  ".next",
  "out",
  "coverage",
  ".cache",
];

#[derive(Default)]
pub struct WatchManager {
  inner: Mutex<WatchRegistry>,
}

#[derive(Default)]
struct WatchRegistry {
  next_id: u64,
  entries: HashMap<String, WatchEntry>,
}

struct WatchEntry {
  #[allow(dead_code)]
  sender: Sender<Event>,
  _watcher: RecommendedWatcher,
  _git_watchers: Vec<RecommendedWatcher>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchAddRequest {
  pub path: String,
  pub repo_root: Option<String>,
  pub attempt_id: Option<String>,
  pub debounce_ms: Option<u64>,
  pub watch_git: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchAddResponse {
  pub watch_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WatchEventPayload {
  watch_id: String,
  repo_root: String,
  worktree_path: String,
  attempt_id: Option<String>,
  paths: Vec<String>,
  kinds: Vec<String>,
  timestamp_ms: u64,
}

struct FilterConfig {
  #[allow(dead_code)]
  repo_root: PathBuf,
  worktree_path: PathBuf,
  git_dir: Option<PathBuf>,
  ignored_dirs: HashSet<String>,
}

struct WorkerConfig {
  watch_id: String,
  #[allow(dead_code)]
  repo_root: PathBuf,
  repo_root_display: String,
  #[allow(dead_code)]
  worktree_path: PathBuf,
  worktree_display: String,
  attempt_id: Option<String>,
  debounce_ms: u64,
  filter: FilterConfig,
}

impl WatchManager {
  pub fn new() -> Self {
    Self {
      inner: Mutex::new(WatchRegistry {
        next_id: 1,
        entries: HashMap::new(),
      }),
    }
  }

  pub fn add_watch(
    &self,
    app: AppHandle,
    request: WatchAddRequest,
  ) -> Result<WatchAddResponse, String> {
    let worktree_path = canonicalize_absolute(&request.path)?;
    if !worktree_path.is_dir() {
      return Err("watch path must be a directory".to_string());
    }

    let repo_root = if let Some(repo_root) = request.repo_root {
      canonicalize_absolute(&repo_root)?
    } else {
      worktree_path.clone()
    };

    let debounce_ms = clamp_debounce(request.debounce_ms.unwrap_or(DEFAULT_DEBOUNCE_MS));
    let watch_git = request.watch_git.unwrap_or(true);
    let git_dir = if watch_git {
      resolve_git_dir(&repo_root)
    } else {
      None
    };

    let filter = FilterConfig {
      repo_root: repo_root.clone(),
      worktree_path: worktree_path.clone(),
      git_dir: git_dir.clone(),
      ignored_dirs: DEFAULT_IGNORED_DIRS
        .iter()
        .map(|value| value.to_string())
        .collect(),
    };

    let watch_id = {
      let mut registry = self
        .inner
        .lock()
        .map_err(|_| "watcher lock poisoned".to_string())?;
      let id = registry.next_id.to_string();
      registry.next_id += 1;
      id
    };

    let worker_config = WorkerConfig {
      watch_id: watch_id.clone(),
      repo_root: repo_root.clone(),
      repo_root_display: repo_root.display().to_string(),
      worktree_path: worktree_path.clone(),
      worktree_display: worktree_path.display().to_string(),
      attempt_id: request.attempt_id,
      debounce_ms,
      filter,
    };

    let sender = spawn_worker(app, worker_config);
    let mut watcher = make_watcher(sender.clone())?;
    watcher
      .watch(&worktree_path, RecursiveMode::Recursive)
      .map_err(|err| err.to_string())?;

    let mut git_watchers = Vec::new();
    if let Some(git_dir) = git_dir {
      let git_paths = git_watch_paths(&git_dir);
      for (path, recursive) in git_paths {
        if path.exists() {
          let mut git_watcher = make_watcher(sender.clone())?;
          git_watcher
            .watch(&path, recursive)
            .map_err(|err| err.to_string())?;
          git_watchers.push(git_watcher);
        }
      }
    }

    let mut registry = self
      .inner
      .lock()
      .map_err(|_| "watcher lock poisoned".to_string())?;
    registry.entries.insert(
      watch_id.clone(),
      WatchEntry {
        sender,
        _watcher: watcher,
        _git_watchers: git_watchers,
      },
    );

    Ok(WatchAddResponse { watch_id })
  }

  pub fn remove_watch(&self, watch_id: &str) -> Result<(), String> {
    let mut registry = self.inner.lock().map_err(|_| "watcher lock poisoned".to_string())?;
    registry
      .entries
      .remove(watch_id)
      .ok_or_else(|| "watch not found".to_string())?;
    Ok(())
  }

  pub fn remove_all(&self) -> Result<(), String> {
    let mut registry = self.inner.lock().map_err(|_| "watcher lock poisoned".to_string())?;
    registry.entries.clear();
    Ok(())
  }
}

#[tauri::command]
pub fn watch_add(
  app: AppHandle,
  state: tauri::State<'_, WatchManager>,
  request: WatchAddRequest,
) -> Result<WatchAddResponse, String> {
  state.add_watch(app, request)
}

#[tauri::command]
pub fn watch_remove(
  state: tauri::State<'_, WatchManager>,
  watch_id: String,
) -> Result<(), String> {
  state.remove_watch(&watch_id)
}

#[tauri::command]
pub fn watch_remove_all(state: tauri::State<'_, WatchManager>) -> Result<(), String> {
  state.remove_all()
}

fn clamp_debounce(value: u64) -> u64 {
  value.clamp(MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS)
}

fn canonicalize_absolute(path: &str) -> Result<PathBuf, String> {
  if path.trim().is_empty() {
    return Err("path is required".to_string());
  }
  let path = PathBuf::from(path);
  if !path.is_absolute() {
    return Err("path must be absolute".to_string());
  }
  fs::canonicalize(&path).map_err(|err| err.to_string())
}

fn resolve_git_dir(repo_root: &Path) -> Option<PathBuf> {
  let git_path = repo_root.join(".git");
  if git_path.is_dir() {
    return fs::canonicalize(&git_path).ok();
  }
  if git_path.is_file() {
    let content = fs::read_to_string(&git_path).ok()?;
    let value = content.trim();
    let path_value = value.strip_prefix("gitdir:")?.trim();
    let git_dir = PathBuf::from(path_value);
    let resolved = if git_dir.is_absolute() {
      git_dir
    } else {
      repo_root.join(git_dir)
    };
    return fs::canonicalize(resolved).ok();
  }
  None
}

fn git_watch_paths(git_dir: &Path) -> Vec<(PathBuf, RecursiveMode)> {
  vec![
    (git_dir.join("HEAD"), RecursiveMode::NonRecursive),
    (git_dir.join("index"), RecursiveMode::NonRecursive),
    (git_dir.join("packed-refs"), RecursiveMode::NonRecursive),
    (git_dir.join("refs"), RecursiveMode::Recursive),
  ]
}

fn make_watcher(sender: Sender<Event>) -> Result<RecommendedWatcher, String> {
  // HACK: poll_interval improves cross-platform consistency (Docker/M1, network filesystems)
  let config = Config::default().with_poll_interval(Duration::from_secs(2));
  RecommendedWatcher::new(
    move |res| match res {
      Ok(event) => {
        let _ = sender.send(event);
      }
      Err(err) => {
        eprintln!("watch error: {err:?}");
      }
    },
    config,
  )
  .map_err(|err| err.to_string())
}

fn spawn_worker(app: AppHandle, config: WorkerConfig) -> Sender<Event> {
  let (sender, receiver) = mpsc::channel::<Event>();
  let thread_name = format!("watch-{}", config.watch_id);

  thread::Builder::new()
    .name(thread_name)
    .spawn(move || {
    let debounce = Duration::from_millis(config.debounce_ms);
    let mut pending_paths = HashSet::<String>::new();
    let mut pending_kinds = HashSet::<String>::new();

    loop {
      let event = match receiver.recv() {
        Ok(event) => event,
        Err(_) => break,
      };
      collect_event(&event, &config.filter, &mut pending_paths, &mut pending_kinds);

      loop {
        match receiver.recv_timeout(debounce) {
          Ok(event) => {
            collect_event(&event, &config.filter, &mut pending_paths, &mut pending_kinds);
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {
            flush_events(&app, &config, &mut pending_paths, &mut pending_kinds);
            break;
          }
          Err(mpsc::RecvTimeoutError::Disconnected) => {
            flush_events(&app, &config, &mut pending_paths, &mut pending_kinds);
            return;
          }
        }
      }
    }
  })
  .expect("failed to spawn watch worker");

  sender
}

fn collect_event(
  event: &Event,
  filter: &FilterConfig,
  pending_paths: &mut HashSet<String>,
  pending_kinds: &mut HashSet<String>,
) {
  if !is_relevant_kind(&event.kind) {
    return;
  }

  let kind = kind_label(&event.kind);
  pending_kinds.insert(kind.to_string());

  // Skip if already at capacity to prevent unbounded memory growth
  if pending_paths.len() >= MAX_PENDING_PATHS {
    return;
  }

  for path in &event.paths {
    if pending_paths.len() >= MAX_PENDING_PATHS {
      break;
    }
    if !should_emit_path(path, filter) {
      continue;
    }
    let formatted = format_event_path(
      path,
      &filter.worktree_path,
      filter.git_dir.as_ref().map(|value| value.as_path()),
    );
    pending_paths.insert(formatted);
  }
}

fn flush_events(
  app: &AppHandle,
  config: &WorkerConfig,
  pending_paths: &mut HashSet<String>,
  pending_kinds: &mut HashSet<String>,
) {
  if pending_paths.is_empty() {
    pending_kinds.clear();
    return;
  }

  let payload = WatchEventPayload {
    watch_id: config.watch_id.clone(),
    repo_root: config.repo_root_display.clone(),
    worktree_path: config.worktree_display.clone(),
    attempt_id: config.attempt_id.clone(),
    paths: pending_paths.drain().collect(),
    kinds: pending_kinds.drain().collect(),
    timestamp_ms: now_ms(),
  };

  let _ = app.emit(EVENT_NAME, payload);
}

fn should_emit_path(path: &Path, filter: &FilterConfig) -> bool {
  if let Some(git_dir) = &filter.git_dir {
    if path.starts_with(git_dir) {
      return is_allowed_git_path(path, git_dir);
    }
  }

  for component in path.components() {
    let value = component.as_os_str().to_string_lossy();
    if filter.ignored_dirs.contains(value.as_ref()) {
      return false;
    }
  }

  true
}

fn is_allowed_git_path(path: &Path, git_dir: &Path) -> bool {
  let Ok(relative) = path.strip_prefix(git_dir) else {
    return false;
  };
  if relative == Path::new("HEAD")
    || relative == Path::new("index")
    || relative == Path::new("packed-refs")
  {
    return true;
  }
  matches!(relative.components().next(), Some(std::path::Component::Normal(name)) if name == "refs")
}

fn format_event_path(path: &Path, worktree_path: &Path, git_dir: Option<&Path>) -> String {
  if let Ok(relative) = path.strip_prefix(worktree_path) {
    return relative.display().to_string();
  }
  if let Some(git_dir) = git_dir {
    if let Ok(relative) = path.strip_prefix(git_dir) {
      return Path::new(".git").join(relative).display().to_string();
    }
  }
  path.display().to_string()
}

fn is_relevant_kind(kind: &EventKind) -> bool {
  !matches!(kind, EventKind::Access(_))
}

fn kind_label(kind: &EventKind) -> &'static str {
  match kind {
    EventKind::Create(_) => "create",
    EventKind::Modify(_) => "modify",
    EventKind::Remove(_) => "remove",
    EventKind::Access(_) => "access",
    EventKind::Any => "any",
    EventKind::Other => "other",
  }
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_else(|_| Duration::from_millis(0))
    .as_millis() as u64
}
