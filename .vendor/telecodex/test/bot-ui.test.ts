import { describe, expect, it } from "vitest";

import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "../src/bot-ui.js";

describe("bot-ui", () => {
  describe("renderHelpMessage", () => {
    it("contains the final command surface and no deleted commands", () => {
      const { html, plain } = renderHelpMessage();
      expect(html).toContain("Phone menu");
      expect(html).toContain("Typed entry points");
      for (const command of [
        "/past [n]",
        "/view",
        "/status",
        "/rewind [n]",
        "/skill",
        "/new",
        "/compact",
        "/model",
        "/handback",
        "/help",
        "/start",
        "/switch <thread-id>",
        "/attach <thread-id>",
      ]) {
        expect(plain).toContain(command);
      }
      for (const command of [
        "/auth",
        "/login",
        "/logout",
        "/voice",
        "/retry",
        "/effort",
        "/launch",
        "/launch_profiles",
        "/session",
        "/sessions",
        "/abort",
      ]) {
        expect(plain).not.toContain(command);
      }
      expect(plain).toContain("/past [n]");
      expect(plain).toContain("1-19 unseen desktop messages (default 5)");
    });

    it("lists all 13 final handlers", () => {
      const { plain } = renderHelpMessage();
      const commandMatches = plain.match(/\/\w+/g) ?? [];
      expect(commandMatches.length).toBe(13);
    });

    it("returns valid HTML with bold tags", () => {
      const { html } = renderHelpMessage();
      expect(html).toContain("<b>");
      expect(html).toContain("</b>");
    });
  });

  describe("renderWelcomeFirstTime", () => {
    it("shows welcome without auth warning", () => {
      const { html, plain } = renderWelcomeFirstTime();
      expect(html).toContain("TeleCodex is ready");
      expect(plain).toContain("/help");
      expect(html).not.toContain("⚠️");
      expect(plain).not.toContain("voice");
    });

    it("includes auth warning when provided", () => {
      const { html, plain } = renderWelcomeFirstTime("Not authenticated");
      expect(html).toContain("⚠️");
      expect(plain).toContain("Not authenticated");
    });
  });

  describe("renderWelcomeReturning", () => {
    it("shows session info for returning user", () => {
      const { html, plain } = renderWelcomeReturning(
        "<b>Thread:</b> abc123",
        "Thread: abc123",
        false,
      );
      expect(html).toContain("TeleCodex");
      expect(html).toContain("abc123");
      expect(plain).toContain("abc123");
    });

    it("shows topic label for topic sessions", () => {
      const { html } = renderWelcomeReturning("", "", true);
      expect(html).toContain("topic session");
    });

    it("includes auth warning when provided", () => {
      const { html } = renderWelcomeReturning("", "", false, "Expired");
      expect(html).toContain("⚠️");
      expect(html).toContain("Expired");
    });
  });

  describe("formatSessionLabel", () => {
    it("formats basic session label", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-project",
        title: "fix the login bug",
        relativeTime: "3h ago",
        isActive: false,
      });
      expect(label).toContain("📁");
      expect(label).toContain("my-project");
      expect(label).toContain("fix the login bug");
      expect(label).toContain("3h ago");
    });

    it("shows checkmark for active session", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "now",
        isActive: true,
      });
      expect(label).toContain("✅");
    });

    it("appends model tag when available", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "1m ago",
        model: "gpt-4o",
        isActive: false,
      });
      expect(label).toContain("gpt-4o");
    });

    it("truncates long workspace names to 12 chars", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-very-long-project-name",
        title: "test",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label).toContain("my-very-lon…");
    });

    it("truncates long titles to 20 chars", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "this is an extremely long title that should be truncated",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label.length).toBeLessThan(120);
    });

    it("handles missing title gracefully", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "",
        relativeTime: "5m ago",
        isActive: false,
      });
      expect(label).toContain("(untitled)");
    });

    it("truncates long model names", () => {
      const label = formatSessionLabel({
        workspace: "/p",
        title: "t",
        relativeTime: "1m",
        model: "very-long-model-name-here",
        isActive: false,
      });
      expect(label).toContain("very-long…");
    });
  });
});
