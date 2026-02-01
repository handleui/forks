use similar::TextDiff;

pub fn unified_diff(original: &str, modified: &str, context: usize) -> String {
  TextDiff::from_lines(original, modified)
    .unified_diff()
    .context_radius(context)
    .header("a", "b")
    .to_string()
}
