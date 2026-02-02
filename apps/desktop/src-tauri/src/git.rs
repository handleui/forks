use git2::{
  ObjectType,
  Repository,
  ResetType,
  Worktree,
  WorktreeAddOptions,
  WorktreeLockStatus,
  WorktreePruneOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// Repository cache: avoids reopening the same repo repeatedly
const REPO_CACHE_TTL_SECS: u64 = 30;
const REPO_CACHE_MAX_SIZE: usize = 16;

struct CachedRepo {
  repo: Repository,
  last_used: Instant,
}

struct RepoCache {
  entries: HashMap<PathBuf, CachedRepo>,
}

impl RepoCache {
  fn new() -> Self {
    Self {
      entries: HashMap::new(),
    }
  }

  fn evict_stale(&mut self, now: Instant, ttl: Duration) {
    self.entries.retain(|_, entry| now.duration_since(entry.last_used) < ttl);
  }

  fn evict_oldest(&mut self) {
    if let Some(oldest_key) = self
      .entries
      .iter()
      .min_by_key(|(_, entry)| entry.last_used)
      .map(|(key, _)| key.clone())
    {
      self.entries.remove(&oldest_key);
    }
  }

  fn get_or_open(&mut self, path: &Path) -> Result<&Repository, String> {
    let now = Instant::now();
    let ttl = Duration::from_secs(REPO_CACHE_TTL_SECS);

    self.evict_stale(now, ttl);

    while self.entries.len() >= REPO_CACHE_MAX_SIZE {
      self.evict_oldest();
    }

    let canonical = std::fs::canonicalize(path).map_err(|err| err.to_string())?;

    if !self.entries.contains_key(&canonical) {
      let repo = Repository::open(&canonical)
        .or_else(|_| Repository::discover(&canonical))
        .map_err(|err| err.to_string())?;
      self.entries.insert(
        canonical.clone(),
        CachedRepo {
          repo,
          last_used: now,
        },
      );
    }

    let entry = self.entries.get_mut(&canonical).unwrap();
    entry.last_used = now;
    Ok(&entry.repo)
  }
}

static REPO_CACHE: OnceLock<Mutex<RepoCache>> = OnceLock::new();

fn get_repo_cache() -> &'static Mutex<RepoCache> {
  REPO_CACHE.get_or_init(|| Mutex::new(RepoCache::new()))
}

fn with_cached_repo<F, T>(path: &str, f: F) -> Result<T, String>
where
  F: FnOnce(&Repository) -> Result<T, String>,
{
  let mut cache = get_repo_cache()
    .lock()
    .map_err(|_| "repo cache lock poisoned".to_string())?;
  let repo = cache.get_or_open(Path::new(path))?;
  f(repo)
}

/// Forbidden characters in git refs (based on git-check-ref-format).
/// Includes space, tilde, caret, colon, question mark, asterisk, brackets, backslash, at-sign, and braces.
const GIT_REF_FORBIDDEN: &[char] = &[' ', '~', '^', ':', '?', '*', '[', ']', '\\', '@', '{'];

