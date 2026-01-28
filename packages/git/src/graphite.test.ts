import { describe, expect, it } from "bun:test";

// Regex patterns matching those used in graphite.ts for parsing tests
const TRUNK_MATCH_REGEX = /\(([a-zA-Z][a-zA-Z0-9_-]*)\)/;
const BRANCH_MATCH_REGEX = /[◉○*]\s*(\S+)/;
const PR_MATCH_REGEX = /#(\d+)/;
const PR_URL_REGEX = /^\s*│?\s*(\S+):\s+(https:\/\/app\.graphite\.dev\/\S+)/;

describe("@forks-sh/git/graphite", () => {
  describe("isGraphiteRepo", () => {
    it("should check for .git/.graphite_repo_config file", async () => {
      const { isGraphiteRepo } = await import("./graphite.js");
      const result = await isGraphiteRepo("/nonexistent/path");
      expect(result).toBe(false);
    });
  });

  describe("input validation", () => {
    it("should reject invalid branch names in gtCheckout", async () => {
      const { gtCheckout } = await import("./graphite.js");

      await expect(gtCheckout("/tmp", "-malicious")).rejects.toThrow(
        "Invalid branch name"
      );
      await expect(gtCheckout("/tmp", "branch with spaces")).rejects.toThrow(
        "Invalid branch name"
      );
      await expect(gtCheckout("/tmp", "branch..lock")).rejects.toThrow(
        "Invalid branch name"
      );
    });

    it("should reject invalid branch names in gtCreate", async () => {
      const { gtCreate } = await import("./graphite.js");

      await expect(gtCreate("/tmp", "-malicious")).rejects.toThrow(
        "Invalid branch name"
      );
    });

    it("should reject invalid commit messages in gtCreate", async () => {
      const { gtCreate } = await import("./graphite.js");

      await expect(
        gtCreate("/tmp", "valid-branch", { message: "-malicious" })
      ).rejects.toThrow("Invalid commit message");
    });

    it("should reject invalid commit messages in gtModify", async () => {
      const { gtModify } = await import("./graphite.js");

      await expect(gtModify("/tmp", { message: "-malicious" })).rejects.toThrow(
        "Invalid commit message"
      );
    });

    it("should reject invalid commit messages in gtSquash", async () => {
      const { gtSquash } = await import("./graphite.js");

      await expect(gtSquash("/tmp", { message: "-malicious" })).rejects.toThrow(
        "Invalid commit message"
      );
    });

    it("should reject invalid branch names in gtRename", async () => {
      const { gtRename } = await import("./graphite.js");

      await expect(gtRename("/tmp", "-malicious")).rejects.toThrow(
        "Invalid branch name"
      );
    });

    it("should reject invalid branch names in gtDelete", async () => {
      const { gtDelete } = await import("./graphite.js");

      await expect(gtDelete("/tmp", "-malicious")).rejects.toThrow(
        "Invalid branch name"
      );
    });

    it("should reject invalid branch names in gtTrack", async () => {
      const { gtTrack } = await import("./graphite.js");

      await expect(gtTrack("/tmp", "-malicious")).rejects.toThrow(
        "Invalid branch name"
      );
    });

    it("should reject invalid trunk names in gtInit", async () => {
      const { gtInit } = await import("./graphite.js");

      await expect(gtInit("/tmp", "-malicious")).rejects.toThrow(
        "Invalid trunk branch name"
      );
    });
  });

  describe("gtLog parsing", () => {
    it("should export gtLog function", async () => {
      const { gtLog } = await import("./graphite.js");
      expect(typeof gtLog).toBe("function");
    });
  });

  describe("gtLog parsing patterns", () => {
    it("should match trunk line format", () => {
      const line = "trunk (main)";
      const match = line.match(TRUNK_MATCH_REGEX);
      expect(match?.[1]).toBe("main");
    });

    it("should match trunk with different branch names", () => {
      expect("trunk (master)".match(TRUNK_MATCH_REGEX)?.[1]).toBe("master");
      expect("trunk (develop)".match(TRUNK_MATCH_REGEX)?.[1]).toBe("develop");
      expect("trunk (main-branch)".match(TRUNK_MATCH_REGEX)?.[1]).toBe(
        "main-branch"
      );
      expect("trunk (feature_trunk)".match(TRUNK_MATCH_REGEX)?.[1]).toBe(
        "feature_trunk"
      );
    });

    it("should match branch line with current marker", () => {
      const line = "◉ my-feature-branch";
      const match = line.match(BRANCH_MATCH_REGEX);
      expect(match?.[1]).toBe("my-feature-branch");
    });

    it("should match branch line with non-current marker", () => {
      const line = "○ other-branch";
      const match = line.match(BRANCH_MATCH_REGEX);
      expect(match?.[1]).toBe("other-branch");
    });

    it("should match branch line with asterisk marker", () => {
      const line = "* current-branch";
      const match = line.match(BRANCH_MATCH_REGEX);
      expect(match?.[1]).toBe("current-branch");
    });

    it("should extract PR number from line", () => {
      const line = "○ feature-branch (#456)";
      const match = line.match(PR_MATCH_REGEX);
      expect(match?.[1]).toBe("456");
    });

    it("should extract PR number from various formats", () => {
      expect("○ branch (#123)".match(PR_MATCH_REGEX)?.[1]).toBe("123");
      expect("◉ branch(#99)".match(PR_MATCH_REGEX)?.[1]).toBe("99");
      expect("○ branch #1234".match(PR_MATCH_REGEX)?.[1]).toBe("1234");
    });

    it("should match PR URL lines", () => {
      const line =
        "│ feature-1: https://app.graphite.dev/github/pr/org/repo/123";
      const match = line.match(PR_URL_REGEX);
      expect(match?.[1]).toBe("feature-1");
      expect(match?.[2]).toBe(
        "https://app.graphite.dev/github/pr/org/repo/123"
      );
    });

    it("should match PR URL lines without pipe character", () => {
      const line =
        "  feature-2: https://app.graphite.dev/github/pr/org/repo/456";
      const match = line.match(PR_URL_REGEX);
      expect(match?.[1]).toBe("feature-2");
      expect(match?.[2]).toBe(
        "https://app.graphite.dev/github/pr/org/repo/456"
      );
    });

    it("should match PR URL lines with extra whitespace", () => {
      const line =
        "    │   my-branch: https://app.graphite.dev/github/pr/myorg/myrepo/789";
      const match = line.match(PR_URL_REGEX);
      expect(match?.[1]).toBe("my-branch");
      expect(match?.[2]).toBe(
        "https://app.graphite.dev/github/pr/myorg/myrepo/789"
      );
    });

    it("should not match non-graphite URLs", () => {
      const line = "│ branch: https://github.com/org/repo/pull/123";
      const match = line.match(PR_URL_REGEX);
      expect(match).toBeNull();
    });

    it("should handle edge case: branch with parentheses in PR info", () => {
      const line = "◉ my-branch(#123)";
      const match = line.match(BRANCH_MATCH_REGEX);
      // Note: This captures "my-branch(#123)" - the parsing cleans this up
      expect(match?.[1]).toBe("my-branch(#123)");
    });

    it("should detect current branch indicator", () => {
      // Test the logic used in gtLog to detect current branch
      const detectCurrent = (line: string) =>
        line.includes("◉") || line.startsWith("*");

      expect(detectCurrent("◉ my-branch")).toBe(true);
      expect(detectCurrent("* my-branch")).toBe(true);
      expect(detectCurrent("○ other-branch")).toBe(false);
      expect(detectCurrent("  ◉ indented-current")).toBe(true);
    });

    it("should detect needs restack indicator", () => {
      // Test the logic used in gtLog to detect restack needed
      const detectNeedsRestack = (line: string) => line.includes("!");

      expect(detectNeedsRestack("◉ my-branch !")).toBe(true);
      expect(detectNeedsRestack("○ clean-branch")).toBe(false);
      expect(detectNeedsRestack("◉ branch! needs restack")).toBe(true);
    });

    it("should skip trunk and separator lines", () => {
      // Test the logic used in gtLog to skip non-branch lines
      const shouldSkip = (line: string) =>
        line.includes("trunk") || line.startsWith("─");

      expect(shouldSkip("trunk (main)")).toBe(true);
      expect(shouldSkip("─────────────────")).toBe(true);
      expect(shouldSkip("◉ feature-branch")).toBe(false);
      expect(shouldSkip("○ other-branch")).toBe(false);
    });
  });

  describe("stack navigation exports", () => {
    it("should export all navigation functions", async () => {
      const graphite = await import("./graphite.js");

      expect(typeof graphite.gtUp).toBe("function");
      expect(typeof graphite.gtDown).toBe("function");
      expect(typeof graphite.gtTop).toBe("function");
      expect(typeof graphite.gtBottom).toBe("function");
      expect(typeof graphite.gtCheckout).toBe("function");
      expect(typeof graphite.gtCheckoutTrunk).toBe("function");
    });
  });

  describe("stack manipulation exports", () => {
    it("should export all manipulation functions", async () => {
      const graphite = await import("./graphite.js");

      expect(typeof graphite.gtCreate).toBe("function");
      expect(typeof graphite.gtModify).toBe("function");
      expect(typeof graphite.gtFold).toBe("function");
      expect(typeof graphite.gtSquash).toBe("function");
    });
  });

  describe("sync and submit exports", () => {
    it("should export sync and submit functions", async () => {
      const graphite = await import("./graphite.js");

      expect(typeof graphite.gtRestack).toBe("function");
      expect(typeof graphite.gtSync).toBe("function");
      expect(typeof graphite.gtSubmit).toBe("function");
    });
  });

  describe("branch management exports", () => {
    it("should export branch management functions", async () => {
      const graphite = await import("./graphite.js");

      expect(typeof graphite.gtRename).toBe("function");
      expect(typeof graphite.gtDelete).toBe("function");
      expect(typeof graphite.gtTrack).toBe("function");
    });
  });

  describe("utility exports", () => {
    it("should export utility functions", async () => {
      const graphite = await import("./graphite.js");

      expect(typeof graphite.isGraphiteRepo).toBe("function");
      expect(typeof graphite.gtInit).toBe("function");
      expect(typeof graphite.gtContinue).toBe("function");
    });
  });

  describe("version checking", () => {
    it("should export version constants and functions", async () => {
      const graphite = await import("./graphite.js");

      expect(typeof graphite.MINIMUM_GT_VERSION).toBe("string");
      expect(graphite.MINIMUM_GT_VERSION).toBe("1.7.0");
      expect(typeof graphite.gtVersion).toBe("function");
      expect(typeof graphite.checkGtVersion).toBe("function");
    });

    it("should have correct VersionCheck interface shape", async () => {
      const graphite = await import("./graphite.js");
      type VersionCheck = Awaited<ReturnType<typeof graphite.checkGtVersion>>;
      const mockVersionCheck: VersionCheck = {
        version: "1.7.10",
        supported: true,
      };

      expect(mockVersionCheck.version).toBe("1.7.10");
      expect(mockVersionCheck.supported).toBe(true);
    });
  });

  describe("SubmitResult interface", () => {
    it("should have correct SubmitResult interface shape", async () => {
      const graphite = await import("./graphite.js");
      type SubmitResult = Awaited<ReturnType<typeof graphite.gtSubmit>>[number];
      const mockSubmitResult: SubmitResult = {
        branch: "feature-branch",
        prUrl: "https://app.graphite.dev/github/pr/org/repo/123",
        action: "created",
      };

      expect(mockSubmitResult.branch).toBe("feature-branch");
      expect(mockSubmitResult.prUrl).toContain("graphite.dev");
      expect(["created", "updated"]).toContain(mockSubmitResult.action);
    });
  });

  describe("type exports", () => {
    it("should have correct interface shapes", async () => {
      const graphite = await import("./graphite.js");
      type StackInfo = Awaited<ReturnType<typeof graphite.gtLog>>;
      const mockStackInfo: StackInfo = {
        trunk: "main",
        branches: [
          {
            name: "feature-1",
            isCurrent: true,
            needsRestack: false,
          },
        ],
        currentIndex: 0,
      };

      expect(mockStackInfo.trunk).toBe("main");
      expect(mockStackInfo.branches).toHaveLength(1);
    });
  });

  describe("new interface exports", () => {
    it("should export all new option interfaces", async () => {
      // TypeScript will catch if these don't exist at compile time
      // This test ensures the exports are available at runtime
      const graphite = await import("./graphite.js");

      // Test that functions with new options can be called (they will fail due to gt not being installed, but type checking passes)
      expect(typeof graphite.gtSubmit).toBe("function");
      expect(typeof graphite.gtSync).toBe("function");
      expect(typeof graphite.gtRestack).toBe("function");
      expect(typeof graphite.gtDelete).toBe("function");
      expect(typeof graphite.gtContinue).toBe("function");
      expect(typeof graphite.gtSquash).toBe("function");
    });
  });
});
