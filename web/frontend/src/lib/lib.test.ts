import { describe, it, expect } from "vitest";
import { humanizeAgentText } from "@/lib/agentText";
import { normalizeAiText } from "@/lib/aiText";
import { courseKey, formatDateTime, plural, previousComparable } from "@/lib/runs";
import type { RunMeta } from "@/api/client";

describe("humanizeAgentText", () => {
  it("hides tool names, run ids and «effort»", () => {
    const out = humanizeAgentText(
      "Прогон 20261010-004436-6b83cb: вызовите query_question_errors и повысьте effort.",
    );
    expect(out).not.toMatch(/query_|20261010|effort/);
    expect(out).toContain("выбранный анализ");
    expect(out).toContain("разбор ошибок по вопросу");
  });
});

describe("normalizeAiText", () => {
  it("unpacks Python-style and JSON lists, leaves prose alone", () => {
    expect(normalizeAiText(`['Первое', "Второе"]`)).toBe("Первое\nВторое");
    expect(normalizeAiText('["a","b"]')).toBe("a\nb");
    expect(normalizeAiText("  Обычный текст.  ")).toBe("Обычный текст.");
    expect(normalizeAiText(null)).toBe("");
  });
});

describe("runs helpers", () => {
  const meta = (id: string, created: string, course: string | null, name = "x", groups: string[] = []) =>
    ({ id, created_at: created, course_id: course, name, groups, model_group: "", mode: "", summary: {} }) as unknown as RunMeta;

  it("plural forms and date format", () => {
    expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, "группа", "группы", "групп"))).toEqual([
      "группа", "группы", "групп", "групп", "группа", "группы",
    ]);
    expect(formatDateTime("2026-10-10 00:44:12")).toBe("10.10.2026 00:44");
  });

  it("previousComparable only returns an earlier run of the same course (same groups preferred)", () => {
    const runs = [
      meta("c", "3", "ЭК 069", "n", ["Группа 1", "Группа 2"]),
      meta("b", "2", "ЭК 112"),
      meta("a2", "1.5", "ЭК 069", "n", ["Группа 1"]),
      meta("a", "1", "ЭК 069", "n", ["Группа 1", "Группа 2"]),
    ];
    expect(previousComparable(runs, "c")?.id).toBe("a");
    expect(previousComparable(runs, "b")).toBeNull();
    expect(courseKey(meta("z", "1", "анализ", "Тест 021 (3 групп).xlsx"))).toBe("n:тест 021");
  });
});