/// Validates a git ref name according to git-check-ref-format rules.
/// This provides defense-in-depth validation at the Rust boundary.
fn validate_git_ref(name: &str) -> Result<(), String> {
  if name.is_empty() || name.len() > 256 {
    return Err("invalid ref: empty or too long".to_string());
  }
  // Cannot start with dash (prevents option injection)
  if name.starts_with('-') {
    return Err("invalid ref: starts with dash".to_string());
  }
  // Cannot end with .lock
  if name.ends_with(".lock") {
    return Err("invalid ref: ends with .lock".to_string());
  }
  // Cannot contain consecutive slashes
  if name.contains("//") {
    return Err("invalid ref: contains consecutive slashes".to_string());
  }
  // Cannot contain @{
  if name.contains("@{") {
    return Err("invalid ref: contains @{".to_string());
  }
  // Cannot contain control characters (0x00-0x1F and 0x7F)
  for ch in name.chars() {
    let code = ch as u32;
    if code <= 0x1f || code == 0x7f {
      return Err("invalid ref: contains control character".to_string());
    }
  }
  // Cannot contain forbidden git characters
  if name.chars().any(|ch| GIT_REF_FORBIDDEN.contains(&ch)) {
    return Err("invalid ref: contains forbidden character".to_string());
  }
  // Check each component between slashes
  for component in name.split('/') {
    if component.is_empty() || component.starts_with('.') || component.ends_with('.') {
      return Err("invalid ref: invalid path component".to_string());
    }
  }
  Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct WorktreeInfo {
  pub path: String,
  pub head: String,
  pub branch: Option<String>,
  pub bare: bool,
  pub detached: bool,
  pub locked: bool,
  pub prunable: bool,
}

#[derive(Serialize, Deserialize)]
pub struct GitStatusEntry {
  pub path: String,
  pub status: String,
}

fn open_repo(path: &str) -> Result<Repository, String> {
  Repository::discover(path).map_err(|err| err.to_string())
}

fn open_repo_at(path: &str) -> Result<Repository, String> {
  Repository::open(path)
    .or_else(|_| Repository::discover(path))
    .map_err(|err| err.to_string())
}

fn repo_workdir(repo: &Repository) -> Result<&Path, String> {
  repo
    .workdir()
    .ok_or_else(|| "repository has no working directory".to_string())
}

fn branch_from_head(repo: &Repository) -> Option<String> {
  let head = repo.head().ok()?;
  let shorthand = head.shorthand()?;
  if shorthand == "HEAD" {
    None
  } else {
    Some(shorthand.to_string())
  }
}

fn head_oid_string(repo: &Repository) -> String {
  let head = match repo.head() {
    Ok(value) => value,
    Err(_) => return String::new(),
  };
  match head.target() {
    Some(target) => target.to_string(),
    None => String::new(),
  }
}

fn is_detached(repo: &Repository) -> bool {
  repo.head_detached().unwrap_or(false)
}

fn worktree_info_for_path(
  path: &Path,
  locked: bool,
  prunable: bool,
) -> Result<WorktreeInfo, String> {
  let repo = Repository::open(path).map_err(|err| err.to_string())?;
  Ok(WorktreeInfo {
    path: path.to_string_lossy().to_string(),
    head: head_oid_string(&repo),
    branch: branch_from_head(&repo),
    bare: repo.is_bare(),
    detached: is_detached(&repo),
    locked,
    prunable,
  })
}

fn worktree_name_from_path(path: &Path, fallback: &str) -> String {
  if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
    return name.to_string();
  }
  fallback.replace("/", "-")
}

fn create_branch_at_head(
  repo: &Repository,
  branch: &str,
) -> Result<(), String> {
  let head = repo.head().map_err(|err| err.to_string())?;
  let commit = head
    .peel(ObjectType::Commit)
    .map_err(|err| err.to_string())?
    .into_commit()
    .map_err(|_| "invalid commit".to_string())?;
  repo
    .branch(branch, &commit, false)
    .map(|_| ())
    .map_err(|err| err.to_string())
}

fn resolve_commit<'repo>(
  repo: &'repo Repository,
  spec: &str,
) -> Result<git2::Commit<'repo>, String> {
  let object = repo
    .revparse_single(spec)
    .map_err(|err| err.to_string())?;
  object
    .peel(ObjectType::Commit)
    .map_err(|err| err.to_string())?
    .into_commit()
    .map_err(|_| "invalid commit".to_string())
}

fn ensure_clean_worktree(path: &Path) -> Result<(), String> {
  let repo = Repository::open(path).map_err(|err| err.to_string())?;
  let statuses = repo
    .statuses(None)
    .map_err(|err| err.to_string())?;
  if statuses.is_empty() {
    Ok(())
  } else {
    Err("worktree has uncommitted changes".to_string())
  }
}

