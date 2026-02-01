use similar::TextDiff;

// TODO: Use for review/PR diff rendering when the desktop UI lands.

pub fn unified_diff(original: &str, modified: &str, context: usize) -> String {
  TextDiff::from_lines(original, modified)
    .unified_diff()
    .context_radius(context)
    .header("a", "b")
    .to_string()
}
