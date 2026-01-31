import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPHITE_TOOL_DEFINITIONS } from "../../../apps/forksd/src/mcp/graphite-tools.ts";
import { TERMINAL_TOOL_DEFINITIONS } from "../../../apps/forksd/src/mcp/terminal-tools.ts";
import { TOOL_DEFINITIONS } from "../../../apps/forksd/src/mcp/tools.ts";

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<
      string,
      {
        type?: string | string[];
        description?: string;
        items?: { type?: string };
      }
    >;
    required?: string[];
  };
}

interface ReferenceTemplate {
  title: string;
  intro: string;
  whenToUse: string[];
  extraSections: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = join(__dirname, "..", "forks-mcp");
const referencesDir = join(skillDir, "references");

const coreTools = TOOL_DEFINITIONS as ToolDefinition[];
const terminalTools = TERMINAL_TOOL_DEFINITIONS as ToolDefinition[];
const graphiteTools = GRAPHITE_TOOL_DEFINITIONS as ToolDefinition[];

const allTools = [...coreTools, ...terminalTools, ...graphiteTools];

const TRAILING_PERIOD_REGEX = /\.$/;

const categoryTools = {
  attempts: coreTools.filter((tool) => tool.name.startsWith("attempt_")),
  subagents: coreTools.filter((tool) => tool.name.startsWith("subagent_")),
  plans: coreTools.filter((tool) => tool.name.startsWith("plan_")),
  questions: coreTools.filter((tool) => tool.name.startsWith("question_")),
  tasks: coreTools.filter((tool) => tool.name.startsWith("task_")),
  terminals: terminalTools,
  graphite: graphiteTools,
};

const referenceTemplates: Record<string, ReferenceTemplate> = {
  attempts: {
    title: "Attempts (Parallel Exploration)",
    intro:
      "Attempts run multiple candidate solutions in parallel, then pick the best result.",
    whenToUse: [
      "Unclear best approach",
      "Need quick comparison of strategies",
      "Risky change that benefits from alternatives",
    ],
    extraSections: [
      "## Attempt Lifecycle",
      "",
      "```",
      "1. SPAWN: attempt_spawn creates N attempts",
      "2. RUN: each attempt works independently",
      "3. REVIEW: inspect attempt outputs",
      "4. PICK: attempt_pick selects the winner",
      "```",
      "",
      "## Statuses",
      "",
      "- running",
      "- completed",
      "- failed",
      "- picked",
      "- discarded",
      "",
      "## Best Practices",
      "",
      "1. Keep attempt tasks focused and comparable",
      "2. Use 2-5 attempts for most decisions",
      "3. Pick promptly to reduce resource usage",
    ].join("\n"),
  },
  subagents: {
    title: "Subagents (Delegation)",
    intro:
      "Subagents execute a scoped task independently while the parent continues.",
    whenToUse: [
      "Known subtask with clear deliverable",
      "Parallel execution without exploration",
      "Work that can be isolated safely",
    ],
    extraSections: [
      "## Subagent Lifecycle",
      "",
      "```",
      "1. SPAWN: subagent_spawn creates a subagent",
      "2. RUN: subagent works independently",
      "3. MONITOR: subagent_status/subagent_list",
      "4. AWAIT: subagent_await blocks until completion",
      "5. CANCEL: subagent_cancel if no longer needed",
      "```",
      "",
      "## Statuses",
      "",
      "- running",
      "- completed",
      "- failed",
      "- cancelled",
      "- interrupted",
      "",
      "## Best Practices",
      "",
      "1. Provide full context and explicit output format",
      "2. Avoid spawning many subagents for simple tasks",
      "3. Use subagent_list for shared visibility",
    ].join("\n"),
  },
  plans: {
    title: "Plans (Approval Workflows)",
    intro:
      "Plans capture intended changes and wait for user approval before execution.",
    whenToUse: [
      "Significant or risky changes",
      "User confirmation required",
      "Multiple valid approaches and user should choose",
    ],
    extraSections: [
      "## Plan Lifecycle",
      "",
      "```",
      "1. PROPOSE: plan_propose creates a pending plan",
      "2. RESPOND: plan_respond approves or rejects",
      "3. EXECUTE: proceed only if approved",
      "```",
      "",
      "## Statuses",
      "",
      "- pending",
      "- approved",
      "- rejected",
      "- cancelled",
      "",
      "## Plan Content Template",
      "",
      "```markdown",
      "## Summary",
      "What this plan changes.",
      "",
      "## Steps",
      "1. Step one",
      "2. Step two",
      "",
      "## Impact",
      "- User-visible effects",
      "- Rollback strategy",
      "```",
    ].join("\n"),
  },
  questions: {
    title: "Questions (User Interaction)",
    intro: "Questions ask the user for input when requirements are unclear.",
    whenToUse: [
      "Requirements are ambiguous",
      "Multiple valid options exist",
      "You need user preference",
    ],
    extraSections: [
      "## Question Lifecycle",
      "",
      "```",
      "1. ASK: question_create",
      "2. RESPOND: question_respond",
      "3. CHECK: question_status/question_list",
      "4. CANCEL: question_cancel if no longer needed",
      "```",
      "",
      "## Statuses",
      "",
      "- pending",
      "- answered",
      "- cancelled",
      "",
      "## Best Practices",
      "",
      "1. Ask one focused question at a time",
      "2. Provide options when possible",
      "3. Include relevant context",
    ].join("\n"),
  },
  tasks: {
    title: "Tasks (Shared Work Coordination)",
    intro: "Tasks coordinate multiple agents through a shared task list.",
    whenToUse: [
      "Divide work among agents",
      "Track progress for multi-step work",
      "Avoid duplicated effort",
    ],
    extraSections: [
      "## Task Lifecycle",
      "",
      "```",
      "1. CREATE: task_create",
      "2. CLAIM: task_claim or task_unclaim",
      "3. UPDATE: task_update (optional)",
      "4. FINISH: task_complete/task_fail",
      "5. CLEANUP: task_delete (optional)",
      "```",
      "",
      "## Statuses",
      "",
      "- pending",
      "- claimed",
      "- completed",
      "- failed",
      "",
      "## Best Practices",
      "",
      "1. Keep tasks atomic and well-scoped",
      "2. Always claim before working",
      "3. Provide useful results on completion",
    ].join("\n"),
  },
  terminals: {
    title: "Terminals (PTY Access)",
    intro:
      "Terminal tools provide read-only access to user terminals and controlled spawning of background processes.",
    whenToUse: [
      "Inspect output from a user terminal",
      "Start a background dev server or test runner",
      "Promote a background terminal to the UI",
    ],
    extraSections: [
      "## Security and Limits",
      "",
      "- Blocked commands include: rm, sudo, chmod, chown, mkfs, dd, fdisk, shutdown",
      "- Blocked patterns include: rm -rf /, pipe to shell, eval, backticks",
      "- Rate limit: 3 spawns per minute",
      "- Concurrency limit: 5 agent terminals",
      "- Agent can only kill agent-owned background terminals",
      "",
      "## Lifecycle",
      "",
      "```",
      "spawn_background_terminal -> owner: agent, visible: false",
      "promote_terminal -> owner: user, visible: true",
      "kill_terminal -> only if owner: agent and visible: false",
      "```",
    ].join("\n"),
  },
  graphite: {
    title: "Graphite (Stack Operations)",
    intro:
      "Graphite tools expose stack operations. Read-only stack inspection is safe; destructive operations require approval.",
    whenToUse: [
      "Inspect current stack state",
      "Continue or abort a restack after resolving conflicts",
    ],
    extraSections: [
      "## Approval Gate",
      "",
      "- graphite_continue and graphite_abort require explicit user approval",
      "- The MCP call waits for approval or timeout",
      "- Approval events are emitted to the UI via the approvals system",
      "",
      "## Requirements",
      "",
      "- Graphite CLI must be installed",
      "- Repository must be initialized with gt init",
    ].join("\n"),
  },
};

const typeForSchema = (schema?: {
  type?: string | string[];
  items?: { type?: string };
}): string => {
  if (!schema?.type) {
    return "unknown";
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }
  if (schema.type === "array") {
    const itemType = schema.items?.type ?? "unknown";
    return `array<${itemType}>`;
  }
  return schema.type;
};

const exampleValueForParam = (name: string, type: string): unknown => {
  switch (name) {
    case "chatId":
      return "chat_123";
    case "projectId":
      return "project_123";
    case "planId":
      return "plan_123";
    case "questionId":
      return "question_123";
    case "taskId":
      return "task_123";
    case "subagentId":
      return "subagent_123";
    case "attemptId":
      return "attempt_123";
    case "terminalId":
      return "pty_123";
    case "cwd":
      return "/path/to/repo";
    case "command":
      return ["npm", "run", "dev"];
    case "count":
      return 3;
    case "limit":
      return 100;
    case "offset":
      return 0;
    case "status":
      return "pending";
    case "approved":
      return true;
    case "all":
    case "force":
      return true;
    default:
      break;
  }

  if (type.startsWith("array<")) {
    return [];
  }
  if (type === "number") {
    return 1;
  }
  if (type === "boolean") {
    return true;
  }
  return "value";
};

const toolParametersTable = (tool: ToolDefinition): string => {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const rows = Object.entries(properties).map(([name, schema]) => {
    const type = typeForSchema(schema);
    const requiredText = required.has(name) ? "Yes" : "No";
    const description = schema.description ?? "";
    return `| ${name} | ${type} | ${requiredText} | ${description} |`;
  });

  if (rows.length === 0) {
    return "No parameters.";
  }

  return [
    "| Name | Type | Required | Description |",
    "|------|------|----------|-------------|",
    ...rows,
  ].join("\n");
};

const toolInputExample = (tool: ToolDefinition): string => {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const entries = Object.keys(properties)
    .filter((name) => required.has(name))
    .map((name) => {
      const schema = properties[name];
      const type = typeForSchema(schema);
      return [name, exampleValueForParam(name, type)] as const;
    });

  const example: Record<string, unknown> = {};
  for (const [name, value] of entries) {
    example[name] = value;
  }

  return JSON.stringify(example, null, 2);
};

const renderToolSection = (tool: ToolDefinition): string => {
  const description = tool.description ?? "";
  const parameters = toolParametersTable(tool);
  const example = toolInputExample(tool);

  return [
    `### ${tool.name}`,
    "",
    description,
    "",
    "**Parameters**",
    parameters,
    "",
    "**Example (input)**",
    "```json",
    example,
    "```",
    "",
    "**Output**",
    "See Response Contract in SKILL.md (content.text is JSON).",
  ].join("\n");
};

const renderReference = (name: string, tools: ToolDefinition[]): string => {
  const template = referenceTemplates[name];
  if (!template) {
    throw new Error(`Missing template for ${name}`);
  }

  const toolSections = tools
    .map((tool) => renderToolSection(tool))
    .join("\n\n");
  const skillName = `forks-mcp:${name}`;
  const description = template.intro.replace(TRAILING_PERIOD_REGEX, "");

  return [
    "---",
    `name: ${skillName}`,
    `description: ${description}`,
    "---",
    "",
    `# ${template.title}`,
    "",
    template.intro,
    "",
    "## When to Use",
    "",
    ...template.whenToUse.map((item) => `- ${item}`),
    "",
    "## Tools",
    "",
    toolSections || "No tools found.",
    "",
    template.extraSections,
    "",
  ].join("\n");
};

const toolNamesList = (tools: ToolDefinition[]): string =>
  tools.map((tool) => `- ${tool.name}`).join("\n");

const generateSkillMd = (): string => {
  const toolCount = allTools.length;
  const categories = [
    ["Attempts", categoryTools.attempts],
    ["Subagents", categoryTools.subagents],
    ["Plans", categoryTools.plans],
    ["Questions", categoryTools.questions],
    ["Tasks", categoryTools.tasks],
    ["Terminals", categoryTools.terminals],
    ["Graphite", categoryTools.graphite],
  ] as const;

  const categoryTable = [
    "| Category | Count |",
    "|----------|-------|",
    ...categories.map(
      ([name, tools]) => `| ${name} | ${tools.length.toString()} |`
    ),
  ].join("\n");

  const quickReference = categories
    .map(
      ([name, tools]) => `### ${name}\n${toolNamesList(tools) || "- (none)"}`
    )
    .join("\n\n");

  return [
    "---",
    "name: forks-mcp",
    "description: Forks MCP tools for orchestration, approvals, questions, tasks, terminals, and Graphite stack operations.",
    "---",
    "",
    "# Forks MCP Tools",
    "",
    `This skill documents the ${toolCount} MCP tools available in forksd.`,
    "",
    "## Tool Categories",
    "",
    categoryTable,
    "",
    "## Quick Reference",
    "",
    quickReference,
    "",
    "## Response Contract",
    "",
    "All MCP tools return a JSON envelope where the real payload is JSON-encoded inside content.text.",
    "Always parse content[0].text to get the payload.",
    "",
    "**Success example (raw MCP response):**",
    "```json",
    "{",
    '  "content": [',
    '    { "type": "text", "text": "{\\"id\\":\\"task_123\\",\\"status\\":\\"pending\\"}" }',
    "  ],",
    '  "isError": false',
    "}",
    "```",
    "",
    "**Parsed payload:**",
    "```json",
    '{ "id": "task_123", "status": "pending" }',
    "```",
    "",
    "**Error example (raw MCP response):**",
    "```json",
    "{",
    '  "content": [',
    '    { "type": "text", "text": "{\\"error\\":{\\"message\\":\\"Not found\\",\\"code\\":\\"not_found\\"}}" }',
    "  ],",
    '  "isError": true',
    "}",
    "```",
    "",
    "**Parsed error:**",
    "```json",
    '{ "error": { "message": "Not found", "code": "not_found" } }',
    "```",
    "",
    "## Error Contract",
    "",
    "- isError is true when the tool fails",
    "- content.text is JSON with an error.message and optional error.code",
    "- Validation errors from MCP may be returned as MCP protocol errors instead of tool output",
    "",
    "## ID Availability",
    "",
    "- chatId: provided by the chat context",
    "- projectId: comes from the workspace/project selection",
    "- planId: returned by plan_propose",
    "- questionId: returned by question_create or question_list",
    "- taskId: returned by task_create or task_list",
    "- subagentId: returned by subagent_spawn or subagent_list",
    "- attemptId: returned by attempt_spawn or attempt_status",
    "- terminalId: returned by list_terminals or spawn_background_terminal",
    "",
    "## Tool Selection Heuristics",
    "",
    "- attempt_* when you are unsure and want multiple options",
    "- subagent_* when you know the task and want parallel execution",
    "- plan_* when changes need approval or are risky",
    "- question_* when blocked by user preference or ambiguity",
    "- task_* to coordinate work across agents",
    "",
    "## Skill Injection Strategy",
    "",
    "- Always load this SKILL.md as the core overview",
    "- Load only the relevant reference docs per task: attempts, subagents, plans, questions, tasks, terminals, graphite",
    "",
    "## Collision Mitigation",
    "",
    "- Call these tools through the forksd MCP server to avoid name collisions",
    "- Prefer the fully qualified server name when multiple MCP servers are configured",
    "",
    "## Examples With IDs",
    "",
    "**Plan approval flow**",
    "1. plan_propose(chatId, title, plan) -> returns planId",
    "2. plan_respond(planId, approved: true)",
    "3. plan_status(planId)",
    "",
    "**Question flow**",
    "1. question_create(chatId, question) -> returns questionId",
    "2. question_respond(questionId, answer)",
    "3. question_status(questionId)",
    "",
    "**Task flow**",
    "1. task_create(chatId, description) -> returns taskId",
    "2. task_claim(taskId)",
    "3. task_complete(taskId, result)",
    "",
    "**Terminal flow**",
    "1. list_terminals() -> returns terminalId",
    "2. read_terminal(terminalId)",
    "",
    "**Graphite approval flow**",
    "1. graphite_continue(chatId, cwd, all?) -> waits for approval",
    "2. graphite_abort(chatId, cwd, force?)",
    "",
    "For details on each tool category, read the reference docs in references/.",
  ].join("\n");
};

const isCheck = process.argv.includes("--check");
let hasMismatch = false;

const writeIfChanged = (path: string, contents: string): void => {
  if (isCheck) {
    const existing = readFileSync(path, "utf-8");
    if (existing !== contents) {
      // eslint-disable-next-line no-console
      console.error(`Doc out of date: ${path}`);
      hasMismatch = true;
    }
    return;
  }

  writeFileSync(path, contents);
};

const main = (): void => {
  const skillMd = generateSkillMd();
  writeIfChanged(join(skillDir, "SKILL.md"), skillMd);

  const references: [string, ToolDefinition[]][] = [
    ["attempts", categoryTools.attempts],
    ["subagents", categoryTools.subagents],
    ["plans", categoryTools.plans],
    ["questions", categoryTools.questions],
    ["tasks", categoryTools.tasks],
    ["terminals", categoryTools.terminals],
    ["graphite", categoryTools.graphite],
  ];

  for (const [name, tools] of references) {
    const contents = renderReference(name, tools);
    writeIfChanged(join(referencesDir, `${name}.md`), contents);
  }

  if (isCheck && hasMismatch) {
    process.exitCode = 1;
  }
};

main();