fn status_to_kind(status: git2::Status) -> Option<String> {
  if status.is_conflicted() {
    return Some("conflicted".to_string());
  }
  if status.is_index_deleted() || status.is_wt_deleted() {
    return Some("deleted".to_string());
  }
  if status.is_index_new() {
    return Some("added".to_string());
  }
  if status.is_wt_new() {
    return Some("untracked".to_string());
  }
  if status.is_index_renamed() || status.is_wt_renamed() {
    return Some("renamed".to_string());
  }
  if status.is_index_typechange() || status.is_wt_typechange() {
    return Some("typechange".to_string());
  }
  if status.is_index_modified() || status.is_wt_modified() {
    return Some("modified".to_string());
  }
  None
}

#[tauri::command]
pub fn git_is_repo(path: String) -> Result<bool, String> {
  Ok(open_repo(&path).is_ok())
}

#[tauri::command]
pub fn git_repo_root(path: String) -> Result<String, String> {
  let repo = open_repo(&path)?;
  let workdir = repo_workdir(&repo)?;
  Ok(workdir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn git_default_branch(repo_path: String) -> Result<String, String> {
  with_cached_repo(&repo_path, |repo| {
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
      if let Some(target) = reference.symbolic_target() {
        if let Some(stripped) = target.strip_prefix("refs/remotes/origin/") {
          return Ok(stripped.to_string());
        }
        return Ok(target.to_string());
      }
    }
    if let Some(branch) = branch_from_head(repo) {
      return Ok(branch);
    }
    Ok("main".to_string())
  })
}

#[tauri::command]
pub fn git_current_branch(path: String) -> Result<String, String> {
  with_cached_repo(&path, |repo| {
    Ok(branch_from_head(repo).unwrap_or_default())
  })
}

#[tauri::command]
pub fn git_branch_exists(repo_path: String, branch: String) -> Result<bool, String> {
  validate_git_ref(&branch)?;
  with_cached_repo(&repo_path, |repo| {
    let ref_name = format!("refs/heads/{}", branch);
    let exists = repo.find_reference(&ref_name).is_ok();
    Ok(exists)
  })
}

#[tauri::command]
pub fn git_create_branch(
  repo_path: String,
  branch: String,
  start_point: Option<String>,
) -> Result<(), String> {
  validate_git_ref(&branch)?;
  if let Some(ref sp) = start_point {
    validate_git_ref(sp)?;
  }
  let repo = open_repo_at(&repo_path)?;
  let commit = match start_point {
    Some(spec) => resolve_commit(&repo, &spec)?,
    None => {
      let head = repo.head().map_err(|err| err.to_string())?;
      head
        .peel(ObjectType::Commit)
        .map_err(|err| err.to_string())?
        .into_commit()
        .map_err(|_| "invalid commit".to_string())?
    }
  };
  repo
    .branch(&branch, &commit, false)
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn git_list_worktrees(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
  let repo = open_repo_at(&repo_path)?;
  let mut worktrees = Vec::new();

  if let Ok(workdir) = repo_workdir(&repo) {
    worktrees.push(worktree_info_for_path(workdir, false, false)?);
  }

  let names = repo.worktrees().map_err(|err| err.to_string())?;
  for name in names.iter().flatten() {
    let worktree = repo.find_worktree(name).map_err(|err| err.to_string())?;
    let locked = matches!(worktree.is_locked(), Ok(WorktreeLockStatus::Locked(_)));
    let mut prune_opts = WorktreePruneOptions::new();
    let prunable = worktree.is_prunable(Some(&mut prune_opts)).unwrap_or(false);
    worktrees.push(worktree_info_for_path(worktree.path(), locked, prunable)?);
  }

  Ok(worktrees)
}

#[tauri::command]
pub fn git_create_worktree(
  repo_path: String,
  path: String,
  branch: String,
  create_branch: bool,
) -> Result<(), String> {
  validate_git_ref(&branch)?;
  let repo = open_repo_at(&repo_path)?;
  let path_buf = PathBuf::from(&path);

  if create_branch {
    create_branch_at_head(&repo, &branch)?;
  }

  let reference = repo
    .find_reference(&format!("refs/heads/{}", branch))
    .map_err(|err| err.to_string())?;

  let mut opts = WorktreeAddOptions::new();
  opts.reference(Some(&reference));

  let name = worktree_name_from_path(&path_buf, &branch);
  repo
    .worktree(&name, &path_buf, Some(&mut opts))
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn git_remove_worktree(
  worktree_path: String,
  force: Option<bool>,
) -> Result<(), String> {
  let path = PathBuf::from(&worktree_path);
  let repo = open_repo(&worktree_path)?;
  let worktree = Worktree::open_from_repository(&repo).map_err(|err| err.to_string())?;

  if !force.unwrap_or(false) {
    ensure_clean_worktree(&path)?;
  }

  let mut prune_opts = WorktreePruneOptions::new();
  prune_opts.valid(true);
  prune_opts.working_tree(true);
  if force.unwrap_or(false) {
    prune_opts.locked(true);
  }

  worktree
    .prune(Some(&mut prune_opts))
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn git_delete_branch(
  repo_path: String,
  branch: String,
  force: Option<bool>,
) -> Result<(), String> {
  validate_git_ref(&branch)?;
  let repo = open_repo_at(&repo_path)?;
  let mut reference = repo
    .find_reference(&format!("refs/heads/{}", branch))
    .map_err(|err| err.to_string())?;

  if force.unwrap_or(false) {
    reference
      .delete()
      .map_err(|err| err.to_string())?;
    return Ok(());
  }

  let head = repo.head().map_err(|err| err.to_string())?;
  if head.name() == reference.name() {
    return Err("cannot delete checked out branch".to_string());
  }

  let head_commit = head
    .peel(ObjectType::Commit)
    .map_err(|err| err.to_string())?
    .into_commit()
    .map_err(|_| "invalid commit".to_string())?;
  let branch_commit = reference
    .peel(ObjectType::Commit)
    .map_err(|err| err.to_string())?
    .into_commit()
    .map_err(|_| "invalid commit".to_string())?;
  let (ahead, _) = repo
    .graph_ahead_behind(branch_commit.id(), head_commit.id())
    .map_err(|err| err.to_string())?;
  if ahead > 0 {
    return Err("branch is not fully merged".to_string());
  }

  reference
    .delete()
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn git_current_commit(repo_path: String) -> Result<String, String> {
  with_cached_repo(&repo_path, |repo| {
    let head = repo.head().map_err(|err| err.to_string())?;
    let target = head.target().ok_or_else(|| "HEAD is unborn".to_string())?;
    Ok(target.to_string())
  })
}

#[tauri::command]
pub fn git_reset_hard(repo_path: String, git_ref: String) -> Result<(), String> {
  validate_git_ref(&git_ref)?;
  let repo = open_repo_at(&repo_path)?;
  let object = repo
    .revparse_single(&git_ref)
    .map_err(|err| err.to_string())?;
  repo
    .reset(&object, ResetType::Hard, None)
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn git_status(repo_path: String) -> Result<Vec<GitStatusEntry>, String> {
  let repo = open_repo_at(&repo_path)?;
  let mut options = git2::StatusOptions::new();
  options
    .include_untracked(true)
    .recurse_untracked_dirs(true)
    .include_ignored(false);
  let statuses = repo.statuses(Some(&mut options)).map_err(|err| err.to_string())?;
  let mut entries = Vec::new();
  for entry in statuses.iter() {
    let status = entry.status();
    let path = entry
      .path()
      .map(|value| value.to_string())
      .unwrap_or_default();
    if path.is_empty() {
      continue;
    }
    if let Some(kind) = status_to_kind(status) {
      entries.push(GitStatusEntry { path, status: kind });
    }
  }
  Ok(entries)
}

#[tauri::command]
pub fn git_changed_files(repo_path: String) -> Result<Vec<String>, String> {
  let entries = git_status(repo_path)?;
  Ok(entries.into_iter().map(|entry| entry.path).collect())
}
